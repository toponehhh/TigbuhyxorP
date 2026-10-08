import { deepEqual, equal, ok } from "node:assert/strict";
import { createProxy } from "./main.ts";

const ORIGIN = "https://proxy.example";

Deno.test("下载路径、编码和查询参数保持不变", async () => {
  const path = "/owner/repo/releases/download/v1/a%20b.zip?download=1&key=a%2Fb";
  const proxy = createProxy({
    fetcher: (target, init) => {
      equal(target.href, `https://github.com${path}`);
      equal(init.method, "GET");
      equal(init.redirect, "manual");
      equal(new Headers(init.headers).get("accept-encoding"), "identity");
      return Promise.resolve(new Response("file"));
    },
  });
  equal(await (await proxy(new Request(`${ORIGIN}${path}`))).text(), "file");
});

Deno.test("blob 链接转换为 raw，保留含斜杠的分支路径", async () => {
  const proxy = createProxy({
    fetcher: (target) => {
      equal(target.href, "https://github.com/owner/repo/raw/feature/next/a%23b.ts?raw=true");
      return Promise.resolve(new Response("source"));
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/owner/repo/blob/feature/next/a%23b.ts?raw=true`),
  );
  equal(await response.text(), "source");
});

Deno.test("Git upload-pack POST 保留请求流、协议头和压缩二进制字节", async () => {
  const body = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x80]);
  const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff]);
  const request = new Request(`${ORIGIN}/owner/repo.git/git-upload-pack`, {
    method: "POST",
    headers: {
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      "content-encoding": "gzip",
      "content-length": String(body.length),
      "user-agent": "git/2.45.2",
    },
    body,
  });
  const proxy = createProxy({
    fetcher: async (target, init) => {
      equal(target.href, "https://github.com/owner/repo.git/git-upload-pack");
      equal(init.method, "POST");
      equal(init.body, request.body);
      const headers = new Headers(init.headers);
      equal(headers.get("git-protocol"), "version=2");
      equal(headers.get("content-type"), "application/x-git-upload-pack-request");
      equal(headers.get("content-encoding"), "gzip");
      equal(headers.get("content-length"), String(body.length));
      deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), body);
      return new Response(pack, {
        headers: {
          "content-type": "application/x-git-upload-pack-result",
          "cache-control": "no-cache",
        },
      });
    },
  });
  const response = await proxy(request);
  equal(response.headers.get("content-type"), "application/x-git-upload-pack-result");
  equal(response.headers.get("cache-control"), "no-cache");
  deepEqual(new Uint8Array(await response.arrayBuffer()), pack);
});

Deno.test("Range、条件请求头、206 和文件名原样转发", async () => {
  const proxy = createProxy({
    fetcher: (_target, init) => {
      const headers = new Headers(init.headers);
      equal(headers.get("range"), "bytes=10-15");
      equal(headers.get("if-range"), '"revision"');
      equal(headers.get("if-none-match"), '"old"');
      return Promise.resolve(
        new Response("abcdef", {
          status: 206,
          headers: {
            "content-range": "bytes 10-15/100",
            "content-length": "6",
            "accept-ranges": "bytes",
            "etag": '"revision"',
            "content-disposition": 'attachment; filename="file.zip"',
          },
        }),
      );
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/owner/repo/releases/download/v1/file.zip`, {
      headers: { "range": "bytes=10-15", "if-range": '"revision"', "if-none-match": '"old"' },
    }),
  );
  equal(response.status, 206);
  equal(response.headers.get("content-range"), "bytes 10-15/100");
  equal(response.headers.get("content-length"), "6");
  equal(response.headers.get("etag"), '"revision"');
  equal(response.headers.get("content-disposition"), 'attachment; filename="file.zip"');
  equal(await response.text(), "abcdef");
});

Deno.test("HEAD 和 304 保留元数据且没有响应体", async () => {
  for (const method of ["HEAD", "GET"]) {
    const proxy = createProxy({
      fetcher: (_target, init) => {
        equal(init.method, method);
        return Promise.resolve(
          new Response(null, {
            status: method === "HEAD" ? 200 : 304,
            headers: { "content-length": "123", "etag": '"v1"' },
          }),
        );
      },
    });
    const response = await proxy(new Request(`${ORIGIN}/owner/repo/raw/main/file`, { method }));
    equal(response.status, method === "HEAD" ? 200 : 304);
    equal(response.body, null);
    equal(response.headers.get("content-length"), "123");
    equal(response.headers.get("etag"), '"v1"');
  }
});

Deno.test("GitHub / raw / archive / Release 跳转继续经过代理", async () => {
  const redirects = [
    [
      301,
      "/new-owner/repo.git/info/refs?service=git-upload-pack",
      `${ORIGIN}/new-owner/repo.git/info/refs?service=git-upload-pack`,
    ],
    [302, "../raw/main/file", `${ORIGIN}/owner/raw/main/file`],
    [
      302,
      "https://raw.githubusercontent.com/owner/repo/main/file",
      `${ORIGIN}/__github__/raw.githubusercontent.com/owner/repo/main/file`,
    ],
    [
      307,
      "https://codeload.github.com/owner/repo/zip/refs/heads/main",
      `${ORIGIN}/__github__/codeload.github.com/owner/repo/zip/refs/heads/main`,
    ],
    [
      302,
      "https://release-assets.githubusercontent.com/asset/file?sig=a%2Fb&x=1",
      `${ORIGIN}/__github__/release-assets.githubusercontent.com/asset/file?sig=a%2Fb&x=1`,
    ],
  ] as const;
  for (const [status, location, expected] of redirects) {
    const proxy = createProxy({
      fetcher: () => Promise.resolve(new Response(null, { status, headers: { location } })),
    });
    const response = await proxy(new Request(`${ORIGIN}/owner/repo/file`));
    equal(response.status, status);
    equal(response.headers.get("location"), expected);
  }
});

Deno.test("认证头只发往 github.com，Cookie 和代理站点信息不转发", async () => {
  for (
    const path of [
      "/owner/repo.git/info/refs?service=git-upload-pack",
      "/__github__/raw.githubusercontent.com/owner/repo/main/file",
    ]
  ) {
    const proxy = createProxy({
      fetcher: (target, init) => {
        const headers = new Headers(init.headers);
        equal(headers.get("authorization"), target.hostname === "github.com" ? "Basic test" : null);
        for (const name of ["host", "cookie", "origin", "referer", "x-forwarded-for"]) {
          equal(headers.get(name), null);
        }
        return Promise.resolve(
          new Response("ok", { headers: { "set-cookie": "session=upstream" } }),
        );
      },
    });
    const response = await proxy(
      new Request(`${ORIGIN}${path}`, {
        headers: {
          "authorization": "Basic test",
          "cookie": "session=proxy",
          "origin": ORIGIN,
          "referer": `${ORIGIN}/private-page`,
          "x-forwarded-for": "192.0.2.1",
        },
      }),
    );
    equal(response.headers.get("set-cookie"), null);
    equal(await response.text(), "ok");
  }
});

Deno.test("拒绝未知上游域名，包括域名后缀、端口和 userinfo 绕过", async () => {
  let calls = 0;
  const proxy = createProxy({
    fetcher: () => {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  for (
    const host of [
      "127.0.0.1",
      "github.com.evil.example",
      "github.com:443",
      "github.com@evil.example",
    ]
  ) {
    const response = await proxy(new Request(`${ORIGIN}/__github__/${host}/file`));
    equal(response.status, 403);
    await response.text();
  }
  equal(calls, 0);
});

Deno.test("双斜杠路径不能改变 github.com 上游", async () => {
  const proxy = createProxy({
    fetcher: (target) => {
      equal(target.hostname, "github.com");
      equal(target.pathname, "//evil.example/path");
      return Promise.resolve(new Response("ok"));
    },
  });
  equal(await (await proxy(new Request(`${ORIGIN}//evil.example/path`))).text(), "ok");
});

Deno.test("拒绝跳转到任意主机、HTTP、其他端口或带凭据的地址", async () => {
  for (
    const location of [
      "https://evil.example/file",
      "http://github.com/owner/repo",
      "https://github.com:8443/file",
      "https://user:password@github.com/file",
      "https://github.com.evil.example/file",
      "https://[",
    ]
  ) {
    let cancelled = false;
    const proxy = createProxy({
      fetcher: () => {
        const body = new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        });
        return Promise.resolve(new Response(body, { status: 302, headers: { location } }));
      },
    });
    const response = await proxy(new Request(`${ORIGIN}/owner/repo/file`));
    equal(response.status, 502);
    equal(response.headers.get("location"), null);
    equal(cancelled, true);
    await response.text();
  }
});

Deno.test("清理连接专用请求头和响应头", async () => {
  const proxy = createProxy({
    fetcher: (_target, init) => {
      const headers = new Headers(init.headers);
      equal(headers.get("connection"), null);
      equal(headers.get("git-protocol"), null);
      equal(headers.get("proxy-authorization"), null);
      return Promise.resolve(
        new Response("ok", {
          headers: {
            "connection": "x-internal",
            "x-internal": "private",
            "transfer-encoding": "chunked",
            "keep-alive": "timeout=5",
          },
        }),
      );
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/owner/repo.git/info/refs?service=git-upload-pack`, {
      headers: {
        "connection": "git-protocol",
        "git-protocol": "version=2",
        "proxy-authorization": "Basic proxy-only",
      },
    }),
  );
  for (const name of ["connection", "x-internal", "transfer-encoding", "keep-alive"]) {
    equal(response.headers.get(name), null);
  }
  equal(await response.text(), "ok");
});

Deno.test("上游错误状态和正文原样返回", async () => {
  for (const status of [401, 403, 404, 416, 429]) {
    const proxy = createProxy({
      fetcher: () => Promise.resolve(new Response("upstream error", { status })),
    });
    const response = await proxy(new Request(`${ORIGIN}/owner/repo/file`));
    equal(response.status, status);
    equal(await response.text(), "upstream error");
  }
});

Deno.test("fetch 自动解压后的响应不带旧压缩编码或长度", async () => {
  const proxy = createProxy({
    fetcher: () =>
      Promise.resolve(
        new Response("already decoded", {
          headers: { "content-encoding": "gzip", "content-length": "999" },
        }),
      ),
  });
  const response = await proxy(new Request(`${ORIGIN}/owner/repo/file`));
  equal(response.headers.get("content-encoding"), null);
  equal(response.headers.get("content-length"), null);
  equal(await response.text(), "already decoded");
});

Deno.test("收到响应头就返回流，响应体未完成时不会缓冲或触发响应头超时", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
  });
  const upstream = new Response(stream);
  const proxy = createProxy({
    headerTimeoutMs: 5,
    fetcher: (_target, init) => {
      upstreamSignal = init.signal;
      return Promise.resolve(upstream);
    },
  });
  const response = await proxy(new Request(`${ORIGIN}/owner/repo/file`));
  equal(response.body, upstream.body);
  await new Promise((resolve) => setTimeout(resolve, 20));
  equal(upstreamSignal?.aborted, false);
  controller.enqueue(new Uint8Array([0x00, 0xff, 0x80]));
  controller.close();
  deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0x00, 0xff, 0x80]));
});

Deno.test("等待响应头超时返回 504，连接异常返回 502", async () => {
  const timeoutProxy = createProxy({
    headerTimeoutMs: 5,
    fetcher: (_target, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const timedOut = await timeoutProxy(new Request(`${ORIGIN}/owner/repo/file`));
  equal(timedOut.status, 504);
  await timedOut.text();

  const failingProxy = createProxy({ fetcher: () => Promise.reject(new TypeError("offline")) });
  const failed = await failingProxy(new Request(`${ORIGIN}/owner/repo/file`));
  equal(failed.status, 502);
  await failed.text();
});

Deno.test("客户端中断会传递到上游信号", async () => {
  const client = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const proxy = createProxy({
    fetcher: (_target, init) => {
      upstreamSignal = init.signal;
      return Promise.resolve(new Response("file"));
    },
  });
  const response = await proxy(
    new Request(`${ORIGIN}/owner/repo/file`, { signal: client.signal }),
  );
  client.abort();
  equal(upstreamSignal?.aborted, true);
  await response.text();
});

Deno.test("其他 POST、写入方法和 Git push 被拒绝，首页显示用法", async () => {
  let calls = 0;
  const proxy = createProxy({
    fetcher: () => {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  for (
    const [path, method, status] of [
      ["/owner/repo/issues", "POST", 405],
      ["/owner/repo/file", "PUT", 405],
      ["/owner/repo.git/git-receive-pack", "POST", 405],
      ["/owner/repo.git/info/refs?service=git-receive-pack", "GET", 403],
      ["/__github__/raw.githubusercontent.com/owner/repo/git-upload-pack", "POST", 405],
    ] as const
  ) {
    const response = await proxy(new Request(`${ORIGIN}${path}`, { method }));
    equal(response.status, status);
    await response.text();
  }
  const home = await proxy(new Request(`${ORIGIN}/`));
  equal(home.status, 200);
  ok((await home.text()).includes("git clone https://proxy.example/OWNER/REPO.git"));
  const head = await proxy(new Request(`${ORIGIN}/`, { method: "HEAD" }));
  equal(head.body, null);
  equal(calls, 0);
});
