import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { createPagesProxy } from "./worker.ts";

const ORIGIN = "https://proxy.pages.dev";
const RAW = "/__github__/raw.githubusercontent.com/owner/repo/main/file";

test("Pages 普通下载保留浏览器缓存及 ETag，不缓存代理响应或污染源站缓存键", async () => {
  const proxy = createPagesProxy((target, init) => {
    equal(target.hostname, "raw.githubusercontent.com");
    equal(init.cache, undefined);
    equal(new Headers(init.headers).get("x-github-proxy-web"), null);
    return Promise.resolve(
      new Response("file", {
        headers: { "cache-control": "public, max-age=300", "etag": '"original"' },
      }),
    );
  });
  const response = await proxy(new Request(ORIGIN + RAW));
  equal(response.headers.get("cache-control"), "public, max-age=300");
  equal(response.headers.get("etag"), '"original"');
  equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  equal(response.headers.get("cdn-cache-control"), "no-store");
  equal(response.headers.get("deno-cdn-cache-control"), null);
  equal(await response.text(), "file");
});

test("Pages 条件请求、Range、HEAD、认证和 Git POST 绕过 Cloudflare 上游缓存", async () => {
  for (
    const [method, headers, status] of [
      ["GET", { "if-none-match": '"v1"' }, 304],
      ["GET", { "if-match": '"old"' }, 412],
      ["GET", { "range": "bytes=0-3" }, 206],
      ["HEAD", {}, 200],
      ["GET", { "authorization": "Bearer test" }, 200],
      ["POST", { "content-type": "application/x-git-upload-pack-request" }, 200],
    ] as const
  ) {
    const path = method === "POST"
      ? "/owner/repo.git/git-upload-pack"
      : "/owner/repo/raw/main/file";
    const proxy = createPagesProxy((_target, init) => {
      equal(init.cache, "no-store");
      equal(init.method, method);
      return Promise.resolve(
        new Response(status === 304 || method === "HEAD" ? null : "body", {
          status,
        }),
      );
    });
    const response = await proxy(
      new Request(ORIGIN + path, {
        method,
        headers,
        body: method === "POST" ? "0000" : undefined,
      }),
    );
    equal(response.status, status);
    await response.arrayBuffer();
  }
});

test("Pages 二进制流保留 Content-Encoding，避免压缩下载文件损坏", async () => {
  const bytes = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x80]);
  const proxy = createPagesProxy(() =>
    Promise.resolve(
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" },
      }),
    )
  );
  const response = await proxy(new Request(ORIGIN + RAW));
  equal(response.headers.get("content-encoding"), "gzip");
  deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("Pages 改写 HTML 后移除旧编码，设置同源 CSP 和 Cloudflare 缓存策略", async () => {
  const proxy = createPagesProxy(() =>
    Promise.resolve(
      new Response(
        '<!doctype html><html><head></head><body><img src="https://avatars.githubusercontent.com/u/1"></body></html>',
        { headers: { "content-type": "text/html", "content-encoding": "gzip", "etag": '"old"' } },
      ),
    )
  );
  const response = await proxy(
    new Request(ORIGIN + "/owner/repo", {
      headers: { "accept": "text/html" },
    }),
  );
  equal(response.headers.get("content-encoding"), null);
  equal(response.headers.get("etag"), null);
  equal(response.headers.get("cache-control"), "no-store");
  equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  equal(response.headers.get("deno-cdn-cache-control"), null);
  ok(response.headers.get("content-security-policy")?.includes("connect-src 'self'"));
  ok((await response.text()).includes(ORIGIN + "/__github__/avatars.githubusercontent.com/u/1"));
});

test("Pages 改写资源的代理 ETag 可在条件请求中返回 304", async () => {
  const proxy = createPagesProxy((_target, init) => {
    equal(new Headers(init.headers).get("if-none-match"), null);
    return Promise.resolve(
      new Response('const url="https://github.com/owner/repo";', {
        headers: { "content-type": "text/javascript" },
      }),
    );
  });
  const url = ORIGIN + "/__github__/github.githubassets.com/assets/app.js";
  const first = await proxy(new Request(url));
  const etag = first.headers.get("etag")!;
  await first.text();
  const second = await proxy(new Request(url, { headers: { "if-none-match": etag } }));
  equal(second.status, 304);
  equal(second.body, null);
  equal(second.headers.get("etag"), etag);
  equal(second.headers.get("cloudflare-cdn-cache-control"), "no-store");
});
