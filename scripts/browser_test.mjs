import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const origin = new URL(process.argv[2] || "http://127.0.0.1:8000").origin;
const directory = process.argv[3] || ".tmp/web-proxy/browser-results";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = {
  checked_at: new Date().toISOString(),
  origin,
  environment: "WSL Linux Chromium; browser outbound HTTP(S) restricted to proxy origin",
  browser: browser.version(),
  pages: [],
};

try {
  for (
    const [name, path] of [
      ["intel_release", "/intel/AI-Playground/releases/tag/v3.2.1-beta"],
      ["intel_repository", "/intel/AI-Playground"],
      ["file_view", "/toponehhh/TigbuhyxorP/blob/main/main.ts"],
    ]
  ) {
    console.log("Testing", name, "with direct GitHub access blocked");
    const context = await browser.newContext({
      viewport: { width: 1360, height: 960 },
      serviceWorkers: "block",
    });
    const blocked = [];
    const responses = [];
    const errors = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        blocked.push({ url: url.origin + url.pathname, type: route.request().resourceType() });
        return route.abort("internetdisconnected");
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      globalThis.__proxyCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__proxyCspViolations.push({
          uri: event.blockedURI,
          directive: event.effectiveDirective,
        });
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) =>
      responses.push({
        url: new URL(response.url()).pathname,
        status: response.status(),
        type: response.request().resourceType(),
      }));
    const result = { name, path, checks: [], blocked, errors, responses };
    report.pages.push(result);
    try {
      const response = await page.goto(origin + path, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => globalThis.__githubProxyInstalled === true, null, {
        timeout: 10000,
      });
      result.checks.push("main HTML and browser proxy script loaded");
      if (name === "intel_release") {
        const fragment = page.locator("include-fragment[src*='expanded_assets']");
        if (await fragment.count()) await fragment.first().scrollIntoViewIfNeeded();
        const installer = page.locator(
          "a[href*='/releases/download/v3.2.1-beta/AI-Playground-installer.exe']",
        ).first();
        await installer.waitFor({ state: "attached", timeout: 45000 });
        assert.equal(new URL(await installer.getAttribute("href"), origin).origin, origin);
        const dynamic = await page.evaluate(async () => {
          const response = await fetch(
            "https://github.com/intel/AI-Playground/releases/expanded_assets/v3.2.1-beta",
          );
          return { status: response.status, url: response.url, body: await response.text() };
        });
        assert.equal(dynamic.status, 200);
        assert.equal(new URL(dynamic.url).origin, origin);
        assert.ok(dynamic.body.includes("AI-Playground-installer.exe"));
        result.checks.push("release attachments and dynamic fetch stay on proxy origin");
      }
      if (name === "intel_repository") {
        const image = await page.evaluate(() =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve({ ok: true, src: image.src, width: image.naturalWidth });
            image.onerror = () => resolve({ ok: false, src: image.src });
            image.src =
              "https://raw.githubusercontent.com/intel/AI-Playground/main/docs/readme/hero-3.2.png";
            document.body.appendChild(image);
          })
        );
        assert.equal(image.ok, true);
        assert.equal(new URL(image.src).origin, origin);
        result.checks.push("dynamically created README image loads through proxy");
        const readme = page.locator("a[href$='/blob/main/readme.md']:visible").first();
        await readme.click();
        await page.waitForURL(origin + "/intel/AI-Playground/blob/main/readme.md", {
          timeout: 30000,
        });
        await page.waitForFunction(() => document.title.includes("readme.md"), null, {
          timeout: 30000,
        });
        result.checks.push("repository link navigates to README file viewer through proxy");
      }
      if (name === "file_view") {
        assert.ok((await page.title()).includes("main.ts"));
        assert.ok((await page.locator("body").innerText()).includes("createProxy"));
        result.checks.push("browser blob URL renders file viewer");
      }
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const stylesheet = responses.filter((item) =>
        item.type === "stylesheet" && item.status === 200
      );
      assert.ok(stylesheet.length > 0, "stylesheet must load through proxy");
      assert.equal(
        responses.filter((item) =>
          ["script", "stylesheet", "image"].includes(item.type) && item.status >= 400
        ).length,
        0,
        "page resource returned an HTTP error",
      );
      const dependencies = await page.evaluate(() =>
        [...document.querySelectorAll(
          "script[src],link[rel='stylesheet'],img[src],include-fragment[src]",
        )]
          .map((element) => element.src || element.href || element.getAttribute("src"))
          .filter((value) => value && /^https?:/.test(value))
      );
      assert.ok(
        dependencies.every((url) => new URL(url).origin === origin),
        "page dependency bypassed proxy",
      );
      assert.equal(blocked.length, 0, "browser attempted direct external requests");
      result.csp_violations = await page.evaluate(() => globalThis.__proxyCspViolations);
      assert.equal(result.csp_violations.length, 0, "CSP blocked a page dependency");
      assert.equal(errors.length, 0, "browser JavaScript error");
      result.checks.push("stylesheets and dependencies remain same-origin; no CSP or JS errors");
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.failure = error.message;
      result.csp_violations = await page.evaluate(() => globalThis.__proxyCspViolations || [])
        .catch(
          () => [],
        );
    }
    result.title = await page.title().catch(() => "");
    await page.screenshot({ path: directory + "/" + name + ".png", fullPage: false }).catch(
      () => {},
    );
    console.log(
      name,
      result.passed ? "PASS" : "FAIL",
      result.failure || "",
      "blocked=" + blocked.length,
      "errors=" + errors.length,
    );
    await writeFile(directory + "/results.json", JSON.stringify(report, null, 2) + "\n");
    await context.close();
  }
} finally {
  await browser.close();
}
report.passed = report.pages.filter((page) => page.passed).length;
report.total = report.pages.length;
await writeFile(directory + "/results.json", JSON.stringify(report, null, 2) + "\n");
console.log(`${report.passed}/${report.total} browser pages passed`);
process.exitCode = report.passed === report.total ? 0 : 1;
