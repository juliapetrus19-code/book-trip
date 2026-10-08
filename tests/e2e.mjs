// End-to-end checks for BookTrip in headless Chromium (software WebGL).
//
//   NODE_PATH=$(npm root -g) node tests/e2e.mjs [--base http://localhost:5600/] [--only home,live] [--shots] [--all-books]
//
// Starts tests/dev-server.mjs when nothing answers at --base. Prints PASS/FAIL per check and exits
// with code 1 when any check fails. --shots saves screenshots of the key states to shots/e2e/.
// The LIVE flow is fully mocked with page.route fixtures, so no API keys are needed.
// The PAYWALL checks start their own dev server (port of --base + 7) with test billing env vars and
// mock Paddle.js. Loops over demo books sample a few of them unless --all-books is given.
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
const ALL_BOOKS = Boolean(arg("all-books", false));
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

/**
 * New page with fonts routed, console errors collected and the UI language preset (lang: null keeps
 * the browser default, `locale` sets navigator.language). Service workers are blocked unless `sw`.
 */
async function open(path = "", { width = 1440, height = 900, dpr = 1, mobile = false, lang = "ru", routes = null, reducedMotion = "no-preference", base = BASE, locale = "en-US", sw = false, look = "3d" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile, reducedMotion, locale, serviceWorkers: sw ? "allow" : "block" });
  await routeFonts(context);
  if (routes) await routes(context);
  // The 3D look is the deterministic baseline; the anime look has its own check (images are mocked there).
  await context.addInitScript((v) => { try { localStorage.setItem("bt-look", v); } catch { /* ignore */ } }, look);
  if (lang) await context.addInitScript((l) => { try { if (!sessionStorage.getItem("e2e-init")) { localStorage.setItem("bt-lang", l); sessionStorage.setItem("e2e-init", "1"); } } catch { /* ignore */ } }, lang);
  const page = await context.newPage();
  page.errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebGL|GPU stall|GroupMarkerNotSet|swiftshader|Failed to load resource/i.test(m.text())) page.errors.push(m.text());
  });
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  // broken static assets count as errors; API error statuses are part of the tested flows
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/api/")) page.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + path, { waitUntil: "networkidle" });
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
const pathIs = (page, path, timeout = 15000) => waitFor(page, (p) => location.pathname === p && !location.hash, path, { timeout, what: `path ${path}` });
/** Click an in-app link (exercises the router's link interception, no page load). */
const clickLink = (page, href) => page.evaluate((h) => { const a = document.createElement("a"); a.href = h; a.textContent = "x"; document.body.append(a); a.click(); a.remove(); }, href);
const SAMPLE = (ids, n, always = []) => {
  if (ALL_BOOKS) return ids;
  const rest = ids.filter((id) => !always.includes(id)).sort(() => Math.random() - 0.5);
  return [...always.filter((id) => ids.includes(id)), ...rest].slice(0, n);
};
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
  await pathIs(page, "/book/little-prince");
  await bookShown(page, "Маленький принц");
  noErrors(page, "search → book");
  await close(page);
});

