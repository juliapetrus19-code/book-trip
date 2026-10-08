// Visual audit: full set of screenshots of the main screens (desktop + phone, Ukrainian). Not part of the test suite.
// Usage: NODE_PATH=$(npm root -g) node tests/audit-shots.mjs <outDir> [base]
import { chromium, routeFonts } from "./pw-helpers.mjs";
const out = process.argv[2];
const base = process.argv[3] || "http://localhost:5600";
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
async function page(w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "uk-UA", isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
  await routeFonts(ctx);
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && !/WebGL|GPU|swiftshader|Failed to load resource/i.test(m.text())) errors.push(`${w}: ${m.text()}`); });
  p.on("pageerror", (e) => errors.push(`${w} pageerror: ${e.message}`));
  return p;
}
const wait = (p, ms) => p.waitForTimeout(ms);
for (const [w, h, mobile, tag] of [[1440, 900, false, "d"], [390, 844, true, "m"]]) {
  const p = await page(w, h, mobile);
  await p.goto(base + "/", { waitUntil: "networkidle" }); await wait(p, 2500);
  await p.screenshot({ path: `${out}/${tag}-01-home.png` });
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await wait(p, 1200);
  await p.screenshot({ path: `${out}/${tag}-02-home-bottom.png` });
  await p.goto(base + "/#/how", { waitUntil: "networkidle" }); await wait(p, 1500);
  await p.screenshot({ path: `${out}/${tag}-03-how.png` });
  await p.goto(base + "/book/lisova-pisnia", { waitUntil: "networkidle" }); await wait(p, 2500);
  await p.screenshot({ path: `${out}/${tag}-04-book-top.png` });
  for (const sec of ["summary", "terms", "characters", "similar", "film"]) {
    await p.evaluate((s) => document.getElementById(`bk-${s}`)?.scrollIntoView(), sec); await wait(p, 1800);
    await p.screenshot({ path: `${out}/${tag}-05-book-${sec}.png` });
  }
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await wait(p, 1000);
  await p.screenshot({ path: `${out}/${tag}-06-book-footer.png` });
  await p.close();
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
