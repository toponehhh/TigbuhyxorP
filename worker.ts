import { createProxy, type Fetcher } from "./proxy.ts";

const conditionalHeaders = [
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  "range",
  "authorization",
];

export function createPagesProxy(fetcher: Fetcher = fetch) {
  const proxy = createProxy({
    cdnCacheControlHeader: "cloudflare-cdn-cache-control",
    preserveContentEncoding: true,
    fetcher: (url, init) => {
      const headers = new Headers(init.headers);
      const bypassCache = init.method !== "GET" ||
        conditionalHeaders.some((name) => headers.has(name));
      return fetcher(url, bypassCache ? { ...init, cache: "no-store" } : init);
    },
  });
  return async (request: Request): Promise<Response> => {
    const response = await proxy(request);
    // 每次请求进入代理，避免边缘缓存混用 blob 页面/raw 下载，或跳过条件判断。
    // 浏览器仍遵循原站 Cache-Control；普通上游 GET 仍可使用 Cloudflare 子请求缓存。
    response.headers.set("cloudflare-cdn-cache-control", "no-store");
    response.headers.set("cdn-cache-control", "no-store");
    response.headers.delete("deno-cdn-cache-control");
    return response;
  };
}

export default { fetch: createPagesProxy() };
