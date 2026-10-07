// BookTrip — the book page (owner: book-ui).
//
//   renderBook(root, book, { lang, health, onSearch(query), onBack(), onRetry(part) }) → { update(book), dispose() }
//
// Sections: hero (3D cover, listen / share) · sticky section tabs · retelling · terms · characters ·
// similar books · trip into the book (mini-film + premium AI video) · footer.
// Live mode: the parts "overview" | "characters" | "film" may still be missing (→ skeletons) or have
// failed (book.errors[part] or book._errors[part] = { code, message } → inline error + retry).
// update(book) re-renders only the sections whose data changed and keeps the scroll position;
// portraits that are already rendered are reused, never redrawn.
// Sibling modules (covers, voxel, film, app, api) are imported lazily, each with a fallback.
// Every string that came from AI or data files is inserted with textContent — never as HTML.

import { el, safeColor, prefersReducedMotion, normalizeQuery, store, debounce } from "./util.js";
import { ROLES } from "./enums.js";
import { tb, tbn } from "./strings-book.js";

// ---------------------------------------------------------------------------------------------
// Lazy sibling modules (each may be missing or broken — the page must still work)

const lazy = (loader, name) => {
  let p = null;
  return () => (p ||= loader().catch((err) => {
    console.warn(`[book] ${name} is unavailable:`, err?.message || err);
    p = null;
    return null;
  }));
};
const loadCovers = lazy(() => import("./covers.js"), "covers.js");
const loadVoxel = lazy(() => import("./voxel.js"), "voxel.js");
const loadFilm = lazy(() => import("./film.js"), "film.js");
const loadAppModule = lazy(() => import("./app.js"), "app.js");
// js/app.js only boots (and installs its Esc / focus-trap key handling) inside the full app shell.
const loadApp = () => (document.getElementById("view-home") && document.getElementById("view-book") ? loadAppModule() : Promise.resolve(null));
const loadApi = lazy(() => import("./api.js"), "api.js");

// ---------------------------------------------------------------------------------------------
// Small helpers

const LANGS = ["ru", "uk", "en"];
const LOCALES = { ru: "ru-RU", uk: "uk-UA", en: "en-US" };
const TERMS_PREVIEW = 6; // phones show this many terms before "show all" (keep in sync with book.css)
const SECTIONS = [
  { name: "summary", part: "overview" },
  { name: "terms", part: "overview" },
  { name: "characters", part: "characters" },
  { name: "similar", part: "overview" },
  { name: "film", part: "film" },
];

const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const enc = encodeURIComponent;
let uidN = 0;
const uid = (prefix) => `${prefix}-${++uidN}`;
const json = (v) => { try { return JSON.stringify(v ?? null); } catch { return String(Math.random()); } };
const pad2 = (n) => String(n).padStart(2, "0");

function rgba(hex, a) {
  const h = safeColor(hex, "#5fe1ff").slice(1);
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
}

// Icons: trusted static markup only.
const svg = (body, cls = "bk-ico") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  headphones: svg('<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><rect x="3" y="13.6" width="4.6" height="7" rx="1.8"/><rect x="16.4" y="13.6" width="4.6" height="7" rx="1.8"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2.4" fill="currentColor" stroke="none"/>'),
  share: svg('<path d="M12 3.8v11"/><path d="M8 7.6l4-3.8 4 3.8"/><path d="M5.5 12.5v5.8a2.2 2.2 0 0 0 2.2 2.2h8.6a2.2 2.2 0 0 0 2.2-2.2v-5.8"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l2.9 1.9"/>'),
  info: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5"/><path d="M12 7.7v.1"/>'),
  flame: svg('<path d="M12 3.2c.6 3.1-2.6 4.6-2.6 8.2a2.6 2.6 0 0 0 5.2 0c0-1.1-.5-2-.5-2s3.1 1.5 3.1 5.2a5.2 5.2 0 0 1-10.4 0c0-5.3 5.2-6.6 5.2-11.4z"/>'),
  alert: svg('<path d="M12 4.2 3 19.6h18z"/><path d="M12 10.2v4.4"/><path d="M12 17.3v.1"/>'),
  refresh: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.4v4.3h-4.3"/>'),
  play: svg('<path d="M8.2 5.6v12.8a.8.8 0 0 0 1.2.7l10.3-6.4a.8.8 0 0 0 0-1.4L9.4 4.9a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6.4" y="5.4" width="4" height="13.2" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.6" y="5.4" width="4" height="13.2" rx="1.3" fill="currentColor" stroke="none"/>'),
  restart: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.2 4.4v4.3h4.3"/>'),
  voice: svg('<path d="M4 9.6h3.4L12 5.6v12.8l-4.6-4H4z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  mute: svg('<path d="M4 9.6h3.4L12 5.6v12.8l-4.6-4H4z"/><path d="M16 9.6l4.8 4.8M20.8 9.6 16 14.4"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  unfull: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  arrow: svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  upRight: svg('<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  down: svg('<path d="M6 9.5l6 6 6-6"/>'),
  search: svg('<circle cx="11" cy="11" r="6.6"/><path d="M20 20l-4.2-4.2"/>'),
  sparkle: svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  video: svg('<rect x="2.5" y="6" width="13.2" height="12" rx="2.6"/><path d="M15.7 10.4 21.5 7v10l-5.8-3.4z"/>'),
  rotate: svg('<path d="M3.6 12a8.4 8.4 0 0 0 15.2 4.9"/><path d="M20.4 12A8.4 8.4 0 0 0 5.2 7.1"/><path d="M5 3.6v3.6h3.6"/><path d="M19 20.4v-3.6h-3.6"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  book: svg('<path d="M3 6.8c3-1.3 6-1.1 9 .7 3-1.8 6-2 9-.7v12c-3-1.3-6-1.1-9 .7-3-1.8-6-2-9-.7z"/><path d="M12 7.5v12"/>'),
};
const icon = (name, cls) => el("span", { class: cls || "bk-i", html: ICON[name] });

// ---------------------------------------------------------------------------------------------
// Part status (live mode)

function partError(book, part) {
  const e = book?._errors?.[part] || book?.errors?.[part];
  if (!e) return null;
  return isObj(e) ? e : { message: str(e) };
}
function hasPart(book, part) {
  if (part === "overview") return Array.isArray(book.summary) || Array.isArray(book.terms) || Array.isArray(book.similar);
  if (part === "characters") return Array.isArray(book.characters);
  if (part === "film") return isObj(book.film);
  return false;
}
/** "ready" | "error" | "loading" */
function partStatus(book, part) {
  if (hasPart(book, part)) return "ready";
  return partError(book, part) ? "error" : "loading";
}

const roleOf = (c) => (ROLES.includes(c?.role) ? c.role : "supporting");
const charName = (c) => str(c?.name) || str(c?.id) || "?";

function formatYear(year, lang) {
  const y = Number(year);
  if (!Number.isFinite(y) || y === 0) return "";
  return y < 0 ? tb(lang, "year.bc", { n: Math.abs(Math.round(y)) }) : String(Math.round(y));
}

// ---------------------------------------------------------------------------------------------
// Modal + toast with fallbacks (js/app.js provides the real ones)

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function localModal(content, { label = "", labelledBy = "", className = "", onClose, closeLabel = "Close" } = {}) {
  const host = document.getElementById("modal-root") || document.body;
  const prevFocus = document.activeElement;
  const closeBtn = el("button", { type: "button", class: "modal-close", "aria-label": closeLabel, html: ICON.close });
  const dialog = el("div", {
    class: `modal ${className}`.trim(), role: "dialog", "aria-modal": "true",
    "aria-labelledby": labelledBy || null, "aria-label": labelledBy ? null : label || null, tabindex: "-1",
  }, closeBtn, content);
  const backdrop = el("div", { class: "modal-backdrop" }, dialog);
  const main = document.getElementById("main");
  const prevOverflow = document.documentElement.style.overflow;
  let closed = false;
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); handle.close("user"); }
    else if (e.key === "Tab") {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length);
      if (!items.length) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const handle = {
    node: dialog,
    close(reason = "api") {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (main) main.inert = false;
      document.documentElement.style.overflow = prevOverflow;
      if (prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
      try { onClose?.(reason); } catch (err) { console.error(err); }
    },
  };
  closeBtn.addEventListener("click", () => handle.close("user"));
  let downOnBackdrop = false;
  backdrop.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && downOnBackdrop) handle.close("user"); });
  document.addEventListener("keydown", onKey, true);
  host.append(backdrop);
  if (main) main.inert = true;
  document.documentElement.style.overflow = "hidden";
  dialog.focus({ preventScroll: true });
  return handle;
}

async function openModal(content, opts) {
  const app = await loadApp();
  if (app && typeof app.openModal === "function") {
    try { return app.openModal(content, opts); } catch (err) { console.warn("[book] app.openModal failed, using the local modal", err); }
  }
  return localModal(content, opts);
}

let toastTimer = 0;
async function notify(message, { error = false } = {}) {
  if (!message) return;
  const app = await loadApp();
  if (app && typeof app.toast === "function") { app.toast(message, { error }); return; }
  let node = document.getElementById("toast");
  if (!node) {
    node = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(node);
  }
  node.textContent = String(message);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3800);
}

async function errorMessage(err, lang) {
  const app = await loadApp();
  if (app && typeof app.errorText === "function" && err?.code) {
    try { return app.errorText(err); } catch { /* fall through */ }
  }
  return tb(lang, "err.generic");
}

// ---------------------------------------------------------------------------------------------
// Premium endpoints (js/api.js has the canonical helpers; these are fallbacks)

