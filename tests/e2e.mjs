// End-to-end checks for BookTrip in headless Chromium (software WebGL).
//
//   NODE_PATH=$(npm root -g) node tests/e2e.mjs [--base http://localhost:5600/] [--only home,live] [--shots]
//
// Starts tests/dev-server.mjs when nothing answers at --base. Prints PASS/FAIL per check and exits
// with code 1 when any check fails. --shots saves screenshots of the key states to shots/e2e/.
// The LIVE flow is fully mocked with page.route fixtures, so no API keys are needed.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launch, routeFonts } from "./pw-helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i < 0 ? def : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true; };
const BASE = String(arg("base", "http://localhost:5600/")).replace(/\/?$/, "/");
const ONLY = arg("only", "") ? String(arg("only")).split(",") : null;
const SHOTS = arg("shots", false) ? `${ROOT}shots/e2e/` : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// tiny harness

const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  if (ONLY && !ONLY.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n      ${String(err && err.message || err).split("\n").join("\n      ")}`);
  }
}
async function shot(page, name, opts = {}) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}${name}.png`, ...opts });
}

async function ensureServer() {
  const up = async () => { try { return (await fetch(BASE + "api/health")).ok; } catch { return false; } };
  if (await up()) return null;
  const port = new URL(BASE).port || "80";
  const child = spawn(process.execPath, [`${ROOT}tests/dev-server.mjs`, port], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { await sleep(200); if (await up()) return child; }
  child.kill();
  throw new Error(`dev server did not start at ${BASE}`);
}

const browser = await (async () => { await ensureServer().then((c) => { if (c) process.on("exit", () => c.kill()); }); return launch(); })();

/** New page with fonts routed, console errors collected and the UI language preset. */
async function open(path = "", { width = 1440, height = 900, dpr = 1, mobile = false, lang = "ru", routes = null, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile, reducedMotion });
  await routeFonts(context);
  if (routes) await routes(context);
  await context.addInitScript((l) => { try { if (!sessionStorage.getItem("e2e-init")) { localStorage.setItem("bt-lang", l); sessionStorage.setItem("e2e-init", "1"); } } catch { /* ignore */ } }, lang);
  const page = await context.newPage();
  page.errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet|swiftshader|Failed to load resource/i.test(m.text())) page.errors.push(m.text());
  });
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  // broken static assets count as errors; API error statuses are part of the tested flows
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/api/")) page.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return page;
}
const close = (page) => page.context().close();
function noErrors(page, where = "") {
  assert(!page.errors.length, `console errors${where ? " on " + where : ""}:\n${page.errors.slice(0, 5).join("\n")}`);
}
async function noOverflow(page, where) {
  const d = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(d <= 0, `horizontal overflow of ${d}px on ${where}`);
}
const visible = (page, sel) => page.locator(sel).first().isVisible();
async function waitFor(page, fn, arg, { timeout = 20000, what = "condition" } = {}) {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 100 }); } catch { throw new Error(`timed out waiting for ${what}`); }
}
const hashIs = (page, hash, timeout = 15000) => waitFor(page, (h) => location.hash === h, hash, { timeout, what: `hash ${hash}` });
const bookShown = (page, title) => waitFor(page, (t) => {
  const v = document.getElementById("view-book");
  const h = v && !v.hidden && v.querySelector("h1");
  return h && (!t || h.textContent.trim() === t);
}, title, { what: `book page${title ? ` "${title}"` : ""}` });
const homeShown = (page) => waitFor(page, () => { const h = document.getElementById("view-home"); return h && !h.hidden && document.getElementById("view-book").hidden; }, null, { what: "home view" });

/** Size of a PNG element screenshot: blank / flat images compress to a few KB. */
async function pngBytes(locator) { return (await locator.screenshot()).length; }

