import { equal, ok } from "node:assert/strict";
import { createProxy } from "./main.ts";
import { rewriteAbsoluteUrls, rewriteUrl } from "./proxy_urls.ts";
import { rewriteCss, rewriteHtml } from "./web_proxy.ts";

const ORIGIN = "https://proxy.example";
const PAGE = new URL("https://github.com/intel/AI-Playground/releases/tag/v3.2.1-beta");

Deno.test("浏览器保留 blob 文件查看页，命令行继续下载 raw", async () => {
  for (const browser of [false, true]) {
    const proxy = createProxy({
      fetcher: (target) => {
        equal(
          target.pathname,
          browser ? "/owner/repo/blob/main/file" : "/owner/repo/raw/main/file",
        );
        return Promise.resolve(new Response("file"));
      },
    });
    const response = await proxy(
      new Request(`${ORIGIN}/owner/repo/blob/main/file`, {
        headers: browser ? { "accept": "text/html" } : {},
      }),
    );
    equal(await response.text(), "file");
  }
});

Deno.test("静态资源路由转发到受限 CDN，保留浏览接口头但不泄露 Cookie", async () => {
  const proxy = createProxy({
    fetcher: (target, init) => {
      equal(target.href, "https://github.githubassets.com/assets/site.css");
      const headers = new Headers(init.headers);
      equal(headers.get("github-verified-fetch"), "true");
      equal(headers.get("x-requested-with"), "XMLHttpRequest");
      equal(headers.get("cookie"), null);
      equal(headers.get("authorization"), null);
      return Promise.resolve(new Response("css", { headers: { "content-type": "text/plain" } }));
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/__github__/github.githubassets.com/assets/site.css`, {
      headers: {
        "github-verified-fetch": "true",
        "x-requested-with": "XMLHttpRequest",
        "cookie": "a=b",
        "authorization": "Basic test",
      },
    }),
  );
  equal(await response.text(), "css");
});

Deno.test("Release HTML、JSON、图片与 CSP 统一使用代理同源，脚本先于站点脚本执行", async () => {
  const source = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://github.githubassets.com/assets/site.css" integrity="old">
    <script src="https://github.githubassets.com/assets/site.js" integrity="old"></script>
    <script type="application/json">{"url":"https://github.com/intel/AI-Playground"}</script>
    </head><body><include-fragment src="https://github.com/intel/AI-Playground/releases/expanded_assets/v3.2.1-beta"></include-fragment>
    <img src="https://raw.githubusercontent.com/intel/AI-Playground/main/hero.png">
    <a href="/intel/AI-Playground/releases/download/v3.2.1-beta/setup.exe">Download</a></body></html>`;
  const proxy = createProxy({
    fetcher: () =>
      Promise.resolve(
        new Response(source, {
          headers: {
            "content-type": "text/html",
            "content-security-policy": "connect-src 'self'",
            "etag": '"github-etag"',
            "content-length": "999",
          },
        }),
      ),
  });
  const response = await proxy(
    new Request(ORIGIN + PAGE.pathname, { headers: { "accept": "text/html" } }),
  );
  const body = await response.text();
  ok(body.includes(`${ORIGIN}/intel/AI-Playground/releases/expanded_assets/v3.2.1-beta`));
  ok(body.includes(`${ORIGIN}/__github__/github.githubassets.com/assets/site.css`));
  ok(
    body.includes(
      `${ORIGIN}/__github__/raw.githubusercontent.com/intel/AI-Playground/main/hero.png`,
    ),
  );
  ok(body.indexOf("/__proxy__/browser.js") < body.indexOf("/assets/site.js"));
  ok(!body.includes("integrity="));
  equal(response.headers.get("etag"), null);
  equal(response.headers.get("cache-control"), "no-store");
  equal(response.headers.get("deno-cdn-cache-control"), "no-store");
  equal(response.headers.get("content-length"), String(new TextEncoder().encode(body).length));
  ok(response.headers.get("content-security-policy")?.includes("connect-src 'self'"));
  const nonce = body.match(/nonce="([^"]+)"/)?.[1];
  ok(nonce && response.headers.get("content-security-policy")?.includes(`'nonce-${nonce}'`));
});

Deno.test("懒加载附件片段和 template 内资源改写，不重复注入浏览脚本", () => {
  const result = rewriteHtml(
    `<div><template><img src="https://avatars.githubusercontent.com/u/1"></template><a href="/owner/repo/releases/download/v1/a.zip">file</a></div>`,
    PAGE,
    new URL(ORIGIN),
    "nonce",
  );
  equal(result.fullDocument, false);
  ok(result.body.includes(`${ORIGIN}/__github__/avatars.githubusercontent.com/u/1`));
  ok(!result.body.includes("/__proxy__/browser.js"));
});

Deno.test("仓库内 AJAX 跳转的 JSON 所含 HTML 图片地址也改写", async () => {
  const proxy = createProxy({
    fetcher: (_target, init) => {
      equal(new Headers(init.headers).get("if-none-match"), null);
      return Promise.resolve(Response.json({
        html: '<img src="https://camo.githubusercontent.com/badge/image">',
        path: "https://github.com/owner/repo/blob/main/readme.md",
      }));
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/owner/repo/blob/main/readme.md`, {
      headers: {
        "accept": "application/json",
        "x-github-proxy-web": "1",
        "if-none-match": '"old"',
      },
    }),
  );
  const body = await response.json();
  equal(body.html, `<img src="${ORIGIN}/__github__/camo.githubusercontent.com/badge/image">`);
  equal(body.path, `${ORIGIN}/owner/repo/blob/main/readme.md`);
});

Deno.test("CSS 相对字体、根路径、import 和图片保持正确 CDN 上游", () => {
  const target = new URL("https://github.githubassets.com/assets/site.css");
  const result = rewriteCss(
    `@import "./other.css"; a{src:url(../fonts/a.woff2);background:url('/assets/a.png')} b{background:url(data:image/png;base64,abc)}`,
    target,
    new URL(ORIGIN),
  );
  ok(result.includes(`${ORIGIN}/__github__/github.githubassets.com/assets/other.css`));
  ok(result.includes(`${ORIGIN}/__github__/github.githubassets.com/fonts/a.woff2`));
  ok(result.includes(`${ORIGIN}/__github__/github.githubassets.com/assets/a.png`));
  ok(result.includes("url(data:image/png;base64,abc)"));
});

Deno.test("JS/JSON 地址改写保留转义、模板变量和未知主机", () => {
  const source = String
    .raw`const a="https:\/\/github.com\/owner\/repo";const b=\`https://api.github.com/repos/\${owner}\`;const c="https://github.com.evil.example/x";`;
  const rewritten = rewriteAbsoluteUrls(source, PAGE, new URL(ORIGIN));
  ok(rewritten.includes(String.raw`https:\/\/proxy.example\/owner\/repo`));
  ok(rewritten.includes("/__github__/api.github.com/repos/\\${owner}"));
  ok(rewritten.includes("https://github.com.evil.example/x"));
  equal(
    rewriteUrl("https://github.com:8443/a", PAGE, new URL(ORIGIN)),
    "https://github.com:8443/a",
  );
  equal(
    rewriteUrl("https://user:password@github.com/a", PAGE, new URL(ORIGIN)),
    "https://user:password@github.com/a",
  );
});

Deno.test("改写脚本使用代理自身 ETag，并在匹配时返回 304 零正文", async () => {
  const proxy = createProxy({
    fetcher: (_target, init) => {
      equal(new Headers(init.headers).get("if-none-match"), null);
      return Promise.resolve(
        new Response('export const url="https://github.com/owner/repo";', {
          headers: {
            "content-type": "text/javascript",
            "etag": '"github-etag"',
            "cache-control": "public, max-age=300",
          },
        }),
      );
    },
  });
  const url = `${ORIGIN}/__github__/github.githubassets.com/assets/a.js`;
  const first = await proxy(new Request(url));
  const tag = first.headers.get("etag");
  ok(tag?.startsWith('W/"proxy-'));
  ok((await first.text()).includes(`${ORIGIN}/owner/repo`));
  const second = await proxy(new Request(url, { headers: { "if-none-match": tag! } }));
  equal(second.status, 304);
  equal(second.body, null);
  equal(second.headers.get("etag"), tag);
  equal(second.headers.get("deno-cdn-cache-control"), "no-store");
});

Deno.test("浏览器代理脚本可访问，但网页 POST 和未知资源主机仍拒绝", async () => {
  const proxy = createProxy({
    fetcher: () => {
      throw new Error("should not fetch");
    },
  });
  const script = await proxy(new Request(`${ORIGIN}/__proxy__/browser.js`));
  equal(script.status, 200);
  ok((await script.text()).includes("XMLHttpRequest.prototype.open"));
  const write = await proxy(new Request(`${ORIGIN}/owner/repo/issues`, { method: "POST" }));
  equal(write.status, 405);
  await write.text();
  const unknown = await proxy(
    new Request(`${ORIGIN}/__github__/github.githubassets.com.evil.example/a.js`),
  );
  equal(unknown.status, 403);
  await unknown.text();
});

Deno.test("原始文件和 Release 附件保持原始 HTML/JS/JSON 字节与验证器", async () => {
  for (
    const path of [
      "/__github__/raw.githubusercontent.com/owner/repo/main/a.html",
      "/owner/repo/raw/main/a.js",
      "/owner/repo/releases/download/v1/a.json",
    ]
  ) {
    const body = '<script>const url="https://github.com/owner/repo";</script>';
    const proxy = createProxy({
      fetcher: (_target, init) => {
        equal(new Headers(init.headers).get("if-none-match"), '"original"');
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/html", "etag": '"original"' },
          }),
        );
      },
    });
    const response = await proxy(
      new Request(ORIGIN + path, {
        headers: { "accept": "text/html", "if-none-match": '"original"' },
      }),
    );
    equal(await response.text(), body);
    equal(response.headers.get("etag"), '"original"');
  }
});

Deno.test("改写资源 HEAD 与 GET 的长度和 ETag 一致，弱 ETag 不满足 If-Match", async () => {
  const proxy = createProxy({
    fetcher: (_target, init) => {
      equal(init.method, "GET");
      equal(new Headers(init.headers).get("if-match"), null);
      return Promise.resolve(
        new Response('const url="https://github.com/owner/repo";', {
          headers: { "content-type": "text/javascript" },
        }),
      );
    },
  });
  const url = `${ORIGIN}/__github__/github.githubassets.com/assets/head.js`;
  const get = await proxy(new Request(url));
  const tag = get.headers.get("etag");
  const length = get.headers.get("content-length");
  await get.text();
  const head = await proxy(new Request(url, { method: "HEAD" }));
  equal(head.headers.get("etag"), tag);
  equal(head.headers.get("content-length"), length);
  equal(head.body, null);
  const failed = await proxy(new Request(url, { headers: { "if-match": tag! } }));
  equal(failed.status, 412);
  equal(failed.body, null);
});