await check("home: typo search via the submit button finds the demo book", async () => {
  const page = await open("", { lang: "en" });
  await page.fill("#search-input", "hobit");
  await page.click(".search-go");
  await pathIs(page, "/book/the-hobbit");
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
  await waitFor(page, () => /^\/book\/[a-z0-9-]+$/.test(location.pathname), null, { what: "book route after card click" });
  const id = await page.evaluate(() => location.pathname.split("/").pop());
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
  await waitFor(page, () => /^\/book\//.test(location.pathname), null, { what: "book route after Enter" });
  await bookShown(page);
  noErrors(page);
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// BOOK PAGE

await check("book: every section of a demo book renders", async () => {
  const page = await open("book/little-prince", { lang: "ru" });
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
  for (const id of SAMPLE(BOOK_IDS, 4, ["little-prince"])) {
    const raw = BOOKS[id];
    await clickLink(page, `/book/${id}`);
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
  const page = await open("book/alice-in-wonderland", { lang: "uk" });
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
  const page = await open("book/little-prince", { lang: "en" });
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
  // the HUD auto-hides after ~2.6 s; a pointer move wakes it, so move onto the button and click at once
  const hud = async (sel) => {
    await page.hover("#bk-film .bk-stage");
    const b = await page.locator(`.bk-hud ${sel}`).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
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
  const page = await open("book/three-musketeers", { lang: "ru" });
  const raw = BOOKS["three-musketeers"];
  await bookShown(page, raw.i18n.ru.title);
  for (const lang of ["uk", "en"]) {
    await page.click(`.lang-switch [data-lang="${lang}"]`);
    await bookShown(page, raw.i18n[lang].title);
    assert(await page.evaluate(() => location.pathname + location.hash) === "/book/three-musketeers", "route changed on language switch");
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
  await waitFor(page, () => /^\/book\//.test(location.pathname) && !location.hash, null, { what: "book from library" });
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
  await pathIs(page, "/book/the-great-gatsby");
  await bookShown(page);
  await clickLink(page, "/book/treasure-island");
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
  // unknown id
  await clickLink(page, "/book/no-such-book");
  await homeShown(page);
  noErrors(page, "navigation");
  await close(page);
});

await check("reduced motion: home and book work without animation", async () => {
  const page = await open("book/the-hobbit", { lang: "en", reducedMotion: "reduce" });
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
  await clickLink(page, "/book/pride-and-prejudice");
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

await check("anime look: drawn portraits fade in, anime film plays, Anime/3D switch", async () => {
  const png = await readFile(new URL("../og.png", import.meta.url));
  let hits = 0;
  const page = await open("book/the-hobbit", { lang: "uk", look: "anime", routes: async (ctx) => {
    await ctx.route("https://image.pollinations.ai/**", (route) => { hits++; route.fulfill({ status: 200, contentType: "image/png", body: png }); });
  } });
  await bookShown(page, BOOKS["the-hobbit"].i18n.uk.title);
  await page.evaluate(() => document.getElementById("bk-characters").scrollIntoView());
  await waitFor(page, () => document.querySelector(".bk-char-stage.is-anime img.bk-char-anime"), null, { timeout: 30000, what: "anime portrait" });
  const btns = await page.locator("#bk-characters .bk-look-btn").allTextContents();
  if (btns.join("|") !== "Аніме|3D") throw new Error(`look switch: ${btns}`);
  await page.evaluate(() => document.getElementById("bk-film").scrollIntoView());
  await waitFor(page, () => document.querySelector("#bk-film .bk-poster.is-anime"), null, { timeout: 30000, what: "anime poster" });
  await page.locator("#bk-film .bk-play").click();
  await waitFor(page, () => document.querySelector("#bk-film .baf-root"), null, { timeout: 20000, what: "anime film" });
  await waitFor(page, () => { const s = document.querySelector(".baf-sub.is-on"); return s && s.textContent.trim().length > 5; }, null, { timeout: 20000, what: "anime subtitles" });
  await page.locator("#bk-film .bk-scene").nth(2).click();
  await waitFor(page, () => document.querySelectorAll("#bk-film .bk-scene")[2]?.classList.contains("is-current"), null, { what: "scene 3 current" });
  await waitFor(page, () => [...document.querySelectorAll(".baf-layer")].some((l) => Number(l.style.opacity) > 0.5), null, { timeout: 20000, what: "visible anime frame" });
  await shot(page, "anime-film");
  if (hits < 3) throw new Error(`only ${hits} image requests`);
  // switch to 3D: the anime film is disposed and the voxel film is offered again
  await page.locator("#bk-film .bk-look-btn").nth(1).click();
  await waitFor(page, () => !document.querySelector(".baf-root") && document.querySelector("#bk-film .bk-play"), null, { what: "3D film after switch" });
  if (await page.evaluate(() => localStorage.getItem("bt-look")) !== "3d") throw new Error("look preference not stored");
  if (page.errors.length) throw new Error(page.errors.join("\n"));
  await close(page);
});

await check("home shelves: book of the day, school curriculum and genre rows open books", async () => {
  const page = await open("", { lang: "uk" });
  await waitFor(page, () => document.querySelector("#home-shelves:not([hidden]) .home-daily .home-daily-title"), null, { what: "book of the day" });
  const shelves = await page.locator(".home-shelf-title").allTextContents();
  if (!shelves.length || !/Шкільна програма/.test(shelves[0])) throw new Error(`shelves: ${shelves}`);
  const school = await page.locator(".home-shelf").first().locator(".bt-card").count();
  if (school < 8) throw new Error(`school shelf has ${school} books`);
  await page.locator(".home-shelf").first().locator(".bt-card").first().click();
  await waitFor(page, () => location.pathname.startsWith("/book/") && document.querySelector(".bk-hero"), null, { what: "book from shelf" });
  if (page.errors.length) throw new Error(page.errors.join("\n"));
  await close(page);
});

await check("quiz: six questions from characters and terms, score and retry", async () => {
  const page = await open("book/the-hobbit", { lang: "uk" });
  await bookShown(page, BOOKS["the-hobbit"].i18n.uk.title);
  await page.locator('.bk-tab[data-target="quiz"]').click();
  await waitFor(page, () => document.querySelector("#bk-quiz .bk-quiz-opt"), null, { what: "quiz options" });
  for (let n = 0; n < 6; n++) {
    await page.locator("#bk-quiz .bk-quiz-opt:not([disabled])").first().click();
    await waitFor(page, () => document.querySelector("#bk-quiz .bk-quiz-opt.is-right"), null, { what: `answer ${n + 1} marked` });
    await page.locator("#bk-quiz .bk-quiz-next").click();
  }
  const big = await page.locator("#bk-quiz .bk-quiz-big").textContent();
  if (!/^\d \/ 6$/.test(big.trim())) throw new Error(`score: ${big}`);
  await page.locator("#bk-quiz .is-result .btn-glow").click();
  await waitFor(page, () => document.querySelector("#bk-quiz .bk-quiz-opt:not([disabled])"), null, { what: "quiz restarted" });
  if (page.errors.length) throw new Error(page.errors.join("\n"));
  await close(page);
});

await check("live (mocked): search → resolve → overview, characters, film stream in", async () => {
  const calls = [];
  const page = await open("", { lang: "ru", routes: liveRoutes({ calls }) });
  await page.fill("#search-input", "заводной маяк холт");
  await page.click(".search-go");
  await waitFor(page, () => document.querySelector(".bt-loading"), null, { what: "loading overlay" });
  await shot(page, "live-loading");
  await pathIs(page, `/book/${LIVE_ID}`);
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
// V2: pretty URLs, router, default language, honest hero, waitlist, sticky tabs, PWA

const STR = await (async () => {
  const src = await readFile(`${ROOT}js/i18n.js`, "utf8");
  const pick = (lang, key) => {
    const block = src.split(new RegExp(`\\n  ${lang}: \\{`)).slice(1).map((b) => b.split(/\n  \},?\n/)[0]);
    for (const b of block.reverse()) {
      const m = new RegExp(`"${key.replace(/[.~]/g, (c) => `\\${c}`)}": "([^"]*)"`).exec(b);
      if (m) return m[1];
    }
    return null;
  };
  return pick;
})();

await check("routes: a direct /book/<id> load renders the book and keeps its URL", async () => {
  const page = await open("book/little-prince", { lang: "en" });
  const raw = BOOKS["little-prince"];
  await bookShown(page, raw.i18n.en.title);
  const info = await page.evaluate(() => ({ path: location.pathname, hash: location.hash, ssr: document.querySelectorAll("#ssr-book").length, title: document.title }));
  assert(info.path === "/book/little-prince" && !info.hash, `URL became ${info.path}${info.hash}`);
  assert(!info.ssr, "server-rendered #ssr-book block was not removed");
  assert(info.title === `${raw.i18n.en.title} — ${raw.i18n.en.author} | BookTrip`, `document.title "${info.title}"`);
  // share uses the canonical book URL
  const share = await page.evaluate(() => { let url = ""; navigator.share = undefined; navigator.clipboard.writeText = async (u) => { url = u; }; document.querySelector(".bk-share").click(); return new Promise((r) => setTimeout(() => r(url), 300)); });
  assert(share === `${new URL(BASE).origin}/book/little-prince`, `share URL ${share}`);
  noErrors(page, "direct book load");
  await close(page);
});

await check("routes: legacy /#/book/<id> becomes /book/<id>", async () => {
  const page = await open("#/book/the-hobbit", { lang: "en" });
  await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
  await pathIs(page, "/book/the-hobbit");
  noErrors(page, "legacy link");
  await close(page);
});

await check("navigation: back/forward across home, books and modals over a book; links never reload", async () => {
  const page = await open("", { lang: "en" });
  await page.evaluate(() => { window.__marker = 42; });
  await clickLink(page, "/book/the-hobbit");
  await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
  await pathIs(page, "/book/the-hobbit");
  await page.click('#nav-links a[href="#/how"]');
  await waitFor(page, () => document.querySelector(".modal") && location.pathname === "/book/the-hobbit" && location.hash === "#/how", null, { what: "how modal over the book" });
  assert(await page.evaluate(() => !document.getElementById("view-book").hidden), "book hidden under the modal");
  await page.goBack();
  await waitFor(page, () => !document.querySelector(".modal-backdrop:not(.is-closing)") && location.hash === "", null, { what: "modal closed by Back" });
  await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
  await page.goForward();
  await waitFor(page, () => document.querySelector(".modal") && location.hash === "#/how", null, { what: "modal again after Forward" });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".modal-backdrop:not(.is-closing)") && location.pathname === "/book/the-hobbit" && !location.hash, null, { what: "Esc closes back to the book URL" });
  await clickLink(page, "/book/little-prince");
  await bookShown(page, BOOKS["little-prince"].i18n.en.title);
  await page.click("a.brand");
  await homeShown(page);
  assert(await page.evaluate(() => location.pathname + location.hash) === "/", "brand link should lead to /");
  await page.goBack();
  await bookShown(page, BOOKS["little-prince"].i18n.en.title);
  await page.goBack();
  await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
  await page.goForward();
  await bookShown(page, BOOKS["little-prince"].i18n.en.title);
  // search from a book page lives on "/" and lands on the book path
  await clickLink(page, "#/q/treasure island");
  await pathIs(page, "/book/treasure-island");
  await bookShown(page, BOOKS["treasure-island"].i18n.en.title);
  assert(await page.evaluate(() => window.__marker) === 42, "an in-app link reloaded the page");
  noErrors(page, "history");
  await close(page);
});

await check("i18n: Ukrainian by default, browser ru/en respected, an explicit choice wins", async () => {
  for (const [locale, want] of [["de-DE", "uk"], ["uk-UA", "uk"], ["ru-RU", "ru"], ["en-GB", "en"]]) {
    const page = await open("", { lang: null, locale });
    await waitFor(page, (l) => document.documentElement.lang === l, want, { what: `${locale} → ${want}` });
    const h1 = (await page.locator("#home-title .l1").textContent()).trim();
    assert(h1 === STR(want, "home.h1a"), `${locale}: hero "${h1}"`);
    noErrors(page, `default language ${locale}`);
    await close(page);
  }
  const page = await open("", { lang: "en", locale: "ru-RU" });
  assert(await page.evaluate(() => document.documentElement.lang) === "en", "stored choice should beat navigator.language");
  await close(page);
  const html = await readFile(`${ROOT}index.html`, "utf8");
  assert(/<html lang="uk">/.test(html), "index.html should default to lang=uk");
});

await check("home: honest hero while the AI is not live, the full promise once it is", async () => {
  const page = await open("", { lang: "uk" });
  const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
  assert(health.live === false, "this check expects a dev server without AI keys");
  const l2 = (await page.locator("#home-title .l2").textContent()).trim();
  assert(l2 === STR("uk", "home.h1b~curated"), `hero promise "${l2}" while not live`);
  assert(!/будь-як/i.test(await page.locator(".hero").textContent()), "hero still promises any book");
  await close(page);
  const live = await open("", { lang: "uk", routes: async (c) => c.route(/\/api\/health$/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...health, live: true }) })) });
  await waitFor(live, (want) => document.querySelector("#home-title .l2").textContent.trim() === want, STR("uk", "home.h1b"), { what: "the live promise" });
  noErrors(live, "live hero");
  await close(live);
});

async function openNotice(page, q = "Qwzx Plorb Unknown") {
  await page.fill("#search-input", q);
  await page.click(".search-go");
  await waitFor(page, () => document.querySelector(".modal .bt-demo"), null, { what: "demo notice" });
}

await check("waitlist: unknown book → contact validation, POST /api/waitlist, success state", async () => {
  const page = await open("", { lang: "en" });
  await openNotice(page);
  await page.fill(".bt-wl input", "ab");
  await page.click(".bt-wl button[type=submit]");
  await waitFor(page, () => document.querySelector(".bt-wl .bt-field-err")?.textContent.trim().length > 5 && document.querySelector('.bt-wl input[aria-invalid="true"]'), null, { what: "inline validation error" });
  const req = page.waitForRequest((r) => r.url().includes("/api/waitlist") && r.method() === "POST");
  await page.fill(".bt-wl input", "@booktrip_reader");
  await page.click(".bt-wl button[type=submit]");
  const body = (await req).postDataJSON();
  assert(body.q === "Qwzx Plorb Unknown" && body.contact === "@booktrip_reader" && body.lang === "en", `waitlist body ${JSON.stringify(body)}`);
  await waitFor(page, () => document.querySelector(".bt-wl.is-done"), null, { what: "waitlist success" });
  await shot(page, "waitlist-done");
  noErrors(page, "waitlist");
  await close(page);
});

await check("demo notice closes when a book opens (route change or a pick)", async () => {
  const page = await open("", { lang: "en" });
  await openNotice(page);
  await page.evaluate(() => { location.hash = "#/book/the-hobbit"; }); // a route change from outside
  await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
  await waitFor(page, () => !document.querySelector(".modal-backdrop:not(.is-closing)"), null, { what: "notice closed after the route change" });
  await page.click("a.brand");
  await homeShown(page);
  await openNotice(page, "Zorbulon Mirth");
  await page.locator(".modal .bt-card").first().click();
  await bookShown(page);
  await waitFor(page, () => !document.querySelector(".modal-backdrop:not(.is-closing)"), null, { what: "notice closed after a pick" });
  noErrors(page, "demo notice");
  await close(page);
});

for (const [w, h] of [[320, 640], [390, 844], [1440, 900], [2560, 1300]]) {
  await check(`book ${w}px: sticky nav + tabs never cover a section heading`, async () => {
    const page = await open("book/little-prince", { lang: "ru", width: w, height: h, mobile: w < 800, dpr: w < 800 ? 2 : 1 });
    await bookShown(page, BOOKS["little-prince"].i18n.ru.title);
    const names = await page.$$eval(".bk-tabs .bk-tab", (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.target));
    assert(names.length >= 5, `tabs: ${names.join(",")}`);
    const bad = [];
    for (const name of names) {
      await page.locator(`.bk-tabs .bk-tab[data-target="${name}"]`).click();
      // wait until the smooth scroll and its settle pass are over
      await page.waitForTimeout(1200); // smooth scroll + the settle pass (software rendering can delay the start)
      await page.evaluate(() => new Promise((r) => { let y = scrollY, n = 0; const t = setInterval(() => { if (Math.abs(scrollY - y) < 1) n++; else n = 0; y = scrollY; if (n >= 12) { clearInterval(t); r(true); } }, 100); setTimeout(() => { clearInterval(t); r(false); }, 15000); }));
      const m = await page.evaluate((name) => {
        const sec = document.getElementById(`bk-${name}`);
        const head = sec.querySelector(".bk-eyebrow") || sec.querySelector("h2");
        const bars = Math.max(document.getElementById("nav").getBoundingClientRect().bottom, document.querySelector(".bk-tabs").getBoundingClientRect().bottom);
        return { top: head.getBoundingClientRect().top, h2: sec.querySelector("h2").getBoundingClientRect().top, bars };
      }, name);
      if (m.top < m.bars - 0.5) bad.push(`${name}: heading at ${m.top.toFixed(1)} under bars ending at ${m.bars.toFixed(1)}`);
      if (m.h2 > h * 0.6 && name !== names[names.length - 1]) bad.push(`${name}: heading too far down (${m.h2.toFixed(0)}px)`);
    }
    assert(!bad.length, bad.join("; "));
    await shot(page, `tabs-${w}`, { fullPage: false });
    await noOverflow(page, `book ${w}`);
    noErrors(page, `tabs ${w}`);
    await close(page);
  });
}

await check("library: filter field and genre chips", async () => {
  const page = await open("", { lang: "en" });
  await page.click('#nav-links a[href="#/library"]');
  await waitFor(page, () => document.querySelectorAll(".modal .bt-card").length === document.querySelectorAll(".modal .bt-card").length && document.querySelectorAll(".modal .bt-card").length >= 6, null, { what: "library grid" });
  const total = await page.locator(".modal .bt-card").count();
  assert(total === CATALOG.length, `library shows ${total} of ${CATALOG.length}`);
  await page.fill(".bt-lib-input", "hobbit");
  await waitFor(page, () => document.querySelectorAll(".modal .bt-card").length === 1, null, { what: "filtered to one book" });
  assert(/Hobbit/.test(await page.locator(".modal .bt-card-title").first().textContent()), "wrong book after filtering");
  await page.fill(".bt-lib-input", "");
  const chips = await page.locator(".modal .bt-chip").count();
  if (chips > 1) {
    await page.locator(".modal .bt-chip").nth(1).click();
    await waitFor(page, (n) => { const k = document.querySelectorAll(".modal .bt-card").length; return k > 0 && k < n; }, total, { what: "a genre chip narrows the grid" });
    assert(await page.locator('.modal .bt-chip[aria-pressed="true"]').count() === 1, "exactly one chip should be pressed");
  }
  await noOverflow(page, "library");
  noErrors(page, "library");
  await close(page);
});

await check("pwa: manifest, icons, service worker and the offline shell", async () => {
  const man = await (await fetch(BASE + "manifest.webmanifest")).json();
  assert(man.start_url === "/" && man.scope === "/" && man.display === "standalone" && man.background_color === "#04050b", "manifest fields");
  for (const i of man.icons) {
    const res = await fetch(new URL(i.src, BASE));
    assert(res.ok, `icon ${i.src}: HTTP ${res.status}`);
  }
  assert(man.icons.some((i) => i.purpose === "maskable"), "no maskable icon");
  for (const f of ["apple-touch-icon.png", "og.png"]) assert((await fetch(BASE + f)).ok, `${f} missing`);
  const page = await open("", { lang: "en", sw: true });
  const html = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
    theme: document.querySelector('meta[name="theme-color"]')?.content,
  }));
  assert(html.manifest === "/manifest.webmanifest" && html.apple === "/apple-touch-icon.png" && html.theme === "#04050b", JSON.stringify(html));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "networkidle" }); // now controlled: modules land in the cache
  assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "page is not controlled by the service worker");
  const api = await page.evaluate(async () => (await caches.keys()).length && (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url)))).flat().filter((u) => u.includes("/api/")));
  assert(Array.isArray(api) && !api.length, `API responses were cached: ${api}`);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(page, () => document.getElementById("view-home") && !document.getElementById("view-home").hidden && document.getElementById("search-input"), null, { what: "offline shell" });
  await page.context().setOffline(false);
  await close(page);
});