// demo data straight from the repo
const BOOK_IDS = (await readdir(`${ROOT}data/books`)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const BOOKS = Object.fromEntries(await Promise.all(BOOK_IDS.map(async (id) => [id, JSON.parse(await readFile(`${ROOT}data/books/${id}.json`, "utf8"))])));
const CATALOG = JSON.parse(await readFile(`${ROOT}data/catalog.json`, "utf8"));

// ---------------------------------------------------------------------------------------------
// HOME

await check("catalog: data/catalog.json lists every demo book", async () => {
  assert(CATALOG.length === BOOK_IDS.length, `catalog has ${CATALOG.length} books, data/books has ${BOOK_IDS.length} (run npm run build:catalog)`);
  for (const id of BOOK_IDS) assert(CATALOG.some((e) => e.id === id), `${id} missing from catalog`);
});

await check("home: starfield, hero, search and the 3D ring of catalog covers", async () => {
  const page = await open("", { lang: "ru" });
  assert(await visible(page, "#view-home"), "home view hidden");
  const h1 = (await page.locator("#home-title").textContent()).replace(/\s+/g, " ").trim();
  assert(/Войди внутрь/.test(h1), `unexpected hero title "${h1}"`);
  assert(await visible(page, "#search-input"), "search input not visible");
  const stars = await page.evaluate(() => {
    const c = document.getElementById("starfield");
    if (!c || !c.width || !c.height) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  });
  assert(stars > 20, `starfield looks empty (${stars} lit samples)`);
  await waitFor(page, () => document.querySelectorAll("#ring .ring-card[aria-label]").length >= 8, null, { what: "ring covers" });
  const labels = await page.$$eval("#ring .ring-card[aria-label]", (els) => els.map((e) => e.getAttribute("aria-label")));
  const titles = CATALOG.map((e) => e.title.ru);
  const known = labels.filter((l) => titles.some((t) => l.startsWith(t)));
  assert(known.length >= 8, `ring shows ${known.length} catalog covers: ${labels.slice(0, 4).join(" | ")}`);
  assert(await page.locator("#ring .ring-face svg").count() >= 8, "ring covers have no SVG art");
  await noOverflow(page, "home 1440");
  await shot(page, "home-1440");
  noErrors(page, "home");
  await close(page);
});

await check("home: suggestions while typing, keyboard Enter opens the book", async () => {
  const page = await open("", { lang: "ru" });
  await page.fill("#search-input", "принц");
  await waitFor(page, () => { const l = document.getElementById("search-suggest"); return l && !l.hidden && /Маленький принц/.test(l.querySelector('[role="option"]')?.textContent || ""); }, null, { what: "suggestion for «принц»" });
  const first = (await page.locator('#search-suggest [role="option"]').first().textContent()).replace(/\s+/g, " ");
  assert(/Маленький принц/.test(first), `first suggestion is "${first.trim()}"`);
  assert(await page.locator("#search-suggest mark").count() > 0, "matched part is not highlighted");
  await shot(page, "home-suggest");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await hashIs(page, "#/book/little-prince");
  await bookShown(page, "Маленький принц");
  noErrors(page, "search → book");
  await close(page);
});

await check("home: typo search via the submit button finds the demo book", async () => {
  const page = await open("", { lang: "en" });
  await page.fill("#search-input", "hobit");
  await page.click(".search-go");
  await hashIs(page, "#/book/the-hobbit");
  await bookShown(page);
  noErrors(page);
  await close(page);
});

await check("home: unknown book in demo mode shows the demo notice", async () => {
  const page = await open("", { lang: "en" });
  await page.fill("#search-input", "Qwzx Plorb Unknown");
  await page.click(".search-go");
  await waitFor(page, () => document.querySelector(".modal"), null, { what: "demo notice modal" });
  const text = await page.locator(".modal").textContent();
  assert(text.length > 40, "demo notice is empty");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".modal"), null, { what: "modal to close" });
  assert(await visible(page, "#view-home"), "home not visible after closing the notice");
  noErrors(page);
  await close(page);
});

