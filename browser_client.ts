import { ALLOWED_HOSTS, HOST_PREFIX } from "./proxy_urls.ts";

// 作为独立的经典脚本在站点脚本之前执行；不包含服务端凭据。
export const BROWSER_CLIENT = String.raw`(() => {
  if (window.__githubProxyInstalled) return;
  window.__githubProxyInstalled = true;
  const allowed = new Set(${JSON.stringify([...ALLOWED_HOSTS])});
  const prefix = ${JSON.stringify(HOST_PREFIX)};
  function map(value) {
    if (typeof value !== "string" || !value || value[0] === "#") return value;
    try {
      const url = new URL(value, document.baseURI);
      if (!allowed.has(url.hostname) || url.username || url.password || url.port ||
          !["https:", "http:"].includes(url.protocol)) return value;
      return location.origin + (url.hostname === "github.com" ? "" : prefix + url.hostname) +
        url.pathname + url.search + url.hash;
    } catch { return value; }
  }
  const nativeFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = map(input instanceof Request ? input.url : String(input));
    if (new URL(url, document.baseURI).origin !== location.origin) {
      return nativeFetch.call(this, input, init);
    }
    const headers = new Headers(init && init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("x-github-proxy-web", "1");
    const mapped = input instanceof Request ? new Request(url, input) : url;
    return nativeFetch.call(this, mapped, Object.assign({}, init, { headers }));
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const result = nativeOpen.call(this, method, map(String(url)), ...args);
    if (new URL(map(String(url)), document.baseURI).origin === location.origin) {
      this.setRequestHeader("x-github-proxy-web", "1");
    }
    return result;
  };
  function srcset(value) {
    if (value.trim().startsWith("data:")) return value;
    return value.split(",").map(part => {
      const bits = part.trim().split(/\s+/);
      bits[0] = map(bits[0]);
      return bits.join(" ");
    }).join(", ");
  }
  const urlAttributes = new Set(["src", "href", "action", "poster", "data-src", "data-url"]);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = name.toLowerCase();
    if (urlAttributes.has(key)) value = map(String(value));
    if (key === "srcset") value = srcset(String(value));
    return nativeSetAttribute.call(this, name, value);
  };
  for (const [type, properties] of [
    [HTMLImageElement, ["src", "srcset"]], [HTMLScriptElement, ["src"]],
    [HTMLLinkElement, ["href"]], [HTMLAnchorElement, ["href"]],
    [HTMLIFrameElement, ["src"]], [HTMLSourceElement, ["src", "srcset"]],
    [HTMLMediaElement, ["src"]], [HTMLVideoElement, ["poster"]], [HTMLFormElement, ["action"]],
  ]) {
    for (const name of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype, name);
      if (!descriptor || !descriptor.set) continue;
      Object.defineProperty(type.prototype, name, Object.assign({}, descriptor, {
        set(value) { descriptor.set.call(this, name === "srcset" ? srcset(String(value)) : map(String(value))); },
      }));
    }
  }
  const nativeWindowOpen = window.open;
  window.open = function(url, ...args) { return nativeWindowOpen.call(this, map(String(url)), ...args); };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function(state, title, url) {
      return original.call(this, state, title, url == null ? url : map(String(url)));
    };
  }
  const nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (nativeBeacon) navigator.sendBeacon = (url, data) => {
    const target = new URL(String(url), document.baseURI);
    // 公开网页浏览不需要原站的访问统计，避免遥测发起直连或写请求。
    if (target.hostname === "collector.github.com" ||
        (target.hostname === "api.github.com" && target.pathname === "/_private/browser/stats") ||
        (target.origin === location.origin && target.pathname === prefix + "api.github.com/_private/browser/stats")) return true;
    return nativeBeacon(map(String(url)), data);
  };
  function fix(element) {
    if (!(element instanceof Element)) return;
    for (const name of urlAttributes) {
      const value = element.getAttribute(name);
      if (value && map(value) !== value) nativeSetAttribute.call(element, name, map(value));
    }
    const value = element.getAttribute("srcset");
    if (value && srcset(value) !== value) nativeSetAttribute.call(element, "srcset", srcset(value));
    if (element.hasAttribute("integrity")) element.removeAttribute("integrity");
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") fix(record.target);
      for (const node of record.addedNodes) {
        fix(node);
        if (node.querySelectorAll) node.querySelectorAll("[src],[href],[srcset],[action],[poster]").forEach(fix);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: [...urlAttributes, "srcset", "integrity"] });
  document.addEventListener("click", event => {
    const link = event.target instanceof Element && event.target.closest("a[href]");
    if (link) fix(link);
  }, true);
})();`;
