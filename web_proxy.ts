import {
  defaultTreeAdapter,
  type DefaultTreeAdapterMap,
  parse,
  parseFragment,
  serialize,
} from "parse5";
import { BROWSER_SCRIPT, rewriteAbsoluteUrls, rewriteUrl } from "./proxy_urls.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export function rewriteCss(text: string, target: URL, incoming: URL): string {
  return rewriteAbsoluteUrls(text, target, incoming)
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, _quote, value: string) => {
      const rewritten = rewriteUrl(value.trim(), target, incoming);
      return rewritten === value.trim() ? whole : `url(${JSON.stringify(rewritten)})`;
    })
    .replace(
      /(@import\s+)(["'])(.*?)\2/gi,
      (_whole, lead, _quote, value) => lead + JSON.stringify(rewriteUrl(value, target, incoming)),
    );
}

export function rewriteScript(text: string, target: URL, incoming: URL): string {
  const rewritten = rewriteAbsoluteUrls(text, target, incoming);
  if (target.hostname !== "github.githubassets.com") return rewritten;
  // CDN 模块中以 /assets/ 开头的字符串需要保留其原有上游主机。
  return rewritten.replace(
    /(["'])(\/assets\/[^"']*)\1/g,
    (_whole, _quote, value) => JSON.stringify(rewriteUrl(value, target, incoming)),
  );
}

function csp(nonce: string): string {
  return `default-src 'none'; base-uri 'self'; ` +
    `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; ` +
    `worker-src 'self' blob:; frame-src 'self'; media-src 'self' blob:; ` +
    `manifest-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'`;
}

export function rewriteHtml(
  text: string,
  target: URL,
  incoming: URL,
  nonce: string,
): { body: string; fullDocument: boolean } {
  const fullDocument = /<!doctype\s+html|<html[\s>]/i.test(text);
  const document = fullDocument ? parse(text) : parseFragment(text);
  let head: Element | undefined;
  const urlAttributes = new Set(["href", "src", "action", "poster", "data-src", "data-url"]);
  function walk(node: Node) {
    if (defaultTreeAdapter.isElementNode(node)) {
      if (node.tagName === "head") head = node;
      for (const attr of node.attrs) {
        if (urlAttributes.has(attr.name)) attr.value = rewriteUrl(attr.value, target, incoming);
        else if (attr.name === "srcset" && !attr.value.trim().startsWith("data:")) {
          attr.value = attr.value.split(",").map((entry) => {
            const parts = entry.trim().split(/\s+/);
            parts[0] = rewriteUrl(parts[0], target, incoming);
            return parts.join(" ");
          }).join(", ");
        } else if (attr.name === "style") attr.value = rewriteCss(attr.value, target, incoming);
        else attr.value = rewriteAbsoluteUrls(attr.value, target, incoming);
      }
      // 修改过的脚本和样式不再匹配原站 SRI；只接受受限上游返回的资源。
      node.attrs = node.attrs.filter((attr) => attr.name !== "integrity");
      if (node.tagName === "script" && fullDocument) {
        node.attrs = node.attrs.filter((attr) => attr.name !== "nonce");
        node.attrs.push({ name: "nonce", value: nonce });
      }
      if (node.tagName === "meta") {
        const equiv = node.attrs.find((attr) => attr.name === "http-equiv")?.value.toLowerCase();
        const content = node.attrs.find((attr) => attr.name === "content");
        if (content && equiv === "content-security-policy") content.value = csp(nonce);
      }
      for (const child of node.childNodes) {
        if (defaultTreeAdapter.isTextNode(child)) {
          if (node.tagName === "script") child.value = rewriteScript(child.value, target, incoming);
          if (node.tagName === "style") child.value = rewriteCss(child.value, target, incoming);
        }
      }
    }
    if ("childNodes" in node) { for (const child of node.childNodes) walk(child); }
    if (
      defaultTreeAdapter.isElementNode(node) && node.tagName === "template" && "content" in node
    ) {
      walk(node.content);
    }
  }
  walk(document);
  if (head) {
    const script = defaultTreeAdapter.createElement("script", head.namespaceURI, [
      { name: "src", value: incoming.origin + BROWSER_SCRIPT },
      { name: "nonce", value: nonce },
    ]);
    if (head.childNodes.length) defaultTreeAdapter.insertBefore(head, script, head.childNodes[0]);
    else defaultTreeAdapter.appendChild(head, script);
  }
  return { body: serialize(document), fullDocument };
}

function canRewrite(target: URL): boolean {
  return ["github.com", "github.githubassets.com", "api.github.com"].includes(target.hostname) &&
    !(target.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/(?:raw\/|releases\/download\/|archive\/|git-upload-pack$|info\/refs$)/
        .test(target.pathname));
}

export function expectsWebContent(request: Request, target: URL): boolean {
  if (!canRewrite(target)) return false;
  const dest = request.headers.get("sec-fetch-dest");
  return request.headers.get("x-github-proxy-web") === "1" ||
    ["empty", "document", "iframe", "script", "style"].includes(dest ?? "") ||
    (request.headers.get("accept") ?? "").includes("text/html") ||
    target.hostname === "api.github.com" ||
    (target.hostname === "github.githubassets.com" && /\.(?:m?js|css|json)$/.test(target.pathname));
}

export async function rewriteWebResponse(
  upstream: Response,
  headers: Headers,
  target: URL,
  request: Request,
): Promise<Response | null> {
  const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const html = type === "text/html";
  const css = type === "text/css";
  const script = ["application/javascript", "text/javascript", "application/x-javascript"].includes(
    type,
  );
  const json = type === "application/json" || type.endsWith("+json");
  if (
    !(html || css || script || json) || !canRewrite(target) || !upstream.body ||
    upstream.status !== 200 || /\battachment\b/i.test(headers.get("content-disposition") ?? "") ||
    (!html && !expectsWebContent(request, target))
  ) {
    return null;
  }
  const incoming = new URL(request.url);
  const source = await upstream.text();
  let body: string;
  if (html) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const result = rewriteHtml(source, target, incoming, nonce);
    body = result.body;
    if (result.fullDocument) headers.set("content-security-policy", csp(nonce));
    else headers.delete("content-security-policy");
    headers.set("cache-control", "no-store");
    headers.set("deno-cdn-cache-control", "no-store");
  } else {
    body = css
      ? rewriteCss(source, target, incoming)
      : script
      ? rewriteScript(source, target, incoming)
      : rewriteAbsoluteUrls(source, target, incoming);
  }
  for (
    const name of [
      "content-length",
      "etag",
      "last-modified",
      "accept-ranges",
      "content-range",
      "content-md5",
      "digest",
      "content-digest",
      "content-security-policy-report-only",
      "report-to",
      "nel",
    ]
  ) {
    headers.delete(name);
  }
  const bytes = new TextEncoder().encode(body);
  if (!html) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const etag = `W/"proxy-${
      [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    }"`;
    headers.set("etag", etag);
    // 当前表示使用弱验证器，If-Match 只能由通配符满足。
    const match = request.headers.get("if-match");
    if (match !== null && match.trim() !== "*") {
      return new Response(null, { status: 412, headers });
    }
    const tags = request.headers.get("if-none-match")?.split(",").map((tag) =>
      tag.trim().replace(/^W\//, "")
    );
    if (tags?.includes("*") || tags?.includes(etag.slice(2))) {
      return new Response(null, { status: 304, headers });
    }
  }
  headers.set("content-length", String(bytes.length));
  return new Response(request.method === "HEAD" ? null : bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