await check("home: a ring card opens its book", async () => {
  const page = await open("", { lang: "en" });
  await waitFor(page, () => document.querySelector('#ring .ring-card[tabindex="0"][aria-label]'), null, { what: "centre ring card" });
  await page.waitForTimeout(800);
  const card = page.locator('#ring .ring-card[tabindex="0"]');
  const box = await card.boundingBox();
  assert(box && box.width > 40, "centre card has no size");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await waitFor(page, () => /^#\/book\/[a-z0-9-]+$/.test(location.hash), null, { what: "book route after card click" });
  const id = await page.evaluate(() => location.hash.split("/").pop());
  assert(BOOK_IDS.includes(id), `card opened unknown id ${id}`);
  await bookShown(page, BOOKS[id].i18n.en.title);
  noErrors(page, "ring → book");
  await close(page);
});

await check("home: keyboard on the ring (arrows + Enter)", async () => {
  const page = await open("", { lang: "en" });
  await waitFor(page, () => document.querySelector('#ring .ring-card[tabindex="0"][aria-label]'), null, { what: "centre ring card" });
  await page.focus('#ring .ring-card[tabindex="0"]');
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  await page.keyboard.press("Enter");
  await waitFor(page, () => /^#\/book\//.test(location.hash), null, { what: "book route after Enter" });
  await bookShown(page);
  noErrors(page);
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// BOOK PAGE

await check("book: every section of a demo book renders", async () => {
  const page = await open("#/book/little-prince", { lang: "ru" });
  const raw = BOOKS["little-prince"];
  await bookShown(page, raw.i18n.ru.title);
  const counts = await page.evaluate(() => ({
    summary: document.querySelectorAll("#bk-summary p").length,
    terms: document.querySelectorAll("#bk-terms li, #bk-terms dt").length,
    chars: document.querySelectorAll("#bk-characters .bk-char").length,
    similar: document.querySelectorAll("#bk-similar li").length,
    play: document.querySelectorAll("#bk-film .bk-play").length,
    scenes: document.querySelectorAll("#bk-film .bk-scene").length,
    tabs: document.querySelectorAll(".bk-tabs a, .bk-tabs button").length,
    cover: document.querySelectorAll(".bk-hero svg").length,
  }));
  assert(counts.summary >= raw.i18n.ru.summary.length, `summary paragraphs: ${counts.summary}`);
  assert(counts.terms >= Math.min(6, raw.i18n.ru.terms.length), `terms: ${counts.terms}`);
  assert(counts.chars === raw.characters.length, `characters: ${counts.chars} of ${raw.characters.length}`);
  assert(counts.similar >= raw.i18n.ru.similar.length, `similar: ${counts.similar}`);
  assert(counts.play === 1, "no film play button");
  assert(counts.scenes === raw.film.scenes.length, `scene list: ${counts.scenes}`);
  assert(counts.tabs >= 5, `section tabs: ${counts.tabs}`);
  assert(counts.cover >= 1, "hero cover missing");
  assert((await page.title()).includes(raw.i18n.ru.title), "document title not updated");
  // a tab jumps to its section
  await page.locator(".bk-tabs >> text=Персонажи").first().click();
  await waitFor(page, () => { const t = document.getElementById("bk-characters").getBoundingClientRect().top; return t > -50 && t < 400; }, null, { timeout: 8000, what: "the characters tab to scroll to its section" });
  await noOverflow(page, "book 1440");
  noErrors(page, "book page");
  await close(page);
});

await check("book: voxel portraits render for every character of every demo book", async () => {
  const page = await open("", { lang: "en", width: 1280, height: 900 });
  const report = [];
  for (const id of BOOK_IDS) {
    const raw = BOOKS[id];
    await page.evaluate((h) => { location.hash = h; }, `#/book/${id}`);
    await bookShown(page, raw.i18n.en.title);
    const n = raw.characters.length;
    await waitFor(page, (k) => document.querySelectorAll("#bk-characters .bk-char-stage").length === k, n, { what: `${id}: ${n} character cards` });
    // walk down the grid so lazy portraits start
    for (let k = 0; k < n; k += 2) {
      await page.evaluate((k) => document.querySelectorAll("#bk-characters .bk-char-stage")[k]?.scrollIntoView({ block: "center" }), k);
      await page.waitForTimeout(150);
    }
    await waitFor(page, () => [...document.querySelectorAll("#bk-characters .bk-char-stage")].every((s) => s.classList.contains("is-ready")), null, { timeout: 90000, what: `${id}: all portraits ready` });
    const bad = await page.evaluate(() => [...document.querySelectorAll("#bk-characters .bk-char")].filter((c) => {
      const img = c.querySelector(".bk-char-img");
      return c.querySelector(".is-fallback") || !img || !img.naturalWidth || !img.src.startsWith("data:image/png");
    }).map((c) => c.querySelector(".bk-char-name")?.textContent.trim()));
    assert(!bad.length, `${id}: portraits missing for ${bad.join(", ")}`);
    report.push(`${id}:${n}`);
  }
  noErrors(page, "portrait loop");
  console.log(`      ${report.join("  ")}`);
  await close(page);
});

await check("book: 3D character viewer modal (render, next, close, dispose)", async () => {
  const page = await open("#/book/alice-in-wonderland", { lang: "uk" });
  const raw = BOOKS["alice-in-wonderland"];
  await bookShown(page, raw.i18n.uk.title);
  await page.locator("#bk-characters .bk-char-open").first().click();
  await waitFor(page, () => document.querySelector(".bk-modal-char canvas"), null, { timeout: 45000, what: "viewer canvas" });
  await page.waitForTimeout(1500);
  const firstName = await page.locator(".bk-cm-name").textContent();
  assert(firstName.trim() === raw.i18n.uk.characters[raw.characters[0].id].name, `modal shows "${firstName}"`);
  const bytes = await pngBytes(page.locator(".bk-cm-viewer"));
  assert(bytes > 30000, `viewer looks blank (${bytes} bytes)`);
  // drag to rotate
  const box = await page.locator(".bk-cm-viewer canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await shot(page, "viewer-modal");
  await page.locator(".bk-cm-arrow").last().click();
  await page.waitForTimeout(600);
  const second = await page.locator(".bk-cm-name").textContent();
  assert(second.trim() === raw.i18n.uk.characters[raw.characters[1].id].name, `next shows "${second}"`);
  // AI portrait is a premium feature: without keys it explains itself
  await page.locator(".bk-ai-btn").click();
  await waitFor(page, () => document.querySelector(".bk-ai:not([hidden]) .bk-ai-off, .bk-ai:not([hidden]) .bk-ai-error"), null, { what: "AI portrait notice" });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".bk-modal-char"), null, { what: "modal closed" });
  assert(!(await page.locator(".bk-cm-viewer canvas").count()), "viewer canvas left behind");
  const focused = await page.evaluate(() => document.activeElement?.className || "");
  assert(/bk-char-open/.test(focused), `focus did not return to the card (${focused})`);
  noErrors(page, "viewer");
  await close(page);
});

await check("book: the mini-film plays (scenes, subtitles, pause, restart, end)", async () => {
  const page = await open("#/book/little-prince", { lang: "en" });
  const raw = BOOKS["little-prince"];
  await bookShown(page, raw.i18n.en.title);
  await page.evaluate(() => document.getElementById("bk-film").scrollIntoView());
  await page.locator("#bk-film .bk-play").click();
  await waitFor(page, () => document.querySelector("#bk-film .bk-stage.is-playing canvas.btf-canvas"), null, { timeout: 30000, what: "film canvas" });
  await waitFor(page, () => { const s = document.querySelector(".btf-sub.is-on .btf-txt"); return s && s.textContent.trim().length > 5; }, null, { timeout: 30000, what: "intro subtitles" });
  await shot(page, "film-intro");
  const sizes = [];
  const subs = new Set();
  for (const n of [0, 2, 4]) {
    await page.locator("#bk-film .bk-scene").nth(n).click();
    await waitFor(page, (n) => document.querySelectorAll("#bk-film .bk-scene")[n]?.classList.contains("is-current"), n, { what: `scene ${n + 1} current` });
    await waitFor(page, () => { const s = document.querySelector(".btf-sub.is-on .btf-txt"); return s && s.textContent.trim().length > 5; }, null, { timeout: 15000, what: `scene ${n + 1} subtitles` });
    await page.waitForTimeout(2500);
    subs.add((await page.locator(".btf-sub .btf-txt").textContent()).trim());
    const now = await page.locator(".bk-hud-now").textContent();
    assert(now.includes(String(n + 1).padStart(2, "0")), `HUD shows "${now}" for scene ${n + 1}`);
    sizes.push(await pngBytes(page.locator("#bk-film .bk-stage")));
    await shot(page, `film-scene-${n + 1}`);
  }
  assert(sizes.every((b) => b > 40000), `a scene looks blank: ${sizes.join(", ")} bytes`);
  assert(subs.size >= 2, "subtitles did not change between scenes");
  // pause: the progress stops (moving the pointer over the stage wakes the auto-hiding HUD)
  const hud = async (sel) => { await page.hover("#bk-film .bk-stage"); await page.locator(`.bk-hud ${sel}`).click(); };
  await hud(".is-pp");
  await waitFor(page, () => document.querySelector("#bk-film .bk-stage.is-paused"), null, { what: "paused state" });
  const p1 = await page.evaluate(() => document.querySelector(".btf-dot.is-cur i")?.style.transform || "");
  await page.waitForTimeout(1500);
  const p2 = await page.evaluate(() => document.querySelector(".btf-dot.is-cur i")?.style.transform || "");
  assert(p1 === p2, `film kept running while paused (${p1} → ${p2})`);
  // resume
  await hud(".is-pp");
  await waitFor(page, () => !document.querySelector("#bk-film .bk-stage.is-paused"), null, { what: "playing again" });
  // restart → back to the intro (no scene progress)
  await hud(".is-restart");
  await waitFor(page, () => !document.querySelector(".btf-dot.is-past"), null, { what: "restart to intro" });
  // jump to the last scene and let the film end
  await page.locator("#bk-film .bk-scene").last().click();
  await waitFor(page, () => { const e = document.querySelector("#bk-film .bk-end"); return e && !e.hidden; }, null, { timeout: 90000, what: "end screen" });
  await shot(page, "film-end");
  await page.locator(".bk-replay").click();
  await waitFor(page, () => document.querySelector("#bk-film .bk-end")?.hidden, null, { what: "replay hides end screen" });
  noErrors(page, "film");
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// LANGUAGES, ROUTES, NAVIGATION

await check("i18n: RU/UA/EN switch on home", async () => {
  const page = await open("", { lang: "ru" });
  for (const lang of ["uk", "en", "ru"]) {
    await page.click(`.lang-switch [data-lang="${lang}"]`);
    await waitFor(page, (l) => document.documentElement.lang === l, lang, { what: `<html lang=${lang}>` });
    const want = await page.evaluate(async (l) => (await import("/js/i18n.js")).STRINGS[l]["home.h1a"], lang);
    const got = (await page.locator("#home-title .l1").textContent()).trim();
    assert(got === want, `${lang}: hero says "${got}", expected "${want}"`);
    const ph = await page.getAttribute("#search-input", "placeholder");
    assert(ph && ph.length > 3, `${lang}: empty placeholder`);
    const pressed = await page.getAttribute(`.lang-switch [data-lang="${lang}"]`, "aria-pressed");
    assert(pressed === "true", `${lang}: button not pressed`);
    await waitFor(page, (t) => [...document.querySelectorAll("#ring .ring-card[aria-label]")].some((c) => t.some((x) => c.getAttribute("aria-label").startsWith(x))), CATALOG.map((e) => e.title[lang]), { what: `${lang} ring titles` });
  }
  assert(await page.evaluate(() => localStorage.getItem("bt-lang")) === "ru", "language not persisted");
  noErrors(page, "home language switch");
  await close(page);
});

await check("i18n: RU/UA/EN switch on a book page keeps the book", async () => {
  const page = await open("#/book/three-musketeers", { lang: "ru" });
  const raw = BOOKS["three-musketeers"];
  await bookShown(page, raw.i18n.ru.title);
  for (const lang of ["uk", "en"]) {
    await page.click(`.lang-switch [data-lang="${lang}"]`);
    await bookShown(page, raw.i18n[lang].title);
    assert(await page.evaluate(() => location.hash) === "#/book/three-musketeers", "route changed on language switch");
    const name = raw.i18n[lang].characters[raw.characters[0].id].name;
    await waitFor(page, (n) => [...document.querySelectorAll("#bk-characters .bk-char-name")].some((e) => e.textContent.trim() === n), name, { what: `${lang} character names` });
    const term = raw.i18n[lang].terms[0].term;
    assert(await page.locator(`#bk-terms >> text=${term}`).count() > 0, `${lang}: term "${term}" missing`);
  }
  noErrors(page, "book language switch");
  await close(page);
});

await check("routes: #/how, #/library, #/premium open as modals and close", async () => {
  const page = await open("", { lang: "en" });
  for (const r of ["how", "library", "premium"]) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, r);
    await waitFor(page, () => document.querySelector(".modal"), null, { what: `${r} modal` });
    await page.waitForTimeout(500);
    const text = (await page.locator(".modal").textContent()).trim();
    assert(text.length > 60, `${r}: modal is nearly empty`);
    await shot(page, `modal-${r}`);
    await page.keyboard.press("Escape");
    await waitFor(page, () => !document.querySelector(".modal"), null, { what: `${r} modal closed` });
    assert(!/how|library|premium/.test(await page.evaluate(() => location.hash)), `${r}: hash kept after closing`);
  }
  // nav links + library → book
  await page.click('#nav-links a[href="#/library"]');
  await waitFor(page, () => document.querySelectorAll(".modal .bt-card").length >= 12, null, { what: "library grid" });
  await page.locator(".modal .bt-card").nth(3).click();
  await waitFor(page, () => /^#\/book\//.test(location.hash), null, { what: "book from library" });
  await bookShown(page);
  await page.click('#nav-links a[href="#/how"]');
  await waitFor(page, () => document.querySelector(".modal"), null, { what: "how modal over a book" });
  await page.click(".modal-close");
  await waitFor(page, () => !document.querySelector(".modal"), null, { what: "closed via ×" });
  assert(await visible(page, "#view-book"), "book page lost after closing a modal");
  noErrors(page, "routes");
  await close(page);
});

await check("navigation: back / forward between home and books", async () => {
  const page = await open("", { lang: "en" });
  await page.fill("#search-input", "gatsby");
  await page.keyboard.press("Enter");
  await hashIs(page, "#/book/the-great-gatsby");
  await bookShown(page);
  await page.evaluate(() => { location.hash = "#/book/treasure-island"; });
  await bookShown(page, BOOKS["treasure-island"].i18n.en.title);
  await page.goBack();
  await bookShown(page, BOOKS["the-great-gatsby"].i18n.en.title);
  await page.goBack();
  await homeShown(page);
  await page.goForward();
  await bookShown(page, BOOKS["the-great-gatsby"].i18n.en.title);
  // the page's own Back button
  await page.locator(".bk-back, .bk-hero button:has-text('Back')").first().click();
  await homeShown(page);
  // direct link + unknown id
  await page.evaluate(() => { location.hash = "#/book/no-such-book"; });
  await homeShown(page);
  noErrors(page, "navigation");
  await close(page);
});

await check("reduced motion: home and book work without animation", async () => {
  const page = await open("#/book/the-hobbit", { lang: "en", reducedMotion: "reduce" });
  await bookShown(page);
  await page.evaluate(() => { location.hash = "#/"; });
  await homeShown(page);
  await waitFor(page, () => document.querySelectorAll("#ring .ring-card[aria-label]").length >= 8, null, { what: "ring" });
  noErrors(page, "reduced motion");
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// MOBILE

for (const [w, h] of [[390, 844], [320, 640]]) {
  await check(`mobile ${w}px: home, book page and modals fit without horizontal scroll`, async () => {
    const page = await open("", { lang: "uk", width: w, height: h, dpr: 2, mobile: true });
    await waitFor(page, () => document.querySelectorAll("#ring .ring-card[aria-label]").length >= 5, null, { what: "ring" });
    await noOverflow(page, `home ${w}`);
    assert(await visible(page, ".lang-switch"), "language switch hidden on mobile");
    const sb = await page.locator(".search-go").boundingBox();
    assert(sb && sb.x + sb.width <= w + 0.5, "search button sticks out");
    await shot(page, `mobile-${w}-home`);
    // compact menu replaces the nav links
    assert(!(await visible(page, "#nav-links")), "nav links should be folded into the menu");
    await page.locator("#nav-menu").tap();
    await waitFor(page, () => getComputedStyle(document.getElementById("nav-links")).display !== "none", null, { what: "menu dropdown" });
    const dd = await page.locator("#nav-links").boundingBox();
    assert(dd && dd.x >= 0 && dd.x + dd.width <= w + 0.5, "menu dropdown sticks out");
    await page.locator('#nav-links a[href="#/how"]').tap();
    await waitFor(page, () => document.querySelector(".modal") && !document.getElementById("nav").classList.contains("is-open"), null, { what: "how modal from the menu" });
    await page.keyboard.press("Escape");
    await waitFor(page, () => !document.querySelector(".modal"), null, { what: "modal closed" });
    await page.locator("#search-input").tap();
    await page.fill("#search-input", "аліса");
    await waitFor(page, () => document.querySelector('#search-suggest [role="option"]'), null, { what: "suggestions" });
    await noOverflow(page, `suggestions ${w}`);
    await page.locator('#search-suggest [role="option"]').first().tap();
    await bookShown(page, BOOKS["alice-in-wonderland"].i18n.uk.title);
    for (const s of ["summary", "terms", "characters", "similar", "film"]) {
      await page.evaluate((s) => document.getElementById(`bk-${s}`).scrollIntoView(), s);
      await page.waitForTimeout(300);
      await noOverflow(page, `book ${s} ${w}`);
    }
    await page.locator("#bk-characters .bk-char-open").first().tap();
    await waitFor(page, () => document.querySelector(".bk-modal-char canvas, .bk-modal-char img"), null, { what: "viewer on mobile" });
    await page.waitForTimeout(800);
    const mb = await page.locator(".bk-modal-char").boundingBox();
    assert(mb && mb.x >= -0.5 && mb.x + mb.width <= w + 0.5, "character modal wider than the screen");
    await shot(page, `mobile-${w}-viewer`);
    await page.locator(".bk-modal-char .modal-close").tap();
    await page.evaluate(() => { location.hash = "#/premium"; });
    await waitFor(page, () => document.querySelector(".modal"), null, { what: "premium modal" });
    await noOverflow(page, `premium ${w}`);
    await page.keyboard.press("Escape");
    noErrors(page, `mobile ${w}`);
    await close(page);
  });
}

await check("wide 2560px: home and book page without horizontal scroll", async () => {
  const page = await open("", { lang: "en", width: 2560, height: 1440 });
  await waitFor(page, () => document.querySelectorAll("#ring .ring-card[aria-label]").length >= 8, null, { what: "ring" });
  await noOverflow(page, "home 2560");
  await page.evaluate(() => { location.hash = "#/book/pride-and-prejudice"; });
  await bookShown(page);
  await noOverflow(page, "book 2560");
  noErrors(page, "2560");
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// LIVE MODE (mocked API)

const TI = BOOKS["treasure-island"];
const look = (i) => TI.characters[i].appearance;
const LIVE_ID = "clockwork-lighthouse";
const XSS = '<img src=x onerror="window.__xss=1">';
const FIX = {
  health: { live: true, portraits: true, video: false, premiumCodeRequired: true, model: "claude-opus-5-5" },
  resolve: {
    found: true, id: LIVE_ID, title: "Заводной маяк", originalTitle: "The Clockwork Lighthouse", author: "Мира Холт", year: 2019,
    genre: "Сказочная повесть", tagline: `Маяк, который считал волны ${XSS}`, cover: { bg: "#12324a", bg2: "#081522", fg: "#f3e6c0", accent: "#ffb347", motif: "lantern" },
  },
  overview: {
    summary: [1, 2, 3, 4].map((n) => `Абзац ${n}: смотритель маяка Ян находит в башне заводной механизм, который считает волны и помнит каждый корабль. ${n === 2 ? XSS : ""} Вместе с дочерью рыбака Илкой он чинит маяк перед большим штормом, спорит с жадным судовладельцем и узнаёт, что механизм собрал его пропавший отец.`),
    themes: ["Память", "Дом", "Смелость"],
    terms: [["Маяк", "Башня на скале."], ["Механизм", "Сердце маяка."], ["Шторм", "Буря века."], ["Шхуна", "Корабль Илки."], ["Журнал", "Записи отца."], ["Фонарь", "Свет маяка."]].map(([term, definition]) => ({ term, definition })),
    similar: [["Остров сокровищ", "Р. Л. Стивенсон"], ["Хроники Нарнии", "К. С. Льюис"], ["Дом у моря", "А. Грин"], ["Коралина", "Н. Гейман"]].map(([title, author]) => ({ title, author, why: "Тоже про путешествие и смелость." })),
  },
  characters: {
    characters: [
      ["yan", "Ян", "protagonist", 0], ["ilka", "Илка", "protagonist", 1], ["gorm", "Горм", "antagonist", 2], ["owl", "Сова Ада", "supporting", 3],
    ].map(([id, name, role, i]) => ({ id, name, role, traits: ["смелый", "упорный", "добрый"], description: `${name} — герой истории. ${id === "gorm" ? XSS : ""}`, appearance: look(i), portraitPrompt: `A voxel ${id}`, portraitToken: `tok-${id}` })),
  },
  film: {
    title: "Ночь большого шторма", intro: "Вы открываете книгу — и солёный ветер бьёт в лицо.", outro: "Страницы закрываются, но вы всё ещё слышите прибой.",
    scenes: [
      { title: "Башня", setting: "island", time: "dusk", weather: "wind", cast: ["yan"], props: ["tower", "rock"], action: "discover", camera: "orbit", mood: "mysterious", narration: "Вы стоите у подножия маяка, и ветер треплет плащ Яна.", line: { speaker: "yan", text: "Он снова тикает!" } },
      { title: "Механизм", setting: "room", time: "night", weather: "clear", cast: ["yan", "ilka"], props: ["clock", "lamp"], action: "talk", camera: "close_up", mood: "magical", narration: "Шестерёнки светятся, а Илка держит фонарь.", line: null },
      { title: "Судовладелец", setting: "street", time: "day", weather: "fog", cast: ["gorm", "yan"], props: ["barrel"], action: "fight", camera: "pan", mood: "tense", narration: "Горм требует продать маяк.", line: { speaker: "gorm", text: "Маяк будет моим." } },
      { title: "Шторм", setting: "sea", time: "night", weather: "rain", cast: ["ilka", "owl"], props: ["ship"], action: "chase", camera: "fly_over", mood: "epic", narration: "Волны выше мачт, свет маяка ведёт шхуну.", line: null },
      { title: "Рассвет", setting: "island", time: "dawn", weather: "clear", cast: ["yan", "ilka", "owl"], props: ["tower"], action: "celebrate", camera: "crane", mood: "joyful", narration: "Шторм уходит, и маяк снова тикает спокойно.", line: { speaker: "owl", text: "Дом там, где горит свет." } },
    ],
    videoPrompts: ["A lighthouse in a storm", "Clockwork gears glowing", "Dawn over a calm sea"],
    videoToken: "vtok",
  },
};
// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** page.route fixtures; `fail` = { part: [status, …] } answers with errors first. Records every API call. */
function liveRoutes({ fail = {}, calls = [] } = {}) {
  const left = Object.fromEntries(Object.entries(fail).map(([k, v]) => [k, [...v]]));
  return async (context) => {
    await context.route(/\/api\/(health|resolve|overview|characters|film|portrait|video)(\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      const part = url.pathname.split("/").pop();
      calls.push(part + url.search);
      const err = left[part]?.shift();
      if (err) {
        const codes = { 429: "rate_limited", 502: "upstream", 503: "not_configured", 500: "server" };
        return route.fulfill({ status: err, contentType: "application/json", headers: { "cache-control": "no-store", ...(err === 429 ? { "retry-after": "30" } : {}) }, body: JSON.stringify({ error: codes[err] || "upstream", message: `mock ${err}` }) });
      }
      if (part === "portrait") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      const body = FIX[part];
      if (!body) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found","message":"mock"}' });
      await sleep(part === "health" ? 0 : 250);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
  };
}

await check("live (mocked): search → resolve → overview, characters, film stream in", async () => {
  const calls = [];
  const page = await open("", { lang: "ru", routes: liveRoutes({ calls }) });
  await page.fill("#search-input", "заводной маяк холт");
  await page.click(".search-go");
  await waitFor(page, () => document.querySelector(".bt-loading"), null, { what: "loading overlay" });
  await shot(page, "live-loading");
  await hashIs(page, `#/book/${LIVE_ID}`);
  await bookShown(page, FIX.resolve.title);
  await waitFor(page, () => document.querySelectorAll("#bk-summary p").length >= 4, null, { what: "live summary" });
  await waitFor(page, (n) => document.querySelectorAll("#bk-characters .bk-char").length === n, FIX.characters.characters.length, { what: "live characters" });
  await waitFor(page, () => document.querySelector("#bk-film .bk-play"), null, { what: "live film poster" });
  for (const p of ["resolve", "overview", "characters", "film"]) assert(calls.some((c) => c.startsWith(p + "?")), `no /api/${p} call`);
  const filmCall = calls.find((c) => c.startsWith("film?"));
  assert(/cast=/.test(filmCall) && decodeURIComponent(filmCall).includes("yan:Ян"), `film call without cast: ${filmCall}`);
  // AI text is escaped everywhere
  const xss = await page.evaluate(() => ({ flag: window.__xss === 1, img: document.querySelectorAll('img[src="x"]').length, text: document.body.textContent.includes("onerror") }));
  assert(!xss.flag && !xss.img, "AI text was injected as HTML");
  assert(xss.text, "escaped AI text should still be visible as text");
  // portraits from the voxel engine + an AI portrait from the (mocked) image endpoint
  await page.evaluate(() => document.getElementById("bk-characters").scrollIntoView());
  await waitFor(page, () => [...document.querySelectorAll("#bk-characters .bk-char-stage")].every((s) => s.classList.contains("is-ready")), null, { timeout: 60000, what: "live portraits" });
  await page.locator("#bk-characters .bk-char-open").first().click();
  await page.locator(".bk-ai-btn").click();
  await waitFor(page, () => document.querySelector(".bk-ai-img"), null, { what: "AI portrait image" });
  const pcall = calls.find((c) => c.startsWith("portrait?"));
  assert(pcall && /token=tok-yan/.test(pcall) && /prompt=/.test(pcall), `portrait call: ${pcall}`);
  await page.keyboard.press("Escape");
  // the film plays with the live cast
  await page.evaluate(() => document.getElementById("bk-film").scrollIntoView());
  await page.locator("#bk-film .bk-scene").nth(1).click();
  await waitFor(page, () => { const s = document.querySelector(".btf-sub.is-on .btf-txt"); return s && s.textContent.trim().length > 5; }, null, { timeout: 30000, what: "live film subtitles" });
  await shot(page, "live-film");
  // reload: everything comes from the cache, no new text calls
  const before = calls.length;
  await page.reload({ waitUntil: "networkidle" });
  await bookShown(page, FIX.resolve.title);
  await waitFor(page, () => document.querySelectorAll("#bk-summary p").length >= 4 && document.querySelector("#bk-film .bk-play"), null, { what: "cached live book" });
  const again = calls.slice(before).filter((c) => /^(overview|characters|film|resolve)\?/.test(c));
  assert(!again.length, `reload hit the API again: ${again.join(", ")}`);
  noErrors(page, "live flow");
  await close(page);
});

await check("live (mocked): a failed part shows an error + Retry, errors are not cached", async () => {
  const calls = [];
  const page = await open("", { lang: "en", routes: liveRoutes({ calls, fail: { overview: [502], film: [429] } }) });
  await page.fill("#search-input", "the clockwork lighthouse");
  await page.click(".search-go");
  await bookShown(page);
  await waitFor(page, () => document.querySelector("#bk-summary .bk-retry"), null, { what: "overview error with Retry" });
  await waitFor(page, () => document.querySelector("#bk-film .bk-retry"), null, { what: "film error with Retry" });
  await waitFor(page, () => document.querySelectorAll("#bk-characters .bk-char").length === 4, null, { what: "characters despite errors" });
  await waitFor(page, () => document.querySelector(".toast.is-error, .toast.is-on, .toast.show, .toast[data-show]") || document.getElementById("toast").textContent.trim(), null, { what: "error toast" });
  await shot(page, "live-error");
  const cached = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("bt-cache:")));
  assert(!cached.some((k) => /:overview$|:film$/.test(k)), `failed parts were cached: ${cached.join(", ")}`);
  await page.locator("#bk-summary .bk-retry").click();
  await waitFor(page, () => document.querySelectorAll("#bk-summary p").length >= 4, null, { what: "overview after retry" });
  await page.locator("#bk-film .bk-retry").click();
  await waitFor(page, () => document.querySelector("#bk-film .bk-play"), null, { what: "film after retry" });
  assert(calls.filter((c) => c.startsWith("overview?")).length === 2, "overview should be requested exactly twice");
  noErrors(page, "live errors");
  await close(page);
});

await check("live (mocked): resolver errors and 'not found' are handled", async () => {
  const calls = [];
  const page = await open("", { lang: "en", routes: liveRoutes({ calls, fail: { resolve: [429] } }) });
  await page.fill("#search-input", "some rare novel");
  await page.click(".search-go");
  await waitFor(page, () => document.getElementById("toast").textContent.trim().length > 5, null, { what: "rate-limit toast" });
  assert(await visible(page, "#view-home"), "home should stay after a failed search");
  await waitFor(page, () => !document.querySelector(".bt-loading"), null, { timeout: 5000, what: "loading overlay to close" });
  // not found → "did you mean"
  await page.unroute(/\/api\/resolve/).catch(() => {});
  await page.route(/\/api\/resolve/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ found: false, suggestions: [{ title: "The Lighthouse Keeper", author: "Someone" }] }) }));
  await page.fill("#search-input", "zzzz unknown");
  await page.click(".search-go");
  await waitFor(page, () => /Lighthouse Keeper/.test(document.getElementById("search-suggest")?.textContent || "") || document.querySelector(".modal"), null, { what: "did-you-mean suggestions" });
  // cancel a slow search
  await page.unroute(/\/api\/resolve/);
  await page.route(/\/api\/resolve/, async (r) => { await sleep(8000); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX.resolve) }).catch(() => {}); });
  await page.fill("#search-input", "slow book");
  await page.click(".search-go");
  await waitFor(page, () => document.querySelector(".bt-loading .bt-ld-cancel"), null, { what: "loading overlay" });
  await page.locator(".bt-ld-cancel").click();
  await waitFor(page, () => !document.querySelector(".bt-loading:not(.is-closing)"), null, { what: "overlay closed" });
  await page.waitForTimeout(300);
  assert(await visible(page, "#view-home"), "home should stay after cancelling");
  noErrors(page, "resolver errors");
  await close(page);
});

// ---------------------------------------------------------------------------------------------

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
