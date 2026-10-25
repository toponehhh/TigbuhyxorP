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
    fetcher: async (url, init) => {
      const headers = new Headers(init.headers);
      const bypassCache = init.method !== "GET" ||
        conditionalHeaders.some((name) => headers.has(name));
      const options: RequestInit = bypassCache ? { ...init, cache: "no-store" } : init;
      const response = await fetcher(url, options);
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (headers.has("range") && response.status === 206 && encoding && encoding !== "identity") {
        // Cloudflare 可能协商到压缩表示；其局部压缩流无法独立解压成原文件的字节范围。
        // 重新获取完整表示，以合法的 200 返回，避免 206 空正文/损坏片段被客户端追加。
        await response.body?.cancel();
        headers.delete("range");
        headers.delete("if-range");
        return fetcher(url, { ...options, headers, cache: "no-store" });
      }
      return response;
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
