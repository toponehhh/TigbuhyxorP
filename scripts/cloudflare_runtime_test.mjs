import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { Miniflare } from "miniflare";

const html =
  '<!doctype html><html><head></head><body><img src="https://avatars.githubusercontent.com/u/1"><include-fragment src="https://github.com/owner/repo/releases/expanded_assets/v1"></include-fragment></body></html>';
const binary = new Uint8Array([0, 255, 1, 128, 42, 10]);
const htmlGzip = [...gzipSync(html)];
const binaryGzip = [...gzipSync(binary)];
const fixture = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/compressed.bin")) return new Response(new Uint8Array(${
  JSON.stringify(binaryGzip)
}), {
      headers: {"content-type":"application/octet-stream", "content-encoding":"gzip"}, encodeBody:"manual"
    });
    if (path === "/owner/repo") return new Response(new Uint8Array(${JSON.stringify(htmlGzip)}), {
      headers: {"content-type":"text/html", "content-encoding":"gzip", "etag":"old"}, encodeBody:"manual"
    });
    if (path.endsWith("/large.bin")) {
      let remaining = 640;
      const chunk = new Uint8Array(256 * 1024).fill(90);
      return new Response(new ReadableStream({pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk);
        else controller.close();
      }}), {headers:{"content-type":"application/octet-stream"}});
    }
    if (path.endsWith("/git-upload-pack")) return new Response(await request.arrayBuffer(), {
      headers: {"content-type":"application/x-git-upload-pack-result"}
    });
    if (path.includes("/releases/download/")) return new Response(null, {
      status:302, headers:{location:"https://release-assets.githubusercontent.com/fixture/asset.bin?token=example"}
    });
    if (path.endsWith("/app.js")) return new Response('const url="https://github.com/owner/repo";', {
      headers:{"content-type":"text/javascript","etag":"upstream-script"}
    });
    const headers = {"content-type":"application/octet-stream","etag":'"source-v1"',"cache-control":"public, max-age=300","content-length":"8"};
    if (request.headers.get("if-none-match") === '"source-v1"') return new Response(null,{status:304,headers});
    if (request.headers.get("range") === "bytes=0-2") return new Response("raw",{
      status:206,headers:{...headers,"content-range":"bytes 0-2/8"}
    });
    return new Response(request.method === "HEAD" ? null : "raw-data",{headers});
  }
};`;

let runtime;
let origin;
before(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "proxy",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: await readFile(new URL("../dist/_worker.js", import.meta.url), "utf8"),
              },
            },
          },
        },
        dev: { outboundService: { type: "worker", worker: "upstream-fixture" } },
      },
      {
        config: {
          name: "upstream-fixture",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "fixture.js",
            modules: { "fixture.js": { type: "esm", contents: fixture } },
          },
        },
      },
    ],
  });
  origin = (await runtime.ready).origin;
});
after(async () => {
  await runtime?.dispose();
});

test("workerd: raw、HEAD、ETag 304 和 Range 206", async () => {
  const url = origin + "/__github__/raw.githubusercontent.com/owner/repo/main/file";
  const first = await fetch(url);
  assert.equal(await first.text(), "raw-data");
  assert.equal(first.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(first.headers.get("cache-control"), "public, max-age=300");
  const conditional = await fetch(url, { headers: { "if-none-match": '"source-v1"' } });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "8");
  assert.equal(await head.text(), "");
  const range = await fetch(url, { headers: { "range": "bytes=0-2" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 0-2/8");
  assert.equal(await range.text(), "raw");
});

test("workerd: 压缩二进制响应不会丢失编码或重复压缩", async () => {
  const response = await fetch(
    origin + "/__github__/raw.githubusercontent.com/owner/repo/main/compressed.bin",
  );
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
});

test("workerd: 压缩 HTML 解压后改写并移除原来的编码和 ETag", async () => {
  const response = await fetch(origin + "/owner/repo", {
    headers: { "accept": "text/html", "accept-encoding": "identity" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("etag"), null);
  const body = await response.text();
  assert.ok(body.includes(origin + "/__github__/avatars.githubusercontent.com/u/1"));
  assert.ok(body.includes(origin + "/__proxy__/browser.js"));
  assert.ok(response.headers.get("content-security-policy").includes("connect-src 'self'"));
});

test("workerd: Release 跳转保留代理来源及查询参数", async () => {
  const response = await fetch(origin + "/owner/repo/releases/download/v1/file", {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    origin + "/__github__/release-assets.githubusercontent.com/fixture/asset.bin?token=example",
  );
  await response.body?.cancel();
});

test("workerd: 脚本代理 ETag、304 和 HEAD 一致", async () => {
  const url = origin + "/__github__/github.githubassets.com/assets/app.js";
  const first = await fetch(url, { headers: { "accept-encoding": "identity" } });
  const body = await first.text();
  assert.ok(body.includes(origin + "/owner/repo"));
  const etag = first.headers.get("etag");
  const conditional = await fetch(url, { headers: { "if-none-match": etag } });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("content-length"), String(new TextEncoder().encode(body).length));
  assert.equal(await head.text(), "");
});

test("workerd: Git upload-pack POST 转发原始二进制请求体", async () => {
  const response = await fetch(origin + "/owner/repo.git/git-upload-pack", {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
    },
    body: binary,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
});

test("workerd: 160 MiB 附件流式传输，超过单个 Worker 的 128 MiB 内存额度", async () => {
  const response = await fetch(
    origin + "/__github__/raw.githubusercontent.com/owner/repo/main/large.bin",
  );
  assert.equal(response.status, 200);
  let received = 0;
  for await (const bytes of response.body) {
    received += bytes.length;
    assert.equal(bytes[0], 90);
    assert.equal(bytes[bytes.length - 1], 90);
  }
  assert.equal(received, 160 * 1024 * 1024);
});
