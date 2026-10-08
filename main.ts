// GitHub 下载 / Git Smart HTTP 代理，无第三方依赖。
const HOST_PREFIX = "/__github__/";
const ALLOWED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "media.githubusercontent.com",
]);

const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "git-protocol",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "range",
  "user-agent",
];

const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CONDITIONAL_HEADERS = [
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
];

type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;

interface ProxyOptions {
  fetcher?: Fetcher;
  // 只限制等待上游响应头的时间；收到响应头后，大文件可以继续流式下载。
  headerTimeoutMs?: number;
}

function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of HOP_HEADERS) headers.delete(name);
  return headers;
}

function applyCachePolicy(headers: Headers, requestHeaders: Headers): void {
  const vary = new Set(
    (headers.get("vary") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  // CDN 可能在进入脚本前复用普通 GET 的 200；用 Vary 隔离条件请求。
  if (!vary.has("*")) {
    for (const name of CONDITIONAL_HEADERS) vary.add(name);
    headers.set("vary", [...vary].join(", "));
  }
  // 即使上游返回 200（文件已更新），也不缓存这次带条件的响应。
  // 客户端缓存仍遵循上游 Cache-Control，普通下载仍可使用 Deno CDN。
  if (CONDITIONAL_HEADERS.some((name) => requestHeaders.has(name))) {
    headers.set("deno-cdn-cache-control", "no-store");
  }
}

function isAllowed(url: URL): boolean {
  return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) &&
    !url.port && !url.username && !url.password;
}

function upstreamUrl(incoming: URL): URL | null {
  const target = new URL("https://github.com");
  // 设置 pathname 而非用路径解析 URL，避免 //example.com 改变上游主机。
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  if (incoming.pathname.startsWith(HOST_PREFIX)) {
    const route = incoming.pathname.slice(HOST_PREFIX.length);
    const separator = route.indexOf("/");
    const host = separator < 0 ? route : route.slice(0, separator);
    if (!ALLOWED_HOSTS.has(host)) return null;
    target.hostname = host;
    target.pathname = separator < 0 ? "/" : route.slice(separator);
  }

  // GitHub 的 blob 页面链接也可直接下载。由 GitHub 自己解析分支和文件路径。
  if (target.hostname === "github.com") {
    target.pathname = target.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
  }
  return target;
}

function proxyLocation(target: URL, incoming: URL): string {
  const location = new URL(incoming.origin);
  location.pathname = target.hostname === "github.com"
    ? target.pathname
    : `${HOST_PREFIX}${target.hostname}${target.pathname}`;
  location.search = target.search;
  location.hash = target.hash;
  return location.href;
}

function textResponse(message: string, status: number, method: string): Response {
  return new Response(method === "HEAD" ? null : message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function createProxy(
  { fetcher = fetch, headerTimeoutMs = 60_000 }: ProxyOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const incoming = new URL(request.url);
    const target = upstreamUrl(incoming);
    if (!target) return textResponse("只允许代理 GitHub 下载域名。\n", 403, request.method);

    const uploadPack = target.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/git-upload-pack$/.test(target.pathname);
    const allowedMethods = uploadPack ? "GET, HEAD, POST" : "GET, HEAD";
    if (
      request.method !== "GET" && request.method !== "HEAD" &&
      !(request.method === "POST" && uploadPack)
    ) {
      const response = textResponse("此路径不支持该请求方法。\n", 405, request.method);
      response.headers.set("allow", allowedMethods);
      return response;
    }
    if (target.searchParams.getAll("service").includes("git-receive-pack")) {
      return textResponse("此代理支持下载、clone 和 fetch。\n", 403, request.method);
    }

    if (incoming.pathname === "/") {
      return textResponse(
        `GitHub 下载 / Git clone 代理\n\n` +
          `将 GitHub URL 中的 github.com 替换为 ${incoming.host}，保留其余路径和参数。\n\n` +
          `下载文件：${incoming.origin}/OWNER/REPO/blob/main/path/to/file\n` +
          `Release：${incoming.origin}/OWNER/REPO/releases/download/TAG/FILE\n` +
          `源码 ZIP：${incoming.origin}/OWNER/REPO/archive/refs/heads/main.zip\n` +
          `克隆仓库：git clone ${incoming.origin}/OWNER/REPO.git\n` +
          `命令行下载：curl -fL -o FILE URL\n`,
        200,
        request.method,
      );
    }

    const sourceHeaders = cleanHeaders(request.headers);
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = sourceHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
    // 不转发代理站点的 Cookie、Host、Origin；认证信息仅发往 github.com。
    if (target.hostname !== "github.com") headers.delete("authorization");
    if (request.method !== "POST") headers.delete("content-length");
    headers.set("accept-encoding", "identity");
    if (!headers.has("user-agent")) headers.set("user-agent", "GitHub-Deno-Proxy");

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), headerTimeoutMs);
    let upstream: Response;
    try {
      upstream = await fetcher(target, {
        method: request.method,
        headers,
        body: request.method === "POST" ? request.body : undefined,
        // 必须自己改写 Location，否则客户端会绕过代理直连 GitHub 下载域名。
        redirect: "manual",
        signal: AbortSignal.any([request.signal, timeout.signal]),
      });
    } catch {
      return textResponse(
        timeout.signal.aborted ? "等待 GitHub 响应超时。\n" : "连接 GitHub 上游失败。\n",
        timeout.signal.aborted ? 504 : 502,
        request.method,
      );
    } finally {
      clearTimeout(timer);
    }

    const responseHeaders = cleanHeaders(upstream.headers);
    responseHeaders.delete("set-cookie");
    // fetch 会自动解压；上游即使忽略 identity，也不能返回旧的压缩长度和编码。
    if (request.method !== "HEAD" && responseHeaders.has("content-encoding")) {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }

    const location = responseHeaders.get("location");
    if (location && REDIRECT_STATUSES.has(upstream.status)) {
      let redirect: URL;
      try {
        redirect = new URL(location, target);
      } catch {
        await upstream.body?.cancel();
        return textResponse("GitHub 返回了无效的跳转地址。\n", 502, request.method);
      }
      if (!isAllowed(redirect)) {
        await upstream.body?.cancel();
        return textResponse("上游跳转地址不在 GitHub 下载域名范围内。\n", 502, request.method);
      }
      responseHeaders.set("location", proxyLocation(redirect, incoming));
    }

    applyCachePolicy(responseHeaders, request.headers);
    // 直接转发二进制流，保留状态码、Range、ETag、Content-Disposition 和 Git 响应。
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}

export const handler = createProxy();

if (import.meta.main) {
  Deno.serve(handler);
}
