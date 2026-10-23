// 可选的 Deno 本地入口；Cloudflare Pages 使用 worker.ts。
import { handler } from "./proxy.ts";
export { createProxy, handler } from "./proxy.ts";

if (import.meta.main) {
  Deno.serve(handler);
}