function localPortraitUrl(book, ch) {
  if (!book || !ch || !str(ch.id)) return null;
  if (book.source === "demo") return `/api/portrait?demo=${enc(book.id)}&char=${enc(ch.id)}`;
  if (!str(ch.portraitPrompt) || !str(ch.portraitToken)) return null;
  return `/api/portrait?book=${enc(book.id)}&char=${enc(ch.id)}&lang=${enc(book.lang || "en")}&prompt=${enc(ch.portraitPrompt)}&token=${enc(ch.portraitToken)}`;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { code: data?.error || (res.status === 403 ? "forbidden" : "upstream") });
  return data;
}

const videoApi = {
  async start(book, code, { signal } = {}) {
    const api = await loadApi();
    if (api?.startVideo) return api.startVideo(book, code, { signal });
    const film = book.film || {};
    const body = { id: book.id, title: book.title || "", prompts: arr(film.videoPrompts).slice(0, 3), token: film.videoToken || "" };
    if (book.source === "demo") body.demo = book.id;
    const r = await fetchJson("/api/video", { method: "POST", signal, headers: { "content-type": "application/json", "x-premium-code": String(code || "").trim() }, body: JSON.stringify(body) });
    return { jobs: arr(r.jobs).filter((j) => typeof j === "string") };
  },
  async poll(job, { signal } = {}) {
    const api = await loadApi();
    if (api?.pollVideo) return api.pollVideo(job, { signal });
    const r = await fetchJson(`/api/video?op=${enc(job)}`, { signal });
    return { done: r.done === true && typeof r.url === "string", url: typeof r.url === "string" ? r.url : null };
  },
};

// =============================================================================================
// renderBook
// =============================================================================================

