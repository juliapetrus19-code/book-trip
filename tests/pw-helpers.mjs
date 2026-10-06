// Playwright helpers for local checks in this sandbox.
// Chromium is preinstalled (PLAYWRIGHT_BROWSERS_PATH). Run scripts with:  NODE_PATH=$(npm root -g) node script.mjs
// Google Fonts cannot be reached directly by the browser here, so fonts are fetched with curl
// (which knows the proxy) and served to the page through request routing.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

const fontCache = new Map();
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export async function routeFonts(context) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    const url = route.request().url();
    try {
      if (!fontCache.has(url)) fontCache.set(url, execFileSync("curl", ["-sS", "-A", UA, url], { maxBuffer: 1 << 26 }));
      const ct = url.includes("googleapis") ? "text/css; charset=utf-8" : "font/woff2";
      await route.fulfill({ status: 200, body: fontCache.get(url), headers: { "content-type": ct, "access-control-allow-origin": "*" } });
    } catch {
      await route.abort();
    }
  });
}

/**
 * Open a page with fonts routed and console errors collected.
 * `page.errors` gets every console error / pageerror (WebGL software-rendering noise filtered out).
 */
export async function openPage(browser, url, { width = 1280, height = 800, dpr = 1, mobile = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await routeFonts(context);
  const page = await context.newPage();
  page.errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet|swiftshader/i.test(m.text())) page.errors.push(m.text());
  });
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return page;
}

/** Launch Chromium with WebGL enabled in headless mode (software rendering). */
export function launch() {
  return chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
}
