export const HOST_PREFIX = "/__github__/";
export const BROWSER_SCRIPT = "/__proxy__/browser.js";
export const ALLOWED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "objects-origin.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "media.githubusercontent.com",
  "github.githubassets.com",
  "opengraph.githubassets.com",
  "avatars.githubusercontent.com",
  "camo.githubusercontent.com",
  "user-images.githubusercontent.com",
  "repository-images.githubusercontent.com",
  "identicons.github.com",
  "api.github.com",
]);

export function isAllowed(url: URL): boolean {
  return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) &&
    !url.port && !url.username && !url.password;
}

export function upstreamUrl(incoming: URL, browserRequest = false): URL | null {
  const target = new URL("https://github.com");
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
  // 浏览器保留文件查看页；curl 等下载客户端继续支持 blob -> raw。
  if (target.hostname === "github.com" && !browserRequest) {
    target.pathname = target.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
  }
  return target;
}

export function proxyLocation(target: URL, incoming: URL): string {
  const location = new URL(incoming.origin);
  location.pathname = target.hostname === "github.com"
    ? target.pathname
    : `${HOST_PREFIX}${target.hostname}${target.pathname}`;
  location.search = target.search;
  location.hash = target.hash;
  return location.href;
}

export function rewriteUrl(value: string, target: URL, incoming: URL): string {
  if (!value || value.startsWith("#")) return value;
  try {
    const url = new URL(value, target);
    if (url.protocol === "http:" && ALLOWED_HOSTS.has(url.hostname)) url.protocol = "https:";
    return isAllowed(url) ? proxyLocation(url, incoming) : value;
  } catch {
    return value;
  }
}

const hosts = [...ALLOWED_HOSTS].map((host) => host.replaceAll(".", "\\.")).join("|");
const absoluteUrls = new RegExp(
  `(?:https?:)?//(${hosts})(?=[/?#\\s"'<>\x60)]|$)`,
  "gi",
);

export function rewriteAbsoluteUrls(text: string, _target: URL, incoming: URL): string {
  const replaceOrigin = (_value: string, host: string) =>
    incoming.origin +
    (host.toLowerCase() === "github.com" ? "" : HOST_PREFIX + host.toLowerCase());
  // JSON/JS 中的 \/ 先单独处理，避免改变其余代码或正文的转义。
  return text.replace(/https?:\\\/\\\/[^\s"'<>]+/g, (value) => {
    const rewritten = value.replaceAll("\\/", "/").replace(absoluteUrls, replaceOrigin);
    return rewritten.replaceAll("/", "\\/");
  }).replace(absoluteUrls, replaceOrigin);
}