export function renderBook(root, bookIn, opts = {}) {
  let book = isObj(bookIn) ? bookIn : {};
  const lang = LANGS.includes(opts.lang) ? opts.lang : LANGS.includes(book.lang) ? book.lang : "en";
  const T = (key, vars) => tb(lang, key, vars);
  const TN = (key, n, vars) => tbn(lang, key, n, vars);
  const health = isObj(opts.health) ? opts.health : {};
  const reduced = prefersReducedMotion();
  const finePointer = (() => { try { return matchMedia("(hover: hover) and (pointer: fine)").matches; } catch { return false; } })();

  let disposed = false;
  const cleanups = [];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); cleanups.push(() => target.removeEventListener(type, fn, o)); };
  const intervals = new Set();
  const every = (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; };
  const stopEvery = (id) => { clearInterval(id); intervals.delete(id); };
  const modals = new Set();
  const objectUrls = new Set();
  const sigs = {};

  // ---- page skeleton ------------------------------------------------------------------------
  const page = el("article", { class: "bk", lang, "aria-live": "off" });
  const hero = el("header", { class: "bk-hero" });
  const tabs = el("nav", { class: "bk-tabs", "aria-label": T("nav.label") });
  const footer = el("footer", { class: "bk-foot" });
  const secs = {};
  for (const [i, s] of SECTIONS.entries()) secs[s.name] = makeSection(s.name, i);
  page.append(hero, tabs, ...SECTIONS.map((s) => secs[s.name].node), footer);
  root.replaceChildren(page);

  function makeSection(name) {
    const hid = `bk-${name}-h`;
    const num = el("span", { class: "bk-eyebrow-num" });
    const h2 = el("h2", { class: "bk-h2", id: hid, tabindex: "-1" });
    const lead = el("p", { class: "bk-lead" });
    const tools = el("div", { class: "bk-sec-tools" });
    const head = el("div", { class: "bk-sec-head" },
      el("div", { class: "bk-sec-titles" },
        el("p", { class: "bk-eyebrow" }, num, el("span", { text: T(`nav.${name}`) })),
        h2, lead),
      tools);
    const body = el("div", { class: "bk-sec-body" });
    const node = el("section", { class: `bk-sec bk-sec-${name}`, id: `bk-${name}`, "aria-labelledby": hid }, head, body);
    return { name, node, head, h2, lead, tools, body, num };
  }

  function setHead(s, title, lead) {
    s.h2.textContent = title;
    s.lead.textContent = lead || "";
    s.lead.hidden = !lead;
  }

  // ---- shared bits --------------------------------------------------------------------------
  function waitNote(text) {
    return el("p", { class: "bk-wait" }, el("span", { class: "bk-wait-dot", "aria-hidden": "true" }), el("span", { text }));
  }

  function errorBlock(part, { compact = false } = {}) {
    const e = partError(book, part) || {};
    const msg = str(e.message) || T("err.generic");
    const kids = [
      icon("alert", "bk-error-ico"),
      el("div", { class: "bk-error-text" },
        el("p", { class: "bk-error-title", text: T(`err.${part}`) }),
        el("p", { class: "bk-error-msg", text: msg })),
    ];
    if (typeof opts.onRetry === "function") {
      const retry = el("button", { type: "button", class: "btn-ghost bk-retry" }, icon("refresh"), el("span", { text: T("err.retry") }));
      retry.addEventListener("click", () => {
        retry.disabled = true;
        try { opts.onRetry(part); } catch (err) { console.error(err); }
        setTimeout(() => { retry.disabled = false; }, 1500);
      });
      kids.push(retry);
    }
    return el("div", { class: `bk-error${compact ? " is-compact" : ""}`, role: "alert" }, ...kids);
  }

  function coverOf(b, covers) {
    if (isObj(b.cover)) return b.cover;
    if (covers?.coverFromString) return covers.coverFromString(b.title || "");
    return { bg: "#1b2a4a", bg2: "#0e1630", fg: "#f6e7b0", accent: "#5fe1ff", motif: "book" };
  }

  function applyTheme() {
    const c = isObj(book.cover) ? book.cover : {};
    const accent = safeColor(c.accent, "#5fe1ff");
    page.style.setProperty("--bk-bg", safeColor(c.bg, "#1b2a4a"));
    page.style.setProperty("--bk-bg2", safeColor(c.bg2, "#0e1630"));
    page.style.setProperty("--bk-fg", safeColor(c.fg, "#f6e7b0"));
    page.style.setProperty("--bk-accent", accent);
    page.style.setProperty("--bk-accent-a", rgba(accent, 0.22));
    page.style.setProperty("--bk-accent-b", rgba(accent, 0.08));
    page.style.setProperty("--bk-bg-a", rgba(safeColor(c.bg, "#1b2a4a"), 0.55));
  }

  // =============================================================================================
  // HERO
  // =============================================================================================

  const listenButtons = new Set();
  let themesList = null;
  let heroRenders = 0;

  function renderHero() {
    sigs.hero = heroSig();
    applyTheme();
    const b = book;
    const title = str(b.title) || "BookTrip";
    const author = str(b.author);
    const year = formatYear(b.year, lang);
    const original = str(b.originalTitle);
    const showOriginal = original && normalizeQuery(original) !== normalizeQuery(title);

    // 3D book
    const front = el("div", { class: "bk-book-front" });
    const coverBox = el("div", { class: "bk-book-art", role: "img", "aria-label": T("hero.coverLabel", { title }) });
    front.append(coverBox, el("span", { class: "bk-book-gloss", "aria-hidden": "true" }));
    coverBox.style.background = `linear-gradient(160deg, ${safeColor(b.cover?.bg, "#1b2a4a")}, ${safeColor(b.cover?.bg2, "#0e1630")})`;
    loadCovers().then((covers) => {
      if (disposed || !coverBox.isConnected || !covers?.coverSVG) return;
      try {
        coverBox.innerHTML = covers.coverSVG(coverOf(b, covers), { title, author, w: 320, h: 480, decorative: true });
      } catch (err) { console.warn("[book] cover failed", err); }
    });
    const bookEl = el("div", { class: "bk-book" },
      el("span", { class: "bk-book-spine", "aria-hidden": "true" }),
      el("span", { class: "bk-book-top", "aria-hidden": "true" }),
      front);
    const scene = el("div", { class: "bk-book-scene" }, bookEl, el("span", { class: "bk-book-floor", "aria-hidden": "true" }));

    // text column
    const meta = el("div", { class: "bk-hero-meta" });
    if (str(b.genre)) meta.append(el("span", { class: "chip chip-cyan bk-genre", text: str(b.genre) }));
    meta.append(el("span", { class: "bk-source" }, icon("sparkle"), el("span", { text: b.source === "live" ? T("hero.live") : T("hero.demo") })));

    const len = [...title].length;
    const textKids = [meta, el("h1", { class: `bk-title${len > 56 ? " is-xlong" : len > 30 ? " is-long" : ""}`, text: title })];
    if (author) textKids.push(el("p", { class: "bk-author", text: author }));
    const origBits = [showOriginal ? original : "", year].filter(Boolean);
    if (origBits.length) {
      const orig = el("p", { class: "bk-orig" });
      if (showOriginal) orig.append(el("span", { class: "bk-orig-title", text: original }));
      if (showOriginal && year) orig.append(el("span", { class: "bk-dot", "aria-hidden": "true", text: "·" }));
      if (year) orig.append(el("span", { text: year }));
      textKids.push(orig);
    }
    if (str(b.tagline)) textKids.push(el("p", { class: "bk-tagline", text: str(b.tagline) }));
    themesList = el("ul", { class: "bk-themes", "aria-label": T("hero.themes") });
    textKids.push(themesList);
    fillThemes();

    const actions = el("div", { class: "bk-actions" });
    const listenBtn = el("button", { type: "button", class: "btn-glow bk-listen" });
    listenBtn.addEventListener("click", toggleReading);
    listenButtons.add(listenBtn);
    const shareBtn = el("button", { type: "button", class: "btn-ghost bk-share" }, icon("share"), el("span", { text: T("hero.share") }));
    shareBtn.addEventListener("click", share);
    actions.append(listenBtn, shareBtn);
    textKids.push(actions);

    const top = el("div", { class: "bk-hero-top" });
    if (typeof opts.onBack === "function") {
      const back = el("button", { type: "button", class: "bk-back" }, icon("back"), el("span", { text: T("hero.back") }));
      back.addEventListener("click", () => opts.onBack());
      top.append(back);
    }

    hero.classList.toggle("bk-noanim", heroRenders++ > 0);
    hero.replaceChildren(
      el("div", { class: "bk-hero-glow", "aria-hidden": "true" }),
      el("div", { class: "bk-wrap bk-hero-in" },
        top,
        el("div", { class: "bk-hero-grid" },
          el("div", { class: "bk-cover-col" }, scene),
          el("div", { class: "bk-hero-text" }, ...textKids))));
    syncListen();
  }

  function heroSig() {
    const b = book;
    return json([b.title, b.originalTitle, b.author, b.year, b.genre, b.tagline, b.cover, b.source]);
  }

  function fillThemes() {
    if (!themesList) return;
    sigs.themes = json(book.themes);
    const themes = arr(book.themes).map(str).filter(Boolean).slice(0, 8);
    themesList.replaceChildren(...themes.map((t) => el("li", { class: "chip bk-theme", text: t })));
    themesList.hidden = !themes.length;
  }

  // ---- 3D tilt (fine pointers only, not with reduced motion) ----
  if (finePointer && !reduced) {
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const frame = () => {
      raf = 0;
      cx += (tx - cx) * 0.09;
      cy += (ty - cy) * 0.09;
      const bookNode = hero.querySelector(".bk-book");
      if (bookNode) {
        bookNode.style.setProperty("--tx", cx.toFixed(4));
        bookNode.style.setProperty("--ty", cy.toFixed(4));
      }
      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    on(hero, "pointermove", (e) => {
      const scene = hero.querySelector(".bk-book-scene");
      if (!scene) return;
      const r = scene.getBoundingClientRect();
      const nx = (e.clientX - (r.left + r.width / 2)) / Math.max(320, window.innerWidth * 0.45);
      const ny = (e.clientY - (r.top + r.height / 2)) / Math.max(260, window.innerHeight * 0.5);
      tx = Math.max(-1, Math.min(1, nx));
      ty = Math.max(-1, Math.min(1, ny));
      kick();
    });
    on(hero, "pointerleave", () => { tx = 0; ty = 0; kick(); });
    cleanups.push(() => cancelAnimationFrame(raf));
  }

  // ---- share ----
  async function share() {
    const title = str(book.title) || "BookTrip";
    const url = location.href;
    const data = { title: `${title} — BookTrip`, text: T("hero.shareText", { title }), url };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try { await navigator.share(data); return; } catch (err) { if (err?.name === "AbortError") return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      notify(T("hero.linkCopied"));
    } catch {
      const ta = el("textarea", { readonly: "", style: "position:fixed;top:0;left:0;opacity:0" });
      ta.value = url;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      notify(ok ? T("hero.linkCopied") : T("hero.copyFailed"), { error: !ok });
    }
  }

  // =============================================================================================
  // TEXT-TO-SPEECH of the retelling
  // =============================================================================================

  const tts = { active: false, token: 0 };
  const canSpeak = () => typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance === "function";

  function summaryParas() { return arr(book.summary).map(str).filter(Boolean); }

  function syncListen() {
    const ready = summaryParas().length > 0;
    for (const btn of [...listenButtons]) {
      if (!btn.isConnected) { listenButtons.delete(btn); continue; }
      const small = btn.classList.contains("bk-listen-sm");
      btn.replaceChildren(icon(tts.active ? "stop" : "headphones"),
        el("span", { text: tts.active ? T("hero.stop") : small ? T("summary.listenShort") : T("hero.listen") }));
      btn.setAttribute("aria-pressed", tts.active ? "true" : "false");
      btn.classList.toggle("is-waiting", !ready);
      btn.classList.toggle("is-on", tts.active);
    }
  }

  function pickVoice() {
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      const tag = lang;
      const match = (v) => String(v.lang || "").toLowerCase().replace("_", "-").startsWith(tag);
      return voices.find((v) => match(v) && v.localService) || voices.find(match) || null;
    } catch { return null; }
  }

  function speechChunks(paras) {
    const out = [];
    paras.forEach((p, pi) => {
      const sentences = p.match(/[^.!?…]+[.!?…]*["»”)]*\s*/g) || [p];
      let buf = "";
      for (const s of sentences) {
        if ((buf + s).length > 220 && buf) { out.push({ text: buf.trim(), p: pi }); buf = ""; }
        buf += s;
      }
      if (buf.trim()) out.push({ text: buf.trim(), p: pi });
    });
    return out;
  }

  function highlightPara(i) {
    page.querySelectorAll(".bk-prose p").forEach((p, n) => p.classList.toggle("is-reading", n === i));
  }

  function toggleReading() {
    if (tts.active) { stopReading(); return; }
    if (!canSpeak()) { notify(T("hero.ttsUnsupported"), { error: true }); return; }
    const paras = summaryParas();
    if (!paras.length) { notify(T("hero.ttsWait")); return; }
    if (film.handle?.playing) { try { film.handle.pause(); } catch { /* ignore */ } }
    const synth = window.speechSynthesis;
    try { synth.cancel(); } catch { /* ignore */ }
    const token = ++tts.token;
    tts.active = true;
    syncListen();
    const voice = pickVoice();
    const list = speechChunks(paras);
    list.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c.text);
      u.lang = LOCALES[lang];
      if (voice) u.voice = voice;
      u.rate = 1;
      u.onstart = () => { if (token === tts.token) highlightPara(c.p); };
      u.onend = () => { if (token === tts.token && i === list.length - 1) stopReading(); };
      u.onerror = (e) => { if (token === tts.token && e.error !== "interrupted" && e.error !== "canceled") stopReading(); };
      try { synth.speak(u); } catch { stopReading(); }
    });
  }

  function stopReading() {
    const was = tts.active;
    tts.token++;
    tts.active = false;
    if (was && canSpeak()) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
    highlightPara(-1);
    syncListen();
  }

  // =============================================================================================
  // SECTION TABS (sticky; highlight on scroll; smooth scroll on click)
  // =============================================================================================

  const tabsScroller = el("div", { class: "bk-tabs-in" });
  const ink = el("span", { class: "bk-tabs-ink", "aria-hidden": "true" });
  const tabButtons = SECTIONS.map((s) => {
    const btn = el("button", { type: "button", class: "bk-tab", dataset: { target: s.name }, text: T(`nav.${s.name}`) });
    btn.addEventListener("click", () => goTo(s.name));
    return btn;
  });
  tabsScroller.append(ink, ...tabButtons);
  tabs.append(el("div", { class: "bk-tabs-bar" }, tabsScroller));
  let active = null;
  let lockUntil = 0;

  function stickyOffset() {
    const top = parseFloat(getComputedStyle(tabs).top) || 82;
    return top + tabs.offsetHeight + 18;
  }

  function goTo(name) {
    const s = secs[name];
    if (!s || s.node.hidden) return;
    const y = s.node.getBoundingClientRect().top + window.scrollY - stickyOffset();
    lockUntil = Date.now() + (reduced ? 60 : 1000);
    setActive(name);
    window.scrollTo({ top: Math.max(0, y), behavior: reduced ? "auto" : "smooth" });
    s.h2.focus({ preventScroll: true });
  }

  function setActive(name) {
    active = name;
    for (const b of tabButtons) {
      const isOn = b.dataset.target === name;
      b.classList.toggle("is-active", isOn);
      if (isOn) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    }
    positionInk(true);
  }

  function positionInk(scrollIntoView = false) {
    tabsScroller.classList.toggle("is-scrollable", tabsScroller.scrollWidth > tabsScroller.clientWidth + 2);
    const btn = tabButtons.find((b) => b.dataset.target === active && !b.hidden);
    if (!btn) {
      ink.style.opacity = "0";
      if (scrollIntoView && tabsScroller.scrollLeft > 0) tabsScroller.scrollTo({ left: 0, behavior: reduced ? "auto" : "smooth" });
      return;
    }
    ink.style.opacity = "1";
    ink.style.width = `${btn.offsetWidth}px`;
    ink.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (scrollIntoView && tabsScroller.scrollWidth > tabsScroller.clientWidth + 2) {
      const left = btn.offsetLeft - (tabsScroller.clientWidth - btn.offsetWidth) / 2;
      tabsScroller.scrollTo({ left: Math.max(0, left), behavior: reduced ? "auto" : "smooth" });
    }
  }

  const inBand = new Set();
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) { if (e.isIntersecting) inBand.add(e.target); else inBand.delete(e.target); }
    if (Date.now() < lockUntil) return;
    if (inBand.has(hero)) { if (active !== null) setActive(null); return; }
    const first = SECTIONS.find((s) => inBand.has(secs[s.name].node) && !secs[s.name].node.hidden);
    if (first && first.name !== active) setActive(first.name);
  }, { rootMargin: "-150px 0px -52% 0px" });
  spy.observe(hero);
  for (const s of SECTIONS) spy.observe(secs[s.name].node);
  cleanups.push(() => spy.disconnect());
  on(window, "resize", debounce(() => positionInk(false), 120));
  document.fonts?.ready?.then(() => { if (!disposed) positionInk(false); });

  function syncSections() {
    let n = 0;
    for (const s of SECTIONS) {
      const sec = secs[s.name];
      const tab = tabButtons.find((b) => b.dataset.target === s.name);
      if (tab) tab.hidden = sec.node.hidden;
      if (!sec.node.hidden) sec.num.textContent = pad2(++n);
    }
    positionInk(false);
  }

  // =============================================================================================
  // RETELLING
  // =============================================================================================

  function renderSummary() {
    const s = secs.summary;
    sigs.summary = summarySig();
    setHead(s, T("summary.title"));
    const st = partStatus(book, "overview");
    s.node.setAttribute("aria-busy", st === "loading" ? "true" : "false");
    s.node.hidden = false;
    if (st === "loading") {
      const widths = [96, 100, 92, 98, 64, 0, 100, 94, 97, 88, 72];
      s.body.replaceChildren(el("div", { class: "bk-summary glass is-loading" },
        el("div", { class: "bk-summary-col" },
          waitNote(T("summary.loading")),
          el("div", { class: "bk-skel-lines" }, widths.map((w) => (w ? el("span", { class: "skeleton", style: `width:${w}%` }) : el("i")))))));
      return;
    }
    if (st === "error" || !summaryParas().length) {
      s.body.replaceChildren(st === "error" ? errorBlock("overview") : el("p", { class: "bk-empty", text: T("err.generic") }));
      if (st !== "error") s.node.hidden = true;
      return;
    }
    s.node.hidden = false;
    const paras = summaryParas();
    const words = paras.join(" ").split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / (lang === "en" ? 220 : 180)));
    const listenSm = el("button", { type: "button", class: "btn-ghost bk-listen-sm" });
    listenSm.addEventListener("click", toggleReading);
    listenButtons.add(listenSm);
    s.body.replaceChildren(el("div", { class: "bk-summary glass" },
      el("div", { class: "bk-summary-col" },
        el("div", { class: "bk-summary-meta" },
          el("span", { class: "bk-meta-item" }, icon("clock"), el("span", { text: T("summary.readTime", { n: minutes }) })),
          el("span", { class: "bk-meta-item is-warn" }, icon("flame"), el("span", { text: T("summary.spoilers") })),
          listenSm),
        el("div", { class: "bk-prose" }, paras.map((p, i) => el("p", { class: i === 0 ? "bk-dropcap" : null, text: p }))),
        el("p", { class: "bk-disclaimer" }, icon("info"), el("span", { text: T("summary.disclaimer") })))));
    syncListen();
  }
  const summarySig = () => json([partStatus(book, "overview"), book.summary, partError(book, "overview")]);

  // =============================================================================================
  // TERMS
  // =============================================================================================

  function renderTerms() {
    const s = secs.terms;
    sigs.terms = termsSig();
    setHead(s, T("terms.title"), T("terms.lead"));
    s.tools.replaceChildren();
    const st = partStatus(book, "overview");
    s.node.setAttribute("aria-busy", st === "loading" ? "true" : "false");
    if (st === "loading") {
      s.node.hidden = false;
      s.body.replaceChildren(waitNote(T("terms.loading")),
        el("div", { class: "bk-terms is-skel" }, Array.from({ length: 6 }, (_, i) => el("div", { class: "bk-term" },
          el("span", { class: "skeleton", style: `width:${46 + (i * 17) % 30}%;height:16px` }),
          el("span", { class: "skeleton", style: "width:96%;height:12px;margin-top:14px" }),
          el("span", { class: "skeleton", style: `width:${60 + (i * 13) % 32}%;height:12px;margin-top:8px` })))));
      return;
    }
    if (st === "error") {
      // the retelling section shows the overview error (with retry) once; this part waits for it
      s.node.hidden = true;
      s.body.replaceChildren();
      return;
    }
    const terms = arr(book.terms).filter((t) => isObj(t) && str(t.term));
    s.node.hidden = terms.length === 0;
    if (!terms.length) { s.body.replaceChildren(); return; }

    const items = terms.map((t) => {
      const node = el("div", { class: "bk-term" },
        el("dt", { class: "bk-term-name", text: str(t.term) }),
        el("dd", { class: "bk-term-def", text: str(t.definition) }));
      return { node, key: normalizeQuery(`${str(t.term)} ${str(t.definition)}`) };
    });
    const list = el("dl", { class: "bk-terms" }, items.map((i) => i.node));
    const none = el("p", { class: "bk-empty", hidden: true, role: "status" });
    const count = el("span", { class: "bk-count", text: TN("terms.count", terms.length) });

    if (terms.length > 8) {
      const fid = uid("bk-filter");
      const input = el("input", { id: fid, class: "bk-filter-input", type: "search", placeholder: T("terms.filterPh"), autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
      const apply = () => {
        const q = normalizeQuery(input.value);
        if (q) {
          list.classList.remove("is-collapsed");
          s.body.querySelector(".bk-terms-more")?.remove();
        }
        let shown = 0;
        for (const it of items) {
          const hit = !q || it.key.includes(q);
          it.node.hidden = !hit;
          if (hit) shown++;
        }
        none.hidden = shown > 0;
        if (!shown) none.textContent = T("terms.none", { q: input.value.trim() });
        count.textContent = TN("terms.count", q ? shown : terms.length);
      };
      input.addEventListener("input", debounce(apply, 60));
      input.addEventListener("keydown", (e) => { if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; apply(); } });
      s.tools.append(el("label", { class: "bk-filter", for: fid },
        icon("search"), el("span", { class: "sr-only", text: T("terms.filter") }), input));
    }
    s.tools.prepend(count);
    const kids = [list, none];
    if (terms.length > TERMS_PREVIEW) {
      list.classList.add("is-collapsed");
      const more = el("button", { type: "button", class: "btn-ghost bk-terms-more", "aria-expanded": "false" },
        el("span", { text: TN("terms.showAll", terms.length) }), icon("down"));
      more.addEventListener("click", () => {
        list.classList.remove("is-collapsed");
        more.remove();
      });
      kids.push(more);
    }
    s.body.replaceChildren(...kids);
  }
  const termsSig = () => json([partStatus(book, "overview"), book.terms, partError(book, "overview")]);

  // =============================================================================================
  // CHARACTERS
  // =============================================================================================

  const portraitCache = new Map();   // appearance JSON → PNG data URL (already rendered)
  const cardCache = new Map();       // character JSON → card <li> (reused across updates)
  const portraitIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      portraitIO.unobserve(e.target);
      const job = e.target.__bkPortrait;
      if (job) job();
    }
  }, { rootMargin: "320px 0px" });
  cleanups.push(() => portraitIO.disconnect());

  function currentChars() {
    return arr(book.characters).filter((c) => isObj(c));
  }

  function renderChars() {
    const s = secs.characters;
    sigs.characters = charsSig();
    setHead(s, T("chars.title"), T("chars.lead"));
    s.tools.replaceChildren();
    const st = partStatus(book, "characters");
    s.node.setAttribute("aria-busy", st === "loading" ? "true" : "false");
    if (st === "loading") {
      s.lead.hidden = true;
      s.body.replaceChildren(waitNote(T("chars.loading")),
        el("ul", { class: "bk-chars is-skel", "aria-hidden": "true" }, Array.from({ length: 4 }, () => el("li", { class: "bk-char" },
          el("div", { class: "bk-char-stage" }, el("span", { class: "bk-stage-shimmer" })),
          el("div", { class: "bk-char-body" },
            el("span", { class: "skeleton", style: "width:42%;height:12px" }),
            el("span", { class: "skeleton", style: "width:70%;height:20px;margin-top:12px" }),
            el("span", { class: "skeleton", style: "width:92%;height:12px;margin-top:16px" }),
            el("span", { class: "skeleton", style: "width:80%;height:12px;margin-top:8px" }))))));
      return;
    }
    if (st === "error") {
      s.lead.hidden = true;
      s.body.replaceChildren(errorBlock("characters"));
      return;
    }
    const chars = currentChars();
    if (!chars.length) {
      s.lead.hidden = true;
      s.body.replaceChildren(el("p", { class: "bk-empty", text: T("chars.empty") }));
      return;
    }
    s.tools.append(el("span", { class: "bk-count", text: TN("chars.count", chars.length) }));
    const seen = new Set();
    const cards = chars.map((ch, i) => {
      const key = json(ch);
      let card = cardCache.get(key);
      if (!card || seen.has(card)) {
        card = charCard(ch);
        cardCache.set(key, card);
      }
      seen.add(card);
      card.__bkIndex = i;
      card.style.setProperty("--i", String(Math.min(i, 8)));
      return card;
    });
    for (const [k, card] of cardCache) if (!seen.has(card)) cardCache.delete(k);
    s.body.replaceChildren(el("ul", { class: "bk-chars" }, cards));
  }
  const charsSig = () => json([partStatus(book, "characters"), book.characters, partError(book, "characters")]);

  function charCard(ch) {
    const name = charName(ch);
    const role = roleOf(ch);
    const stage = el("div", { class: "bk-char-stage" }, el("span", { class: "bk-stage-shimmer", "aria-hidden": "true" }), el("span", { class: "bk-char-3d", "aria-hidden": "true" }, icon("rotate"), "3D"));
    const open = el("button", { type: "button", class: "bk-char-open", "aria-label": T("chars.open", { name }) }, name);
    const traits = arr(ch.traits).map(str).filter(Boolean).slice(0, 4);
    const card = el("li", { class: `bk-char is-${role}` },
      stage,
      el("div", { class: "bk-char-body" },
        el("span", { class: `bk-role is-${role}`, text: T(`role.${role}`) }),
        el("h3", { class: "bk-char-name" }, open),
        traits.length ? el("ul", { class: "bk-traits" }, traits.map((t) => el("li", { text: t }))) : null,
        str(ch.description) ? el("p", { class: "bk-char-desc", text: str(ch.description) }) : null));
    open.addEventListener("click", () => openCharacter(card.__bkIndex ?? 0));
    attachPortrait(stage, ch, name);
    return card;
  }

  function attachPortrait(stage, ch, name) {
    const akey = json(ch.appearance);
    const show = (url) => {
      const img = el("img", { class: "bk-char-img", alt: T("chars.figure", { name }), width: "512", height: "512", decoding: "async", draggable: "false" });
      img.addEventListener("load", () => stage.classList.add("is-ready"), { once: true });
      img.src = url;
      stage.append(img);
      if (img.complete) stage.classList.add("is-ready");
    };
    const fail = () => {
      stage.classList.add("is-ready", "is-fallback");
      stage.append(el("span", { class: "bk-char-initial", "aria-hidden": "true", text: name.slice(0, 1).toUpperCase() }));
    };
    if (portraitCache.has(akey)) { show(portraitCache.get(akey)); return; }
    stage.__bkPortrait = async () => {
      const vx = await loadVoxel();
      if (disposed) return;
      if (!vx?.renderPortrait) { fail(); return; }
      try {
        const url = await vx.renderPortrait(ch.appearance, { size: 512, background: "studio" });
        if (disposed) return;
        portraitCache.set(akey, url);
        show(url);
      } catch (err) {
        console.warn("[book] portrait failed", err);
        if (!disposed) fail();
      }
    };
    portraitIO.observe(stage);
  }

  // ---- character modal ----
  const aiPortraits = new Map(); // book:char → object URL of a generated portrait

  async function openCharacter(index) {
    const list = currentChars();
    if (!list.length) return;
    let i = ((index % list.length) + list.length) % list.length;
    const titleId = uid("bk-cm-h");
    const viewerBox = el("div", { class: "bk-cm-viewer" });
    const stage = el("div", { class: "bk-cm-stage" }, viewerBox,
      el("p", { class: "bk-cm-hint" }, icon("rotate"), el("span", { text: T("char.drag") })));
    const info = el("div", { class: "bk-cm-info" });
    const wrap = el("div", { class: "bk-cm" }, stage, info);
    let viewer = null;
    let closed = false;
    let portraitCtrl = null;

    const mountViewer = async (ch) => {
      const vx = await loadVoxel();
      if (closed || disposed) return;
      const label = T("char.viewer", { name: charName(ch) });
      if (!vx?.createViewer) {
        viewerBox.replaceChildren(el("span", { class: "bk-char-initial", text: charName(ch).slice(0, 1).toUpperCase() }));
        return;
      }
      try {
        if (viewer && typeof viewer.setAppearance === "function") {
          viewer.setAppearance(ch.appearance);
          viewer.renderer?.domElement?.setAttribute("aria-label", label);
        } else {
          viewer?.dispose?.();
          viewerBox.replaceChildren();
          viewer = vx.createViewer(viewerBox, ch.appearance, { background: "studio", label });
        }
      } catch (err) {
        console.warn("[book] 3D viewer failed", err);
        viewer = null;
        const url = portraitCache.get(json(ch.appearance));
        viewerBox.replaceChildren(url ? el("img", { class: "bk-char-img", src: url, alt: label }) : el("span", { class: "bk-char-initial", text: charName(ch).slice(0, 1).toUpperCase() }));
      }
    };

    const fill = (n) => {
      i = ((n % list.length) + list.length) % list.length;
      const ch = list[i];
      portraitCtrl?.abort();
      portraitCtrl = null;
      const role = roleOf(ch);
      const traits = arr(ch.traits).map(str).filter(Boolean);
      const kids = [
        el("span", { class: `bk-role is-${role}`, text: T(`role.${role}`) }),
        el("h2", { class: "bk-cm-name", id: titleId, text: charName(ch) }),
      ];
      if (traits.length) kids.push(el("ul", { class: "bk-traits" }, traits.map((t) => el("li", { text: t }))));
      if (str(ch.description)) kids.push(el("p", { class: "bk-cm-desc", text: str(ch.description) }));
      kids.push(portraitBlock(ch, (ctrl) => { portraitCtrl = ctrl; }));
      if (list.length > 1) {
        const prev = el("button", { type: "button", class: "bk-cm-arrow", "aria-label": T("char.prev"), html: ICON.left });
        const next = el("button", { type: "button", class: "bk-cm-arrow", "aria-label": T("char.next"), html: ICON.right });
        prev.addEventListener("click", () => { fill(i - 1); mountViewer(list[i]); });
        next.addEventListener("click", () => { fill(i + 1); mountViewer(list[i]); });
        kids.push(el("div", { class: "bk-cm-nav" }, prev, el("span", { class: "bk-cm-of", text: T("char.of", { i: i + 1, n: list.length }) }), next));
      }
      const scroller = info.closest(".modal");
      info.replaceChildren(...kids);
      if (scroller && scroller.scrollTop > 0 && window.matchMedia("(min-width: 760px)").matches) scroller.scrollTop = 0;
    };

    fill(i);
    const handle = await openModal(wrap, {
      labelledBy: titleId,
      className: "bk-modal bk-modal-char",
      closeLabel: T("modal.close"),
      onClose: () => {
        closed = true;
        modals.delete(handle);
        portraitCtrl?.abort();
        try { viewer?.dispose?.(); } catch { /* ignore */ }
        viewer = null;
      },
    });
    modals.add(handle);
    if (disposed) { handle.close(); return; }
    requestAnimationFrame(() => mountViewer(list[i]));
  }

  function portraitBlock(ch, setCtrl) {
    const name = charName(ch);
    const out = el("div", { class: "bk-ai", hidden: true, "aria-live": "polite" });
    const btn = el("button", { type: "button", class: "btn-glow bk-ai-btn" },
      el("span", { class: "bk-ai-label" }, icon("sparkle"), el("span", { text: T("char.aiPortrait") }), el("em", { class: "bk-premium", text: `✦ ${T("char.premium")}` })));
    const pkey = `${book.id}:${ch.id}`;

    const showImg = (url) => {
      const img = el("img", { class: "bk-ai-img", alt: T("char.portraitAlt", { name }), decoding: "async" });
      img.src = url;
      out.replaceChildren(el("figure", { class: "bk-ai-figure" }, img, el("figcaption", { text: T("char.portraitNote") })));
    };

    const reveal = () => requestAnimationFrame(() => { if (out.isConnected) out.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }); });
    const run = async () => {
      out.hidden = false;
      if (!health.portraits) {
        out.replaceChildren(el("div", { class: "bk-ai-off" },
          el("p", { class: "bk-ai-off-title" }, icon("sparkle"), el("span", { text: T("char.portraitOffTitle") })),
          el("p", { text: T("char.portraitOffText") })));
        reveal();
        return;
      }
      if (aiPortraits.has(pkey)) { showImg(aiPortraits.get(pkey)); return; }
      const api = await loadApi();
      let url = null;
      try { url = api?.portraitUrl ? api.portraitUrl(book, ch) : localPortraitUrl(book, ch); } catch { url = null; }
      if (!url) { out.replaceChildren(el("p", { class: "bk-ai-note", text: T("char.portraitNone") })); return; }
      const ctrl = new AbortController();
      setCtrl(ctrl);
      const timer = setTimeout(() => ctrl.abort(), 120000);
      btn.disabled = true;
      out.replaceChildren(el("div", { class: "bk-ai-loading" },
        el("span", { class: "bk-ai-canvas", "aria-hidden": "true" }),
        waitNote(T("char.portraitLoading"))));
      reveal();
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          let code = "upstream";
          try { code = (await res.json()).error || code; } catch { /* not JSON */ }
          throw Object.assign(new Error(code), { code });
        }
        if (!String(res.headers.get("content-type") || "").startsWith("image/")) throw Object.assign(new Error("bad_response"), { code: "bad_response" });
        const objectUrl = URL.createObjectURL(await res.blob());
        objectUrls.add(objectUrl);
        aiPortraits.set(pkey, objectUrl);
        if (out.isConnected) { showImg(objectUrl); reveal(); }
      } catch (err) {
        if (!out.isConnected || (err?.name === "AbortError" && !disposed && ctrl.signal.aborted && out.isConnected === false)) return;
        const msg = err?.name === "AbortError" ? T("char.portraitError") : (err?.code ? await errorMessage(err, lang) : T("char.portraitError"));
        const retry = el("button", { type: "button", class: "btn-ghost bk-retry" }, icon("refresh"), el("span", { text: T("char.portraitRetry") }));
        retry.addEventListener("click", run);
        out.replaceChildren(el("div", { class: "bk-ai-error", role: "alert" },
          el("p", {}, icon("alert"), el("span", { text: msg === tb(lang, "err.generic") ? T("char.portraitError") : msg })), retry));
        reveal();
      } finally {
        clearTimeout(timer);
        btn.disabled = false;
      }
    };
    btn.addEventListener("click", run);
    const block = el("div", { class: "bk-cm-premium" }, btn, out);
    if (aiPortraits.has(pkey)) { out.hidden = false; showImg(aiPortraits.get(pkey)); }
    return block;
  }

  // =============================================================================================
  // SIMILAR BOOKS
  // =============================================================================================

  function renderSimilar() {
    const s = secs.similar;
    sigs.similar = similarSig();
    setHead(s, T("similar.title"), T("similar.lead"));
    const st = partStatus(book, "overview");
    s.node.setAttribute("aria-busy", st === "loading" ? "true" : "false");
    if (st === "loading") {
      s.node.hidden = false;
      s.body.replaceChildren(waitNote(T("similar.loading")),
        el("ul", { class: "bk-similar is-skel", "aria-hidden": "true" }, Array.from({ length: 3 }, () => el("li", {},
          el("div", { class: "bk-sim" },
            el("span", { class: "skeleton bk-sim-cover" }),
            el("span", { class: "bk-sim-text" },
              el("span", { class: "skeleton", style: "width:70%;height:16px" }),
              el("span", { class: "skeleton", style: "width:44%;height:12px;margin-top:10px" }),
              el("span", { class: "skeleton", style: "width:94%;height:12px;margin-top:16px" })))))));
      return;
    }
    if (st === "error") {
      s.node.hidden = true; // the error (with retry) is shown once, in the retelling section
      s.body.replaceChildren();
      return;
    }
    const items = arr(book.similar).filter((x) => isObj(x) && str(x.title)).slice(0, 8);
    s.node.hidden = !items.length;
    if (!items.length) { s.body.replaceChildren(); return; }
    const coverSlots = [];
    const list = el("ul", { class: "bk-similar" }, items.map((it) => {
      const title = str(it.title);
      const coverSlot = el("span", { class: "bk-sim-cover", "aria-hidden": "true" });
      coverSlots.push({ node: coverSlot, title, author: str(it.author) });
      const btn = el("button", { type: "button", class: "bk-sim", "aria-label": T("similar.open", { title }) },
        coverSlot,
        el("span", { class: "bk-sim-text" },
          el("span", { class: "bk-sim-title", text: title }),
          str(it.author) ? el("span", { class: "bk-sim-author", text: str(it.author) }) : null,
          str(it.why) ? el("span", { class: "bk-sim-why", text: str(it.why) }) : null),
        el("span", { class: "bk-sim-go", "aria-hidden": "true", html: ICON.upRight }));
      btn.addEventListener("click", () => { stopReading(); opts.onSearch?.(title); });
      return el("li", {}, btn);
    }));
    s.body.replaceChildren(list);
    loadCovers().then((covers) => {
      if (disposed) return;
      for (const slot of coverSlots) {
        if (!slot.node.isConnected) continue;
        try {
          const cover = covers?.coverFromString ? covers.coverFromString(slot.title) : null;
          if (covers?.miniCoverSVG && cover) slot.node.innerHTML = covers.miniCoverSVG(cover, { title: slot.title, w: 64, h: 96 });
        } catch (err) { console.warn("[book] mini cover failed", err); }
      }
    });
  }
  const similarSig = () => json([partStatus(book, "overview"), book.similar, partError(book, "overview")]);

  // =============================================================================================
  // TRIP INTO THE BOOK — mini-film + premium AI video
  // =============================================================================================

  const film = {
    handle: null, stage: null, host: null, hud: null, sceneList: null, msg: null, endScreen: null,
    tts: store.get("bt-film-tts") !== "0", sync: 0, idleTimer: 0, starting: false,
  };
  let videoPanel = null;
  const video = { phase: "idle", jobs: [], urls: [], started: 0, ctrl: null, tick: 0, error: "", current: 0 };

  function disposeFilm() {
    if (film.sync) { stopEvery(film.sync); film.sync = 0; }
    clearTimeout(film.idleTimer);
    if (film.handle) {
      try { film.handle.dispose?.(); } catch (err) { console.warn("[book] film dispose failed", err); }
      film.handle = null;
    }
    if (isFullscreen(film.stage)) exitFullscreen();
    film.stage = film.host = film.hud = film.sceneList = film.msg = film.endScreen = null;
    film.starting = false;
  }

  function filmScenes() { return arr(book.film?.scenes).filter((x) => isObj(x)); }

  function renderFilmSection() {
    const s = secs.film;
    sigs.film = filmSig();
    disposeFilm();
    setHead(s, T("film.title"), T("film.lead"));
    const st = partStatus(book, "film");
    s.node.setAttribute("aria-busy", st === "loading" ? "true" : "false");
    if (st === "loading") {
      s.body.replaceChildren(el("div", { class: "bk-stage is-skel" },
        el("span", { class: "bk-stage-shimmer" }),
        el("div", { class: "bk-stage-center" }, waitNote(T("film.loading")))));
      return;
    }
    if (st === "error") {
      s.body.replaceChildren(errorBlock("film"));
      return;
    }
    const f = book.film;
    const scenes = filmScenes();
    const title = str(f.title) || str(book.title);
    const seconds = 14 + scenes.length * 9;
    const minutes = Math.max(1, Math.round(seconds / 60));
    const metaText = [scenes.length ? TN("film.scenes", scenes.length) : "", T("film.minutes", { n: minutes }), canSpeak() ? T("film.withVoice") : ""].filter(Boolean).join("  ·  ");

    // poster
    const playBtn = el("button", { type: "button", class: "bk-play", "aria-label": T("film.playLabel", { title }) }, el("span", { class: "bk-play-core", html: ICON.play }));
    playBtn.addEventListener("click", startFilm);
    const cast = el("div", { class: "bk-cast", "aria-hidden": "true" });
    const teaser = str(f.intro);
    const poster = el("div", { class: "bk-poster" },
      el("div", { class: "bk-poster-art", "aria-hidden": "true" }, el("span", { class: "bk-poster-stars" }), el("span", { class: "bk-poster-horizon" })),
      cast,
      el("div", { class: "bk-bar is-top", "aria-hidden": "true" }, el("span", { text: T("film.presents") })),
      el("div", { class: "bk-poster-copy" },
        el("p", { class: "bk-poster-kicker", text: str(book.title) }),
        el("h3", { class: "bk-poster-title", text: title }),
        teaser ? el("p", { class: "bk-poster-teaser", text: teaser }) : null,
        el("div", { class: "bk-poster-cta" }, playBtn, el("span", { class: "bk-play-label", "aria-hidden": "true", text: T("film.play") }))),
      el("div", { class: "bk-bar is-bottom", "aria-hidden": "true" }, el("span", { text: metaText })));
    poster.addEventListener("click", (e) => { if (e.target === poster || e.target.closest(".bk-poster-art, .bk-cast")) startFilm(); });

    const host = el("div", { class: "bk-film-host" });
    const msg = el("div", { class: "bk-stage-msg", hidden: true, role: "status" });
    const hud = buildHud();
    const endScreen = el("div", { class: "bk-end", hidden: true });
    const stage = el("div", { class: "bk-stage", role: "region", "aria-label": title }, host, poster, hud, endScreen, msg);
    film.stage = stage; film.host = host; film.hud = hud; film.msg = msg; film.endScreen = endScreen;

    on(stage, "pointermove", wakeHud);
    on(stage, "pointerdown", wakeHud);
    on(stage, "focusin", wakeHud);

    // scene strip: follows the film; a click jumps straight to that scene
    const sceneList = scenes.length ? el("ol", { class: "bk-scenes", "aria-label": T("film.scenesTitle") }, scenes.map((sc, n) => {
      const b = el("button", { type: "button", class: "bk-scene" },
        el("span", { class: "bk-scene-n", text: pad2(n + 1) }), el("span", { class: "bk-scene-t", text: str(sc.title) || pad2(n + 1) }));
      b.addEventListener("click", () => playScene(n));
      return el("li", { class: "bk-scene-li" }, b);
    })) : null;
    film.sceneList = sceneList;

    videoPanel = el("div", { class: "bk-video glass" });
    const teaserBelow = teaser ? el("p", { class: "bk-teaser-below", text: teaser }) : null;
    s.body.replaceChildren(stage, teaserBelow || "", sceneList || "", videoPanel);
    renderVideoPanel();
    fillCast(cast, stage);
  }
  const filmSig = () => json([partStatus(book, "film"), book.film, partError(book, "film"), arr(book.characters).map((c) => [c?.id, c?.name, c?.appearance])]);

  /** Ensemble of the most frequent cast members standing on the poster (transparent portraits). */
  function fillCast(castNode, stage) {
    const chars = currentChars();
    if (!chars.length) return;
    const freq = new Map();
    for (const sc of filmScenes()) for (const id of arr(sc.cast)) freq.set(id, (freq.get(id) || 0) + 1);
    let picked = chars.filter((c) => freq.has(c.id)).sort((a, b) => freq.get(b.id) - freq.get(a.id)).slice(0, 3);
    if (!picked.length) picked = chars.slice(0, 3);
    // the lead in the middle, the others around
    const order = picked.length >= 3 ? [picked[1], picked[0], picked[2]] : picked;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const vx = await loadVoxel();
      if (disposed || !vx?.renderPortrait) return;
      for (const [n, ch] of order.entries()) {
        try {
          const url = await vx.renderPortrait(ch.appearance, { size: 384, background: "transparent" });
          if (disposed || !castNode.isConnected) return;
          const img = el("img", { class: "bk-cast-img", alt: "", decoding: "async", draggable: "false" });
          img.style.setProperty("--n", String(n));
          img.dataset.lead = ch === picked[0] ? "1" : "0";
          img.src = url;
          castNode.append(img);
          requestAnimationFrame(() => img.classList.add("is-in"));
        } catch { /* skip this one */ }
      }
    }, { rootMargin: "400px 0px" });
    io.observe(stage);
    cleanups.push(() => io.disconnect());
  }

  function buildHud() {
    const mk = (cls, label, iconName) => {
      const b = el("button", { type: "button", class: `bk-hud-btn ${cls}`, "aria-label": label, title: label, html: ICON[iconName] });
      return b;
    };
    const playPause = mk("is-pp", T("film.pause"), "pause");
    const restart = mk("is-restart", T("film.restart"), "restart");
    const voice = mk("is-voice", film.tts ? T("film.voiceOn") : T("film.voiceOff"), film.tts ? "voice" : "mute");
    voice.setAttribute("aria-pressed", film.tts ? "true" : "false");
    const full = mk("is-full", T("film.fullscreen"), "full");
    const now = el("span", { class: "bk-hud-now", "aria-live": "polite" });
    playPause.addEventListener("click", () => {
      const h = film.handle;
      if (!h) return;
      try { if (h.playing) h.pause(); else { stopReading(); h.play(); } } catch (err) { console.warn(err); }
      syncHud();
    });
    restart.addEventListener("click", () => {
      const h = film.handle;
      if (!h) return;
      stopReading();
      film.endScreen.hidden = true;
      film.stage?.classList.remove("is-ended");
      try { h.restart(); h.play?.(); } catch (err) { console.warn(err); }
      syncHud();
    });
    voice.addEventListener("click", () => {
      film.tts = !film.tts;
      store.set("bt-film-tts", film.tts ? "1" : "0");
      try { film.handle?.setTts?.(film.tts); } catch { /* optional API */ }
      if (!film.tts && canSpeak() && !tts.active) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
      voice.innerHTML = film.tts ? ICON.voice : ICON.mute;
      const label = film.tts ? T("film.voiceOn") : T("film.voiceOff");
      voice.setAttribute("aria-label", label);
      voice.title = label;
      voice.setAttribute("aria-pressed", film.tts ? "true" : "false");
    });
    full.addEventListener("click", () => {
      if (isFullscreen(film.stage)) exitFullscreen();
      else requestFullscreen(film.stage);
    });
    if (!fullscreenSupported()) full.hidden = true;
    return el("div", { class: "bk-hud", hidden: true },
      el("div", { class: "bk-hud-group" }, playPause, restart),
      now,
      el("div", { class: "bk-hud-group" }, voice, full));
  }

  function syncHud() {
    const h = film.handle;
    if (!h || !film.hud) return;
    let playing = false;
    try { playing = Boolean(h.playing); } catch { playing = false; }
    const pp = film.hud.querySelector(".is-pp");
    const want = playing ? "pause" : "play";
    if (pp && pp.dataset.icon !== want) {
      pp.dataset.icon = want;
      pp.innerHTML = ICON[want];
      const label = playing ? T("film.pause") : T("film.resume");
      pp.setAttribute("aria-label", label);
      pp.title = label;
    }
    film.stage?.classList.toggle("is-paused", !playing);
  }

  function wakeHud() {
    const stage = film.stage;
    if (!stage || !film.handle) return;
    stage.classList.remove("hud-idle");
    clearTimeout(film.idleTimer);
    film.idleTimer = setTimeout(() => {
      let playing = false;
      try { playing = Boolean(film.handle?.playing); } catch { /* ignore */ }
      if (playing && !stage.contains(document.activeElement)) stage.classList.add("hud-idle");
    }, 2600);
  }

  function markScene(i) {
    const n = Number(i);
    const list = film.sceneList ? [...film.sceneList.querySelectorAll(".bk-scene")] : [];
    list.forEach((b, k) => {
      b.classList.toggle("is-current", k === n);
      b.classList.toggle("is-past", k < n);
      if (k === n) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    });
    const now = film.hud?.querySelector(".bk-hud-now");
    const sc = filmScenes()[n];
    if (now) now.textContent = sc ? `${pad2(n + 1)} / ${pad2(filmScenes().length)}  ${str(sc.title)}` : "";
  }

  async function startFilm() {
    const stage = film.stage;
    if (!stage || film.starting) return;
    if (film.handle) {
      try { film.handle.play(); } catch { /* ignore */ }
      syncHud();
      return;
    }
    stopReading();
    film.starting = true;
    stage.classList.add("is-starting");
    film.msg.hidden = false;
    film.msg.replaceChildren(waitNote(T("film.preparing")));
    const mod = await loadFilm();
    if (disposed || film.stage !== stage) return;
    film.starting = false;
    if (!mod || typeof mod.createFilm !== "function") {
      stage.classList.remove("is-starting");
      film.msg.replaceChildren(el("p", { class: "bk-stage-note" }, icon("info"), el("span", { text: T("film.missing") })));
      setTimeout(() => { if (film.msg && film.stage === stage) film.msg.hidden = true; }, 4200);
      return;
    }
    try {
      const filmOpts = {
        book,
        lang,
        controls: false, // this page draws its own HUD (play/pause, restart, voice, fullscreen)
        onScene: (i) => { if (!disposed) markScene(i); },
        onEnd: () => { if (!disposed) onFilmEnd(); },
      };
      // read lazily so a module that checks opts.tts on every line follows the voice toggle
      Object.defineProperty(filmOpts, "tts", { enumerable: true, get: () => film.tts });
      film.handle = mod.createFilm(film.host, filmOpts);
      film.handle?.play?.();
      stage.classList.remove("is-starting");
      stage.classList.add("is-playing");
      film.msg.hidden = true;
      film.hud.hidden = false;
      film.sync = every(syncHud, 400);
      syncHud();
      wakeHud();
      film.hud.querySelector(".is-pp")?.focus({ preventScroll: true });
    } catch (err) {
      console.error("[book] createFilm failed", err);
      try { film.handle?.dispose?.(); } catch { /* ignore */ }
      film.handle = null;
      stage.classList.remove("is-starting", "is-playing");
      film.msg.hidden = false;
      film.msg.replaceChildren(el("p", { class: "bk-stage-note" }, icon("alert"), el("span", { text: T("film.failed") })));
    }
  }

  async function playScene(n) {
    if (!film.handle) await startFilm();
    const h = film.handle;
    if (!h || disposed) return;
    try {
      if (typeof h.seek === "function") h.seek(n);
      if (!h.playing) { stopReading(); h.play(); }
    } catch (err) { console.warn("[book] seek failed", err); }
    if (film.endScreen) film.endScreen.hidden = true;
    film.stage?.classList.remove("is-ended");
    markScene(n);
    syncHud();
    wakeHud();
    const r = film.stage?.getBoundingClientRect();
    if (r && (r.top < stickyOffset() - 40 || r.bottom > window.innerHeight)) {
      window.scrollTo({ top: Math.max(0, r.top + window.scrollY - stickyOffset()), behavior: reduced ? "auto" : "smooth" });
    }
  }

  function onFilmEnd() {
    const end = film.endScreen;
    if (!end) return;
    film.stage.classList.add("is-ended");
    markScene(-1);
    const replay = el("button", { type: "button", class: "btn-glow bk-replay" }, icon("restart"), el("span", { text: T("film.replay") }));
    replay.addEventListener("click", () => {
      end.hidden = true;
      film.stage?.classList.remove("is-ended");
      stopReading();
      try { film.handle?.restart(); film.handle?.play?.(); } catch (err) { console.warn(err); }
      syncHud();
    });
    end.replaceChildren(el("div", { class: "bk-end-in" },
      el("p", { class: "bk-end-kicker", text: str(book.film?.title) || str(book.title) }),
      el("p", { class: "bk-end-title", text: T("film.ended") }),
      replay));
    end.hidden = false;
    syncHud();
    replay.focus({ preventScroll: true });
  }

  // ---- fullscreen ----
  function fullscreenSupported() {
    return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }
  function isFullscreen(node) {
    const cur = document.fullscreenElement || document.webkitFullscreenElement;
    return Boolean(node && cur === node);
  }
  function requestFullscreen(node) {
    if (!node) return;
    const fn = node.requestFullscreen || node.webkitRequestFullscreen;
    try { const p = fn?.call(node); p?.catch?.(() => {}); } catch { /* ignore */ }
  }
  function exitFullscreen() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    try { const p = fn?.call(document); p?.catch?.(() => {}); } catch { /* ignore */ }
  }
  const onFsChange = () => {
    const full = film.hud?.querySelector(".is-full");
    if (!full) return;
    const isFull = isFullscreen(film.stage);
    full.innerHTML = isFull ? ICON.unfull : ICON.full;
    const label = isFull ? T("film.exitFullscreen") : T("film.fullscreen");
    full.setAttribute("aria-label", label);
    full.title = label;
    film.stage?.classList.toggle("is-full", isFull);
  };
  on(document, "fullscreenchange", onFsChange);
  on(document, "webkitfullscreenchange", onFsChange);

  // ---- premium AI video ----
  function videoPrompts() { return arr(book.film?.videoPrompts).filter((p) => typeof p === "string" && p.trim()); }

  function renderVideoPanel() {
    const p = videoPanel;
    if (!p || !p.isConnected && disposed) return;
    const v = video;
    p.dataset.phase = v.phase;
    const head = (titleText, sub) => el("div", { class: "bk-video-head" },
      el("span", { class: "bk-video-ico", html: ICON.video }),
      el("div", { class: "bk-video-copy" },
        el("h3", { class: "bk-video-title" }, el("span", { text: titleText }), el("em", { class: "bk-premium", text: `✦ ${T("video.premium")}` })),
        sub ? el("p", { class: "bk-video-lead", text: sub }) : null));

    if (v.phase === "starting" || v.phase === "running") {
      const done = v.urls.filter(Boolean).length;
      const bar = el("span", { class: "bk-progress-bar" });
      const clips = el("ol", { class: "bk-clips" }, [0, 1, 2].map((n) => el("li", { class: v.urls[n] ? "is-ready" : "" },
        el("span", { class: "bk-clip-dot", "aria-hidden": "true" }),
        el("span", { text: `${T("video.clip", { n: n + 1 })} · ${v.urls[n] ? T("video.clipReady") : T("video.clipWaiting")}` }))));
      const elapsed = el("span", { class: "bk-elapsed" });
      p.replaceChildren(
        head(T("video.title"), v.phase === "starting" ? T("video.starting") : T("video.progress")),
        el("div", { class: "bk-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "3", "aria-valuenow": String(done), "aria-label": T("video.title") }, bar),
        el("div", { class: "bk-progress-row" }, clips, elapsed));
      const tick = () => {
        const secs = Math.round((Date.now() - v.started) / 1000);
        elapsed.textContent = T("video.elapsed", { s: secs });
        const est = Math.min(0.94, secs / 150);
        bar.style.transform = `scaleX(${Math.max(done / 3, est, 0.03).toFixed(3)})`;
      };
      tick();
      if (v.tick) stopEvery(v.tick);
      v.tick = every(() => { if (!bar.isConnected) { stopEvery(v.tick); v.tick = 0; return; } tick(); }, 1000);
      return;
    }
    if (v.tick) { stopEvery(v.tick); v.tick = 0; }

    if (v.phase === "done") {
      const urls = v.urls.filter(Boolean);
      const player = el("video", { class: "bk-video-player", controls: true, playsinline: true, preload: "metadata" });
      const pick = (n, autoplay) => {
        v.current = n;
        player.src = urls[n];
        if (autoplay) player.play?.().catch(() => {});
        list.querySelectorAll("button").forEach((b, k) => b.setAttribute("aria-current", k === n ? "true" : "false"));
      };
      const list = el("div", { class: "bk-playlist" }, urls.map((_, n) => {
        const b = el("button", { type: "button", class: "bk-clip-btn" }, icon("play"), el("span", { text: T("video.clip", { n: n + 1 }) }));
        b.addEventListener("click", () => pick(n, true));
        return b;
      }));
      player.addEventListener("ended", () => { if (v.current < urls.length - 1) pick(v.current + 1, true); });
      p.replaceChildren(head(T("video.done")), el("div", { class: "bk-player-wrap" }, player), list);
      pick(Math.min(v.current, urls.length - 1), false);
      return;
    }

    const btn = el("button", { type: "button", class: "btn-glow bk-video-cta" }, icon("sparkle"), el("span", { text: v.phase === "error" ? T("video.retry") : T("video.cta") }));
    btn.addEventListener("click", onVideoClick);
    const kids = [head(T("video.title"), T("video.lead"))];
    if (v.phase === "error") kids.push(el("p", { class: "bk-video-error", role: "alert" }, icon("alert"), el("span", { text: v.error || T("video.failed") })));
    kids.push(el("div", { class: "bk-video-actions" }, btn));
    p.replaceChildren(...kids);
  }

  function onVideoClick() {
    if (!health.video) { openVideoOffer(); return; }
    if (videoPrompts().length < 3) { notify(T("video.noPrompts")); return; }
    if (health.premiumCodeRequired === false) {
      beginVideo("").catch(async (err) => {
        video.phase = "error";
        video.error = await errorMessage(err, lang);
        renderVideoPanel();
      });
      return;
    }
    openCodeModal();
  }

  async function beginVideo(code) {
    video.ctrl?.abort();
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    Object.assign(video, { phase: "starting", jobs: [], urls: [null, null, null], started: Date.now(), ctrl, error: "", current: 0 });
    renderVideoPanel();
    let jobs;
    try {
      ({ jobs } = await videoApi.start(book, code, { signal }));
      if (!jobs?.length) throw Object.assign(new Error("no jobs"), { code: "upstream" });
    } catch (err) {
      if (video.ctrl === ctrl) { video.phase = "idle"; renderVideoPanel(); }
      throw err;
    }
    if (disposed || video.ctrl !== ctrl) return;
    video.jobs = jobs.slice(0, 3);
    video.urls = video.jobs.map(() => null);
    video.phase = "running";
    renderVideoPanel();
    pollVideos(ctrl);
  }

  async function pollVideos(ctrl) {
    const signal = ctrl.signal;
    const deadline = Date.now() + 12 * 60 * 1000;
    try {
      while (video.urls.some((u) => !u)) {
        if (Date.now() > deadline) throw Object.assign(new Error("timeout"), { code: "video_timeout" });
        await sleep(6000, signal);
        for (const [n, job] of video.jobs.entries()) {
          if (video.urls[n]) continue;
          const r = await videoApi.poll(job, { signal });
          if (r?.done && r.url) { video.urls[n] = r.url; renderVideoPanel(); }
        }
      }
      if (disposed || video.ctrl !== ctrl) return;
      video.phase = "done";
      renderVideoPanel();
      notify(T("video.doneToast"));
    } catch (err) {
      if (err?.name === "AbortError" || disposed || video.ctrl !== ctrl) return;
      video.phase = "error";
      video.error = err?.code === "video_timeout" ? T("video.timeout") : T("video.failed");
      renderVideoPanel();
    }
  }

  async function openCodeModal() {
    const titleId = uid("bk-code-h");
    const fid = uid("bk-code");
    const input = el("input", { id: fid, class: "bk-input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: T("video.codePh"), enterkeyhint: "go" });
    input.value = store.get("bt-premium-code") || "";
    const errorNode = el("p", { class: "bk-form-error", role: "alert", hidden: true });
    const submit = el("button", { type: "submit", class: "btn-glow" }, icon("sparkle"), el("span", { text: T("video.start") }));
    const cancel = el("button", { type: "button", class: "btn-ghost", text: T("video.cancel") });
    const form = el("form", { class: "bk-code", novalidate: true },
      el("span", { class: "bk-offer-badge", html: ICON.video }),
      el("h2", { id: titleId, class: "bk-modal-h", text: T("video.codeTitle") }),
      el("p", { class: "bk-modal-p", text: T("video.codeText") }),
      el("label", { class: "bk-field-label", for: fid, text: T("video.codeLabel") }),
      input, errorNode,
      el("div", { class: "bk-modal-actions" }, cancel, submit));
    let handle = null;
    let busy = false;
    const fail = (text) => { errorNode.textContent = text; errorNode.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const code = input.value.trim();
      if (!code) { fail(T("video.codeEmpty")); return; }
      busy = true;
      submit.disabled = true;
      errorNode.hidden = true;
      input.removeAttribute("aria-invalid");
      try {
        const started = beginVideo(code);
        await started;
        store.set("bt-premium-code", code);
        handle?.close();
      } catch (err) {
        if (err?.code === "forbidden") fail(T("video.codeWrong"));
        else fail(await errorMessage(err, lang));
      } finally {
        busy = false;
        submit.disabled = false;
      }
    });
    cancel.addEventListener("click", () => handle?.close());
    handle = await openModal(form, { labelledBy: titleId, className: "bk-modal bk-modal-narrow", closeLabel: T("modal.close"), onClose: () => modals.delete(handle) });
    modals.add(handle);
    setTimeout(() => input.focus(), 60);
  }

  async function openVideoOffer() {
    const titleId = uid("bk-offer-h");
    const ok = el("button", { type: "button", class: "btn-glow bk-offer-ok", text: T("video.ok") });
    const content = el("div", { class: "bk-offer" },
      el("div", { class: "bk-offer-art", "aria-hidden": "true" },
        el("span", { class: "bk-offer-strip" }, Array.from({ length: 3 }, (_, n) => el("span", { class: "bk-offer-frame", style: `--n:${n}` }))),
        el("span", { class: "bk-offer-badge", html: ICON.video })),
      el("h2", { id: titleId, class: "bk-modal-h", text: T("video.offTitle") }),
      el("p", { class: "bk-modal-p", text: T("video.offText") }),
      el("ul", { class: "bk-offer-points" }, ["video.offPoint1", "video.offPoint2", "video.offPoint3"].map((k) => el("li", {}, icon("check"), el("span", { text: T(k) })))),
      el("div", { class: "bk-modal-actions" }, ok));
    let handle = null;
    ok.addEventListener("click", () => handle?.close());
    handle = await openModal(content, { labelledBy: titleId, className: "bk-modal bk-modal-offer", closeLabel: T("modal.close"), onClose: () => modals.delete(handle) });
    modals.add(handle);
  }

  // =============================================================================================
  // FOOTER
  // =============================================================================================

  function renderFooter() {
    const more = el("button", { type: "button", class: "btn-glow bk-more" }, icon("search"), el("span", { text: T("footer.more") }));
    more.addEventListener("click", () => { stopReading(); opts.onBack?.(); });
    footer.replaceChildren(el("div", { class: "bk-wrap" },
      el("div", { class: "bk-foot-card glass" },
        el("span", { class: "bk-foot-ico", html: ICON.book }),
        el("div", { class: "bk-foot-copy" },
          el("h2", { class: "bk-foot-title", text: T("footer.title") }),
          el("p", { class: "bk-foot-lead", text: T("footer.lead") })),
        typeof opts.onBack === "function" ? more : null),
      el("p", { class: "bk-foot-note" }, icon("info"), el("span", { text: T("footer.disclaimer") }))));
  }

  // =============================================================================================
  // render / update / dispose
  // =============================================================================================

  const RENDER = { summary: renderSummary, terms: renderTerms, characters: renderChars, similar: renderSimilar, film: renderFilmSection };
  const SIG = { summary: summarySig, terms: termsSig, characters: charsSig, similar: similarSig, film: filmSig };

  function safely(name, fn) {
    try { fn(); } catch (err) {
      console.error(`[book] rendering "${name}" failed`, err);
      const s = secs[name];
      if (s) s.body.replaceChildren(el("p", { class: "bk-empty", text: T("err.generic") }));
    }
  }

  /** Run `fn` (which may change heights) without moving what the visitor is looking at. */
  function preserveScroll(fn) {
    if (window.scrollY < 4) { fn(); return; }
    const anchors = [hero, ...SECTIONS.map((s) => secs[s.name].node), footer];
    const offset = stickyOffset();
    const anchor = anchors.find((n) => !n.hidden && n.getBoundingClientRect().bottom > offset);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    fn();
    if (!anchor || !anchor.isConnected) return;
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 1) window.scrollTo(0, window.scrollY + delta);
  }

  safely("hero", renderHero);
  for (const s of SECTIONS) safely(s.name, RENDER[s.name]);
  renderFooter();
  syncSections();

  // Sections fade up once when they first scroll into view (never with reduced motion).
  if (!reduced && typeof IntersectionObserver === "function") {
    const reveal = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        reveal.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -12% 0px" });
    for (const s of SECTIONS) {
      const node = secs[s.name].node;
      const r = node.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.88) { node.classList.add("is-in"); continue; }
      node.classList.add("bk-reveal");
      reveal.observe(node);
    }
    cleanups.push(() => reveal.disconnect());
  } else {
    for (const s of SECTIONS) secs[s.name].node.classList.add("is-in");
  }

  function update(next) {
    if (disposed || !isObj(next)) return;
    book = next;
    preserveScroll(() => {
      if (heroSig() !== sigs.hero) safely("hero", renderHero);
      else if (json(book.themes) !== sigs.themes) fillThemes();
      for (const s of SECTIONS) if (SIG[s.name]() !== sigs[s.name]) safely(s.name, RENDER[s.name]);
      syncSections();
    });
    syncListen();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopReading();
    video.ctrl?.abort();
    disposeFilm();
    for (const id of intervals) clearInterval(id);
    intervals.clear();
    for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
    for (const m of [...modals]) { try { m.close(); } catch { /* ignore */ } }
    modals.clear();
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.clear();
    cardCache.clear();
    page.remove();
  }

  return { update, dispose };
}
