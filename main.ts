// GitHub 公开网页、下载和 Git Smart HTTP 代理。
import { BROWSER_CLIENT } from "./browser_client.ts";
import {
  BROWSER_SCRIPT,
  isAllowed,
  proxyLocation,
  rewriteAbsoluteUrls,
  upstreamUrl,
} from "./proxy_urls.ts";
import { expectsWebContent, rewriteWebResponse } from "./web_proxy.ts";

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
  "github-verified-fetch",
  "x-requested-with",
  "x-pjax",
  "x-pjax-container",
  "turbo-frame",
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
    // 浏览器的 blob 查看页与命令行 raw 下载不能共用缓存。
    for (const name of ["accept", "sec-fetch-dest", "x-github-proxy-web"]) vary.add(name);
    headers.set("vary", [...vary].join(", "));
  }
  // 即使上游返回 200（文件已更新），也不缓存这次带条件的响应。
  // 客户端缓存仍遵循上游 Cache-Control，普通下载仍可使用 Deno CDN。
  if (CONDITIONAL_HEADERS.some((name) => requestHeaders.has(name))) {
    headers.set("deno-cdn-cache-control", "no-store");
  }
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
    if (incoming.pathname === BROWSER_SCRIPT) {
      if (!["GET", "HEAD"].includes(request.method)) {
        return textResponse("只支持 GET / HEAD。\n", 405, request.method);
      }
      return new Response(request.method === "HEAD" ? null : BROWSER_CLIENT, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const browserRequest = request.headers.has("sec-fetch-dest") ||
      request.headers.get("x-github-proxy-web") === "1" ||
      (request.headers.get("accept") ?? "").includes("text/html");
    const target = upstreamUrl(incoming, browserRequest);
    if (!target) return textResponse("只允许代理指定的 GitHub 及资源域名。\n", 403, request.method);

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
        `GitHub 公开网页 / 下载 / Git clone 代理\n\n` +
          `将 GitHub URL 中的 github.com 替换为 ${incoming.host}，保留其余路径和参数。\n\n` +
          `下载文件：${incoming.origin}/OWNER/REPO/blob/main/path/to/file\n` +
          `浏览仓库：${incoming.origin}/OWNER/REPO\n` +
          `浏览 Release：${incoming.origin}/OWNER/REPO/releases/tag/TAG\n` +
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
    // 文本会被改写，不能把客户端的代理 ETag 发给原站，或返回未经改写的局部文本。
    const webContent = expectsWebContent(request, target);
    if (webContent) {
      for (const name of [...CONDITIONAL_HEADERS, "range"]) {
        headers.delete(name);
      }
    }
    headers.set("accept-encoding", "identity");
    if (!headers.has("user-agent")) headers.set("user-agent", "GitHub-Deno-Proxy");

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), headerTimeoutMs);
    // 改写文本的 HEAD 也需要计算与 GET 相同的长度和代理 ETag。
    const upstreamMethod = request.method === "HEAD" && webContent ? "GET" : request.method;
    let upstream: Response;
    try {
      upstream = await fetcher(target, {
        method: upstreamMethod,
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
    const link = responseHeaders.get("link");
    if (link) responseHeaders.set("link", rewriteAbsoluteUrls(link, target, incoming));
    // fetch 会自动解压；上游即使忽略 identity，也不能返回旧的压缩长度和编码。
    if (upstreamMethod !== "HEAD" && responseHeaders.has("content-encoding")) {
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
    const webResponse = await rewriteWebResponse(upstream, responseHeaders, target, request);
    if (webResponse) return webResponse;
    if (request.method === "HEAD") await upstream.body?.cancel();
    // 直接转发二进制流，保留状态码、Range、ETag、Content-Disposition 和 Git 响应。
    return new Response(request.method === "HEAD" ? null : upstream.body, {
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