// ---------------------------------------------------------------------------------------------
// PAYWALL (own dev server with test billing env, Paddle.js mocked)

await check("paywall: 2 free books, then the paywall; magic-link login; Subscribe opens Paddle with the right price", async () => {
  const port = Number(new URL(BASE).port || 80) + 7;
  const PAY = `http://localhost:${port}/`;
  const env = { ...process.env, AUTH_DEV_LINKS: "1", PADDLE_CLIENT_TOKEN: "test_x", PADDLE_PRICE_MONTH: "pri_m", PADDLE_PRICE_YEAR: "pri_y", PADDLE_WEBHOOK_SECRET: "whsec", PADDLE_API_KEY: "k", PUBLIC_TELEGRAM: "booktrip_test", SIGNING_SECRET: "dev", PADDLE_ENV: "sandbox" };
  for (const k of ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) delete env[k];
  const child = spawn(process.execPath, [`${ROOT}tests/dev-server.mjs`, String(port)], { stdio: "ignore", env });
  try {
    let h = null;
    for (let i = 0; i < 50 && !h; i++) { await sleep(200); try { h = await (await fetch(PAY + "api/health")).json(); } catch { /* not yet */ } }
    assert(h && h.billing?.enabled && h.account, `billing/account not enabled on the test server: ${JSON.stringify(h)}`);
    const events = [];
    const routes = async (c) => {
      await c.route("https://cdn.paddle.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: `window.__paddle = { calls: [] };
        window.Paddle = { Environment: { set(e) { window.__paddle.env = e; } }, Initialize(o) { window.__paddle.init = o; }, Update(o) { window.__paddle.init = o; },
          Checkout: { open(a) { window.__paddle.open = JSON.parse(JSON.stringify(a)); }, close() { window.__paddle.closed = true; } } };` }));
      c.on("request", (r) => { if (r.url().includes("/api/event")) { try { events.push(JSON.parse(r.postData() || "{}").name); } catch { /* ignore */ } } });
    };
    const page = await open("", { lang: "en", base: PAY, routes });
    await waitFor(page, () => { const b = document.getElementById("nav-account"); return b && !b.hidden; }, null, { what: "account button" });
    await clickLink(page, "/book/little-prince");
    await bookShown(page, BOOKS["little-prince"].i18n.en.title);
    await waitFor(page, () => /1 free book left/.test(document.querySelector(".bk-free")?.textContent || ""), null, { what: "free books badge (1 left)" });
    await clickLink(page, "/book/the-hobbit");
    await bookShown(page, BOOKS["the-hobbit"].i18n.en.title);
    await waitFor(page, () => /0 free books left/.test(document.querySelector(".bk-free")?.textContent || ""), null, { what: "free books badge (0 left)" });
    await clickLink(page, "/book/treasure-island");
    await waitFor(page, () => document.querySelector(".bt-paymodal .bt-plan"), null, { what: "paywall on the 3rd book" });
    const state = await page.evaluate(() => ({ path: location.pathname, h1: document.querySelector("#view-book:not([hidden]) h1")?.textContent || "", plans: document.querySelectorAll(".bt-paymodal .bt-plan").length, best: document.querySelector(".bt-paymodal .bt-plan.is-best .bt-plan-best")?.textContent || "", tg: document.querySelector(".bt-paymodal a[href^='https://t.me/']")?.getAttribute("href"), legal: [...document.querySelectorAll(".bt-paymodal .bt-legal a")].map((a) => a.getAttribute("href")) }));
    assert(state.path !== "/book/treasure-island" && !/Treasure/.test(state.h1), `the 3rd book rendered anyway (${state.path})`);
    assert(state.plans === 2 && state.best, `plans ${state.plans}, best "${state.best}"`);
    assert(state.tg === "https://t.me/booktrip_test", `telegram link ${state.tg}`);
    assert(["/terms", "/privacy", "/refund"].every((x) => state.legal.includes(x)), `legal links ${state.legal}`);
    await shot(page, "paywall");
    // Subscribe while logged out → sign-in step → dev magic link
    await page.click(".bt-paymodal .bt-subscribe");
    await waitFor(page, () => document.querySelector('.bt-paymodal input[type="email"]'), null, { what: "login step" });
    await page.fill('.bt-paymodal input[type="email"]', "Reader@Example.com");
    await page.click(".bt-paymodal .bt-login-form button[type=submit]");
    await waitFor(page, () => document.querySelector(".bt-devlink"), null, { what: "dev sign-in link" });
    const link = await page.getAttribute(".bt-devlink", "href");
    await page.goto(link, { waitUntil: "networkidle" });
    await waitFor(page, () => !/login=/.test(location.search), null, { what: "?login stripped" });
    await waitFor(page, () => /reader@example\.com/i.test(document.getElementById("toast").textContent), null, { what: "signed-in toast" });
    await waitFor(page, () => /reader@example\.com/i.test(document.getElementById("nav-account")?.title || ""), null, { what: "e-mail in the nav" });
    await waitFor(page, () => document.querySelector(".bt-paymodal .bt-subscribe"), null, { what: "paywall reopened after login" });
    await page.click(".bt-paymodal .bt-subscribe");
    await waitFor(page, () => window.__paddle?.open, null, { what: "Paddle.Checkout.open" });
    const pd = await page.evaluate(() => ({ env: window.__paddle.env, token: window.__paddle.init?.token, open: window.__paddle.open, cb: typeof window.__paddle.init?.eventCallback }));
    assert(pd.token === "test_x" && pd.env === "sandbox" && pd.cb === "function", `Paddle init ${JSON.stringify(pd)}`);
    assert(pd.open.items?.[0]?.priceId === "pri_y" && pd.open.items[0].quantity === 1, `checkout items ${JSON.stringify(pd.open.items)}`);
    const uid = pd.open.customData?.uid;
    assert(/^[0-9a-f]{16}$/.test(uid || ""), `customData.uid ${uid}`);
    assert(/reader@example\.com/i.test(pd.open.customer?.email || ""), `customer ${JSON.stringify(pd.open.customer)}`);
    // checkout.completed → "activating…" → the (signed) webhook lands → subscribed, the blocked book opens
    await page.evaluate(() => window.__paddle.init.eventCallback({ name: "checkout.completed", data: {} }));
    await waitFor(page, () => document.querySelector(".bt-activate"), null, { what: "activating state" });
    const { createHmac } = await import("node:crypto");
    const raw = JSON.stringify({ event_id: "evt_e2e", event_type: "subscription.activated", occurred_at: new Date().toISOString(), data: { id: "sub_e2e", status: "active", customer_id: "ctm_e2e", custom_data: { uid }, items: [{ price: { id: "pri_y" } }], current_billing_period: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 365 * 864e5).toISOString() } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec").update(`${ts}:${raw}`).digest("hex");
    const wh = await fetch(PAY + "api/billing/webhook", { method: "POST", headers: { "content-type": "application/json", "paddle-signature": `ts=${ts};h1=${sig}` }, body: raw });
    assert(wh.ok, `webhook answered ${wh.status}`);
    await waitFor(page, () => !document.querySelector(".bt-activate"), null, { timeout: 30000, what: "activation to finish" });
    await bookShown(page, BOOKS["treasure-island"].i18n.en.title);
    assert(!(await page.locator(".bk-free").count()), "free-books badge shown to a subscriber");
    await sleep(500);
    for (const name of ["book_open", "paywall_shown", "signup_start", "signup_done", "checkout_start"]) assert(events.includes(name), `event ${name} not sent (${events.join(",")})`);
    noErrors(page, "paywall flow");
    await close(page);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------------------------

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
