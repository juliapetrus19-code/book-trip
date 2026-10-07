// BookTrip — application layer (owned by app): boot, hash router, search box + search flow,
// live book loading, view transitions, modals, toasts and the site footer.
//
// Public API for other modules:
//   openModal(contentNode, { label, labelledBy, className, onClose }) → { node, close() }
//   toast(message, { error, duration })
//   errorText(err) → localised message for an ApiError-like { code }
//
// Routes: "/" home · "/book/<id>" (real path, history.pushState) · "/#/q/<query>" search ·
// "#/how" "#/library" "#/premium" (modals over the current path, e.g. "/book/<id>#/how").
// Legacy "#/book/<id>" links are rewritten to "/book/<id>". All app styles that are not in
// base/home/book.css are injected below. Account, paywall and checkout live in js/account.js.

import { t, tn, getLang, setLang, applyI18n, formatYear, setVariant } from "./i18n.js";
import * as api from "./api.js";
import * as account from "./account.js";
import { el, prefersReducedMotion, normalizeQuery, safeColor, store } from "./util.js";

const $ = (sel, root = document) => root.querySelector(sel);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = () => prefersReducedMotion();
const enc = encodeURIComponent;
const ID_RE = /^[a-z0-9-]{1,100}$/;

const state = {
  booted: false,
  view: null,          // "home" | "book"
  seq: 0,              // navigation token: async work checks it before touching the DOM
  book: null,          // BookView currently shown
  bookView: null,      // handle from renderBook()
  session: null,       // live loading session of the current book
  search: null,        // { ctrl, query } of the running search
  loading: null,       // loading overlay handle
  routeModal: null,    // { name, handle }
  ring: null,
  histIdx: 0,          // index of the current history entry inside the app (0 = first page)
  pendingFocus: false,
  lastHref: "",        // location.href the router last handled (popstate + hashchange both fire)
  routeWaiters: [],    // resolvers waiting for the next route() (see nextRoute)
  transient: new Set(),// modals that close on any route change (demo notice, paywall, login…)
  allowed: new Set(),  // book ids /api/access allowed in this visit
  freeLeft: null,      // last known number of free books left (paywall on, not subscribed)
  subscribed: false,
  blocked: null,       // id of the book the paywall stopped
};

// Lazily loaded sibling modules (each may still be missing while the team works in parallel).
const lazy = (loader) => {
  let p = null;
  return () => (p ||= loader().catch((err) => {
    console.warn("[app] optional module failed to load:", err && err.message);
    p = null;
    return null;
  }));
};
const loadCovers = lazy(() => import("./covers.js"));
const loadRing = lazy(() => import("./ring.js"));
const loadStars = lazy(() => import("./stars.js"));
const loadBookView = lazy(() => import("./book-view.js"));
let covers = null; // resolved covers module (sync access for thumbnails)

// ---------------------------------------------------------------------------------------------
// Icons (trusted static markup)

const svg = (body, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  sparkle: svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  how: [
    svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.6-4.6"/><path d="M7.8 9.4h5.4M7.8 12h3.6"/>'),
    svg('<path d="M3 6.8c3-1.3 6-1.1 9 .7 3-1.8 6-2 9-.7v12c-3-1.3-6-1.1-9 .7-3-1.8-6-2-9-.7z"/><path d="M12 7.5v12"/><path d="M17.6 1.8l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z"/>'),
    svg('<rect x="6.5" y="2.8" width="11" height="9.4" rx="1.6"/><path d="M10 7v1.4M14 7v1.4"/><path d="M7.5 21.2v-4.4a2.6 2.6 0 0 1 2.6-2.6h3.8a2.6 2.6 0 0 1 2.6 2.6v4.4"/><path d="M4.5 21.2h15"/>'),
    svg('<rect x="2.8" y="5" width="18.4" height="14" rx="2.6"/><path d="M10.2 9.3v5.4l4.6-2.7z"/><path d="M2.8 9h2.4M2.8 15h2.4M18.8 9h2.4M18.8 15h2.4"/>'),
  ],
  portrait: svg('<rect x="4" y="2.8" width="16" height="18.4" rx="2.6"/><circle cx="12" cy="10" r="3.2"/><path d="M7.2 18.2c1.1-2.4 2.8-3.5 4.8-3.5s3.7 1.1 4.8 3.5"/>'),
  video: svg('<rect x="2.5" y="6" width="13.2" height="12" rx="2.6"/><path d="M15.7 10.4 21.5 7v10l-5.8-3.4z"/>'),
  infinity: svg('<path d="M7.6 8.6c-2.3 0-4.1 1.5-4.1 3.4s1.8 3.4 4.1 3.4c3.6 0 5.2-6.8 8.8-6.8 2.3 0 4.1 1.5 4.1 3.4s-1.8 3.4-4.1 3.4c-3.6 0-5.2-6.8-8.8-6.8z"/>'),
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.6 17.6 2.8 8.4l5.1 3.9L12 5.2l4.1 7.1 5.1-3.9-.8 9.2z"/></svg>',
  library: svg('<path d="M4 4.5v15M8 4.5v15M12.5 5l3.6 14.2M17 5.2l3.4 13.6"/><path d="M3 19.5h18"/>'),
  search: svg('<circle cx="11" cy="11" r="6.6"/><path d="M20 20l-4.2-4.2"/>'),
};

// ---------------------------------------------------------------------------------------------
// Toast

let toastTimer = 0;
/** Short status message in #toast (aria-live). */
export function toast(message, { error = false, duration = 3800 } = {}) {
  const node = $("#toast");
  if (!node || !message) return;
  node.textContent = String(message);
  node.classList.toggle("is-error", Boolean(error));
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), duration);
}

/** Localised text for an error code ({ code } from js/api.js). */
export function errorText(err) {
  const code = (err && err.code) || "generic";
  const key = `errors.${code}`;
  const text = t(key);
  return text === key ? t("errors.generic") : text;
}

// ---------------------------------------------------------------------------------------------
// Modals: role=dialog, aria-modal, focus trap, Esc, click outside, focus restore, background inert

const modalStack = [];

/**
 * Open an accessible modal dialog with `content` (a Node). Returns { node, close() }.
 * onClose(reason) gets "user" (close button / Esc / backdrop) or "api".
 */
export function openModal(content, { label = "", labelledBy = "", className = "", onClose } = {}) {
  const host = $("#modal-root") || document.body;
  const prevFocus = document.activeElement;
  const closeBtn = el("button", { type: "button", class: "modal-close", "aria-label": t("modal.close"), html: ICON.close });
  const dialog = el("div", {
    class: `modal ${className}`.trim(),
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": labelledBy || null,
    "aria-label": labelledBy ? null : label || null,
    tabindex: "-1",
  }, closeBtn, content);
  const backdrop = el("div", { class: "modal-backdrop bt-backdrop" }, dialog);
  host.append(backdrop);

  let closed = false;
  const handle = {
    node: dialog,
    backdrop,
    focusRoot: dialog,
    escape: () => handle.close("user"),
    close(reason = "api") {
      if (closed) return;
      closed = true;
      const i = modalStack.indexOf(handle);
      if (i >= 0) modalStack.splice(i, 1);
      syncBlockers();
      backdrop.classList.add("is-closing");
      setTimeout(() => backdrop.remove(), reduced() ? 0 : 200);
      const top = blockers().at(-1);
      if (prevFocus?.isConnected && typeof prevFocus.focus === "function" && (!top || top.focusRoot.contains(prevFocus))) {
        prevFocus.focus({ preventScroll: true });
      }
      try { onClose?.(reason); } catch (err) { console.error(err); }
    },
  };
  closeBtn.addEventListener("click", () => handle.close("user"));
  let downOnBackdrop = false;
  backdrop.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && downOnBackdrop) handle.close("user"); });

  modalStack.push(handle);
  syncBlockers();
  dialog.focus({ preventScroll: true });
  return handle;
}

/** Everything that blocks the page (loading overlay below, modals above), bottom → top. */
function blockers() {
  return [...(state.loading ? [state.loading] : []), ...modalStack];
}

function syncBlockers() {
  const list = blockers();
  const top = list[list.length - 1] || null;
  const blocked = list.length > 0;
  for (const node of [$("#main"), $("#nav"), $(".skip-link"), $("#site-footer")]) if (node) node.inert = blocked;
  for (const b of list) b.backdrop.inert = b !== top;
  const root = document.documentElement;
  if (blocked && !root.classList.contains("bt-lock")) {
    const gap = window.innerWidth - root.clientWidth;
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  } else if (!blocked) {
    document.body.style.paddingRight = "";
  }
  root.classList.toggle("bt-lock", blocked);
  // The spinning ring under a blurred backdrop is expensive: rest it while something covers it.
  if (blocked) state.ring?.pause?.();
  else if (state.view === "home") state.ring?.resume?.();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e, root) {
  const items = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length && !n.closest("[inert]"));
  if (!items.length) { e.preventDefault(); root.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = !root.contains(active) || active === root;
  if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
}

// ---------------------------------------------------------------------------------------------
// History + router

function parseHash(hash = location.hash) {
  const h = String(hash || "").replace(/^#/, "");
  if (!h || h === "/") return { name: "home" };
  if (!h.startsWith("/")) return null; // e.g. "#main" from the skip link: not a route
  const [, head = "", ...rest] = h.split("/");
  const tail = rest.join("/");
  let decoded = tail;
  try { decoded = decodeURIComponent(tail); } catch { /* keep raw */ }
  if (head === "book" && tail) return { name: "book", id: decoded.trim().toLowerCase() };
  if (head === "q" && tail) return { name: "search", query: decoded };
  if (head === "how" || head === "library" || head === "premium") return { name: "modal", modal: head };
  return { name: "home" };
}

const BOOK_PATH = /^\/book\/([^/]+)\/?$/;
const bookPath = (id) => `/book/${enc(id)}`;

/**
 * The current route from path + hash: { name: "home"|"book"|"search"|"modal", id?, query?, modal?,
 * base? (the view under a modal), legacy? (a "#/book/<id>" link) } or null (e.g. "#main").
 */
function parseRoute() {
  const h = parseHash();
  if (h?.name === "book") return { ...h, legacy: true };
  const m = BOOK_PATH.exec(location.pathname);
  if (m) {
    let id = m[1];
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const book = { name: "book", id: id.trim().toLowerCase() };
    if (h?.name === "modal") return { ...h, base: book };
    if (h?.name === "search") return h;
    return book;
  }
  if (h?.name === "modal") return { ...h, base: { name: "home" } };
  return h;
}

/** Where an in-app link points: modals overlay the current path, search lives on "/", books on "/book/<id>". */
function hrefFor(to) {
  const s = String(to || "/");
  if (!s.startsWith("#")) return s.startsWith("/#") ? hrefFor(s.slice(1)) : s;
  const r = parseHash(s);
  if (r?.name === "modal") return location.pathname + location.search + s;
  if (r?.name === "book") return bookPath(r.id);
  if (!r || r.name === "home") return "/";
  return "/" + s;
}

/** Give every history entry an index so we know whether "back" stays inside the app. */
function stampHistory() {
  const st = history.state;
  if (st && Number.isInteger(st.btIdx)) state.histIdx = st.btIdx;
  else {
    state.histIdx += 1;
    history.replaceState({ ...(st && typeof st === "object" ? st : {}), btIdx: state.histIdx }, "");
  }
}

/** Go to "#/…" (hash route / modal) or "/book/<id>" / "/" without reloading the page. */
export function navigate(to, { replace = false } = {}) {
  const url = new URL(hrefFor(to), location.href).href;
  if (url === location.href && !replace) { route(); return; }
  if (replace) history.replaceState({ btIdx: state.histIdx }, "", url);
  else {
    state.histIdx += 1;
    history.pushState({ btIdx: state.histIdx }, "", url);
  }
  route();
}

/** Back inside the app, or to `fallback` when this is the first page of the visit. */
function goBack(fallback = "/") {
  if (state.histIdx > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** The URL of the view under a route modal (current path without the hash). */
const baseHref = () => location.pathname + location.search;

/** Resolves after the next route() (or after `timeout` ms, e.g. when history.back() leaves the app). */
function nextRoute(timeout = 700) {
  return new Promise((resolve) => {
    state.routeWaiters.push(resolve);
    setTimeout(resolve, timeout);
  });
}

function onHistoryChange() {
  if (location.href === state.lastHref) return; // popstate and hashchange for the same step
  stampHistory();
  route();
}

function route() {
  state.lastHref = location.href;
  const r = parseRoute();
  if (r) {
    closeTransient();
    if (r.legacy) {
      history.replaceState({ ...(history.state && typeof history.state === "object" ? history.state : {}), btIdx: state.histIdx }, "", bookPath(r.id));
      route();
      return;
    }
    if (r.name === "modal") {
      const base = r.base;
      if (base.name === "book" && ID_RE.test(base.id)) {
        if (!(state.view === "book" && state.book?.id === base.id)) openBook(base.id);
      } else if (state.view !== "home") showHome({ animate: Boolean(state.view) });
      openRouteModal(r.modal);
    } else {
      closeRouteModal();
      if (r.name !== "search" || r.query !== state.search?.query) abortSearch();
      if (r.name === "home") showHome();
      else if (r.name === "book") {
        if (ID_RE.test(r.id)) openBook(r.id);
        else navigate("/", { replace: true });
      } else if (r.name === "search") runSearch(r.query);
    }
    window.dispatchEvent(new CustomEvent("bt:route"));
  }
  const waiters = state.routeWaiters.splice(0);
  for (const w of waiters) w();
}

/** A modal that closes on any route change (back/forward, opening a book…). */
function transientModal(content, opts = {}) {
  const handle = openModal(content, {
    ...opts,
    onClose: (reason) => {
      state.transient.delete(handle);
      opts.onClose?.(reason);
    },
  });
  state.transient.add(handle);
  return handle;
}

function closeTransient() {
  for (const h of [...state.transient]) h.close("route");
  state.transient.clear();
}

// ---------------------------------------------------------------------------------------------
// Views + transitions

const homeEl = () => $("#view-home");
const bookEl = () => $("#view-book");

/** Make `view` the visible one (no animation). */
function applyView(view) {
  const home = homeEl();
  const book = bookEl();
  home.classList.remove("bt-leave");
  book.classList.remove("bt-leave");
  home.hidden = view !== "home";
  book.hidden = view !== "book";
  const footer = $("#site-footer");
  if (footer) footer.hidden = view !== "book";
  if (view === "home") state.ring?.resume?.();
  else state.ring?.pause?.();
}

function playEnter(node) {
  if (reduced()) return;
  node.classList.remove("bt-enter");
  void node.offsetWidth; // restart the animation
  node.classList.add("bt-enter");
  setTimeout(() => node.classList.remove("bt-enter"), 900);
}

async function playLeave(node, ms) {
  if (reduced() || node.hidden) return;
  node.classList.add("bt-leave");
  await wait(ms);
}

function disposeBookView() {
  stopSession();
  try { state.bookView?.dispose?.(); } catch (err) { console.error("[app] book dispose failed", err); }
  state.bookView = null;
  state.book = null;
}

async function showHome({ animate = true } = {}) {
  document.title = t("meta.title");
  state.blocked = null;
  const seq = ++state.seq; // also cancels a book that is still being opened
  if (state.view === "home") {
    applyView("home");
    flushPendingFocus();
    return;
  }
  const from = state.view;
  state.view = "home";
  stopSession();
  if (from === "book" && animate && state.booted) {
    await playLeave(bookEl(), 220);
    if (seq !== state.seq) return;
  }
  disposeBookView();
  bookEl().replaceChildren();
  applyView("home");
  window.scrollTo(0, 0);
  if (from === "book" && animate) playEnter(homeEl());
  flushPendingFocus();
}

// ---------------------------------------------------------------------------------------------
// Book page

function coverFor(cover, title) {
  if (cover && typeof cover === "object") return cover;
  return covers?.coverFromString ? covers.coverFromString(title || "") : { bg: "#1b2a4a", bg2: "#0e1630", fg: "#f6e7b0", accent: "#5fe1ff", motif: "book" };
}

function liveBookFromMeta(meta, lang) {
  return {
    id: meta.id,
    lang,
    source: "live",
    title: meta.title,
    originalTitle: meta.originalTitle || "",
    author: meta.author || "",
    year: Number.isFinite(meta.year) ? meta.year : null,
    genre: meta.genre || "",
    tagline: meta.tagline || "",
    cover: coverFor(meta.cover, meta.title),
    loading: { overview: true, characters: true, film: true },
    errors: {},
  };
}

/** "<title> — <author> | BookTrip" */
const bookTitle = (b) => `${[b.title, b.author].filter(Boolean).join(" — ")} | BookTrip`;

/** Does opening `id` need a /api/access check (paywall on, not yet allowed in this visit)? */
const needsGate = (id, health) => Boolean(health.billing?.enabled) && !state.allowed.has(id);

/** Apply a /api/access answer; false = the paywall stopped this book. */
function applyAccess(id, acc) {
  if (!acc.allowed) return false;
  if (!acc.unknown) state.allowed.add(id);
  if (acc.freeLeft != null) state.freeLeft = acc.freeLeft;
  state.subscribed = acc.subscribed;
  return true;
}

/** The paywall stopped `id`: leave its URL (back, or home on a direct link), then show the paywall. */
async function blockBook(id) {
  state.blocked = id;
  if (state.view && state.histIdx > 0) {
    const settled = nextRoute(900);
    history.back();
    await settled;
  } else {
    navigate("/", { replace: true });
  }
  state.blocked = id;
  account.openPaywall({ id, reason: "limit" });
}

/** "Free books left: N" chip on the book page (paywall on, visitor not subscribed). */
function freeBadge(health) {
  if (!health.billing?.enabled || state.subscribed || state.freeLeft == null) return null;
  return { text: tn("pay.freeLeft", state.freeLeft), onClick: () => navigate("#/premium") };
}

/**
 * Show /book/<id>: demo books load instantly; live books render their header at once and the
 * parts stream in. `instant` swaps without animation and keeps the scroll (language change).
 */
async function openBook(id, { force = false, instant = false } = {}) {
  const lang = getLang();
  if (!force && state.view === "book" && state.book?.id === id && state.book?.lang === lang) return;
  const seq = ++state.seq;
  const keepY = instant ? window.scrollY : 0;
  stopSession();
  if (!state.view) showBookPlaceholder();

  const [catalog, health] = await Promise.all([api.loadCatalog(), api.getHealth()]);
  if (seq !== state.seq) return;

  let book = null;
  let stored = null;
  let gate = null;
  if (catalog.some((e) => e.id === id) || api.DEMO_IDS.includes(id)) {
    if (needsGate(id, health)) gate = api.access(id); // in parallel with the book file
    try { book = await api.loadDemoBook(id, lang); } catch { book = null; }
    if (seq !== state.seq) return;
  }
  if (!book) {
    gate = null;
    stored = api.getMeta(id);
    if (health.live && stored) {
      book = liveBookFromMeta(api.metaForLang(stored, lang), lang);
    } else if (health.live) {
      // A shared link to a live book we have never seen: identify it again from its id.
      navigate(`#/q/${enc(id.replace(/-/g, " "))}`, { replace: true });
      return;
    } else {
      toast(t("errors.bookMissing"), { error: true });
      navigate("/", { replace: true });
      openDemoNotice(id.replace(/-/g, " "));
      return;
    }
  }
  if (!gate && needsGate(id, health)) gate = api.access(id);
  if (gate) {
    const acc = await gate;
    if (seq !== state.seq) return;
    if (!applyAccess(id, acc)) { blockBook(id); return; }
  }

  // view switch (render while visible so WebGL canvases get a real size)
  const animate = state.booted && !instant && !reduced();
  if (state.view === "home") {
    homeEl().classList.add("bt-seen");
    if (animate) await playLeave(homeEl(), 300);
  } else if (state.view === "book" && animate && state.bookView) {
    await playLeave(bookEl(), 200);
  }
  if (seq !== state.seq) return;

  const BV = await loadBookView();
  if (seq !== state.seq) return;
  disposeBookView();
  state.view = "book";
  const root = bookEl();
  root.replaceChildren();
  applyView("book");
  window.scrollTo(0, 0);

  const opts = {
    lang,
    health,
    onSearch: (query) => { if (String(query || "").trim()) navigate(`#/q/${enc(String(query).trim())}`); },
    onBack: () => goBack("/"),
    onRetry: (part) => state.session?.retry(part),
    onPaywall: () => account.openPaywall({ id, reason: "limit" }),
    badge: freeBadge(health),
    shareUrl: `${location.origin}${bookPath(id)}`,
  };
  state.book = book;
  try {
    state.bookView = BV && typeof BV.renderBook === "function" ? BV.renderBook(root, book, opts) : fallbackBook(root, book, opts);
  } catch (err) {
    console.error("[app] renderBook failed, using the fallback view", err);
    root.replaceChildren();
    state.bookView = fallbackBook(root, book, opts);
  }
  document.title = bookTitle(book);
  if (keepY) window.scrollTo(0, keepY);
  if (animate) playEnter(root);
  if (!instant && state.booted) root.focus({ preventScroll: true });
  if (!instant) api.sendEvent("book_open", id);

  if (book.source === "live") {
    api.touchMeta(id);
    startLive(book, stored);
  }
}

/** First paint on a direct book link: hide the hero and show quiet skeletons until data arrives. */
function showBookPlaceholder() {
  const root = bookEl();
  homeEl().hidden = true;
  root.hidden = false;
  root.replaceChildren(el("div", { class: "bt-wait", "aria-busy": "true" },
    el("div", { class: "skeleton bt-wait-cover" }),
    el("div", { class: "bt-wait-lines" },
      el("div", { class: "skeleton", style: "width:62%;height:34px" }),
      el("div", { class: "skeleton", style: "width:38%;height:18px" }),
      el("div", { class: "skeleton", style: "width:90%;height:14px;margin-top:18px" }),
      el("div", { class: "skeleton", style: "width:84%;height:14px" }),
      el("div", { class: "skeleton", style: "width:70%;height:14px" })),
    el("span", { class: "sr-only", text: t("book.loading") })));
}

function stopSession() {
  if (state.session) {
    state.session.ctrl.abort();
    state.session = null;
  }
}

const PART_FIELDS = {
  overview: (d) => ({ summary: d.summary, themes: d.themes || [], terms: d.terms || [], similar: d.similar || [] }),
  characters: (d) => ({ characters: d.characters }),
  film: (d) => ({ film: d }),
};

/** Load the live parts of the current book: overview ‖ characters → film, updating the view. */
function startLive(book, stored) {
  const ctrl = new AbortController();
  const s = { ctrl, book };
  state.session = s;
  const alive = () => state.session === s && !ctrl.signal.aborted;

  const commit = (patch) => {
    if (!alive()) return;
    s.book = { ...s.book, ...patch };
    state.book = s.book;
    try { state.bookView?.update?.(s.book); } catch (err) { console.error("[app] book update failed", err); }
  };
  const flags = (part, loading, error) => {
    const errors = { ...(s.book.errors || {}) };
    if (error) errors[part] = error; else delete errors[part];
    return { loading: { ...(s.book.loading || {}), [part]: loading }, errors };
  };

  s.load = async (part) => {
    if (s.book.loading?.[part] !== true || s.book.errors?.[part]) commit(flags(part, true, null));
    try {
      const data = await api.loadLivePart(s.book, part, s.book.lang, { signal: ctrl.signal });
      if (!alive()) return false;
      commit({ ...PART_FIELDS[part](data), ...flags(part, false, null) });
      return true;
    } catch (err) {
      const e = api.toApiError(err);
      if (!alive() || e.code === "aborted") return false;
      if (e.code === "paywall") {
        commit(flags(part, false, { code: "paywall", message: t("errors.paywall") }));
        if (!s.paywalled) {
          s.paywalled = true;
          account.openPaywall({ id: book.id, reason: "limit" });
        }
        return false;
      }
      if (e.code === "not_configured") api.markNotConfigured();
      commit(flags(part, false, { code: e.code, message: errorText(e) }));
      toast(`${t("toast.partFailed", { part: t(`part.${part}`) })}. ${errorText(e)}`, { error: true });
      return false;
    }
  };
  s.charactersThenFilm = async () => {
    const ok = Array.isArray(s.book.characters) && s.book.characters.length ? true : await s.load("characters");
    if (ok) await s.load("film");
    else if (alive()) commit(flags("film", false, { code: "needs_characters", message: t("errors.needs_characters") }));
  };
  s.retry = (part) => {
    if (part === "overview") s.load("overview");
    else if (part === "characters" || (part === "film" && !s.book.characters)) s.charactersThenFilm();
    else if (part === "film") s.load("film");
  };

  s.load("overview");
  s.charactersThenFilm();

  // The book was resolved in another language: fetch localised title/author/tagline quietly.
  const meta = stored && api.metaForLang(stored, book.lang);
  if (meta && !meta.localized) {
    const q = `${stored.originalTitle || meta.title} ${meta.author}`.trim();
    api.resolveLive(q, book.lang, { signal: ctrl.signal }).then((res) => {
      if (!alive() || !res.found) return;
      const saved = api.saveMeta({ ...res, id: book.id, cover: stored.cover || res.cover }, book.lang);
      const m = api.metaForLang(saved, book.lang);
      commit({ title: m.title, author: m.author, genre: m.genre, tagline: m.tagline });
      document.title = bookTitle(m);
    }).catch(() => {});
  }
}

/** Minimal book page used only when js/book-view.js is not available. */
function fallbackBook(root, book, { onBack, onRetry }) {
  const render = (b) => {
    const part = (name, body) => {
      if (b.errors?.[name]) {
        return el("div", { class: "bt-fb-error" },
          el("p", { text: b.errors[name].message || errorText(b.errors[name]) }),
          el("button", { type: "button", class: "btn-ghost", onclick: () => onRetry?.(name), text: t("errors.retry") }));
      }
      if (body) return body;
      return el("div", { class: "bt-fb-skel" }, [90, 96, 80, 88].map((w) => el("div", { class: "skeleton", style: `width:${w}%;height:14px` })));
    };
    const cover = el("div", { class: "bt-fb-cover" });
    if (covers?.coverSVG) cover.innerHTML = covers.coverSVG(coverFor(b.cover, b.title), { title: b.title, author: b.author, w: 260, h: 390, decorative: true });
    root.replaceChildren(el("article", { class: "bt-fb" },
      el("button", { type: "button", class: "btn-ghost bt-fb-back", onclick: () => onBack?.() }, el("span", { html: ICON.back }), el("span", { text: t("book.back") })),
      el("header", { class: "bt-fb-head" }, cover,
        el("div", {},
          el("p", { class: "bt-kicker", text: [b.genre, formatYear(b.year)].filter(Boolean).join(" · ") }),
          el("h1", { text: b.title }),
          el("p", { class: "bt-fb-author", text: b.author }),
          b.tagline ? el("p", { class: "bt-fb-tagline", text: b.tagline }) : null)),
      el("section", { class: "glass bt-fb-sec" }, el("h2", { text: t("book.summary") }),
        part("overview", Array.isArray(b.summary) ? el("div", {}, b.summary.map((p) => el("p", { text: p }))) : null)),
      el("section", { class: "glass bt-fb-sec" }, el("h2", { text: t("book.characters") }),
        part("characters", Array.isArray(b.characters) ? el("ul", { class: "bt-fb-chips" }, b.characters.map((c) => el("li", { class: "chip", text: c.name }))) : null)),
      el("section", { class: "glass bt-fb-sec" }, el("h2", { text: t("book.film") }),
        part("film", b.film ? el("p", { text: b.film.title || "" }) : null))));
  };
  render(book);
  return { update: render, dispose: () => root.replaceChildren() };
}

// ---------------------------------------------------------------------------------------------
// Search flow

function abortSearch() {
  const s = state.search;
  if (!s) return;
  state.search = null;
  s.ctrl.abort();
  closeLoading();
}

/** Leave the "#/q/…" history entry (back to where the visitor came from); resolves once the URL settled. */
function leaveSearchRoute() {
  if (parseRoute()?.name !== "search") return Promise.resolve();
  if (state.histIdx > 0) {
    const settled = nextRoute();
    history.back();
    return settled;
  }
  navigate("/", { replace: true });
  return Promise.resolve();
}

const quoted = (q) => (getLang() === "en" ? `“${q}”` : `«${q}»`);

async function runSearch(rawQuery) {
  const query = String(rawQuery || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (state.search && state.search.query === rawQuery) return;
  abortSearch();
  if (!state.view) await showHome({ animate: false });
  if (query.length < 2) {
    toast(t("search.tooShort"));
    leaveSearchRoute();
    return;
  }
  api.sendEvent("search");
  const lang = getLang();
  const search = { ctrl: new AbortController(), query: rawQuery };
  state.search = search;
  const current = () => state.search === search;

  let [matches, health] = await Promise.all([api.matchCatalog(query, { lang, limit: 8 }), api.getHealth()]);
  if (!health.live && health.failed) health = await api.getHealth({ refresh: true }); // boot-time check failed
  if (!current()) return;
  const best = matches[0];
  if (best && best.score >= (health.live ? 0.9 : 0.6)) {
    state.search = null;
    navigate(bookPath(best.id), { replace: true });
    return;
  }
  if (!health.live) {
    state.search = null;
    await leaveSearchRoute();
    openDemoNotice(query, matches);
    return;
  }

  const overlay = showLoading(query, () => search.ctrl.abort());
  try {
    const res = await api.resolveLive(query, lang, { signal: search.ctrl.signal });
    if (!current()) return;
    if (res.found) {
      const demoId = await api.demoIdFor(res);
      if (!current()) return;
      if (!demoId) api.saveMeta(res, lang);
      await overlay.found(res);
      if (!current()) return;
      state.search = null;
      closeLoading(); // fades out while the book page rises
      navigate(bookPath(demoId || res.id), { replace: true });
    } else {
      state.search = null;
      closeLoading();
      await leaveSearchRoute();
      showNotFound(query, res.suggestions || [], matches);
    }
  } catch (err) {
    if (!current()) return;
    state.search = null;
    closeLoading();
    const e = api.toApiError(err);
    if (e.code === "aborted") toast(t("loading.cancelled"));
    else if (e.code !== "not_configured") toast(errorText(e), { error: true, duration: 5200 });
    await leaveSearchRoute();
    if (e.code === "not_configured") {
      api.markNotConfigured();
      syncVariant();
      openDemoNotice(query, matches);
    }
  }
}

function showNotFound(query, suggestions, matches) {
  toast(t("search.notFound", { q: query }), { error: true, duration: 5200 });
  const items = [
    ...suggestions.slice(0, 5).map((s) => ({ kind: "query", title: s.title, author: s.author || "", query: [s.title, s.author].filter(Boolean).join(" ") })),
    ...matches.slice(0, 3).map((m) => ({ kind: "book", ...m })),
  ];
  if (!items.length) return;
  if (state.view === "home") {
    searchBox?.showList(items, { head: t("search.didYouMean"), value: query });
    return;
  }
  const id = "bt-dym-title";
  let handle = null;
  const list = el("ul", { class: "bt-rows" }, items.map((it) => el("li", {},
    el("button", {
      type: "button",
      class: "bt-row",
      onclick: () => {
        handle?.close();
        navigate(it.kind === "book" ? bookPath(it.id) : `#/q/${enc(it.query)}`);
      },
    }, thumb(it.cover || coverFor(null, it.title), it.title), el("span", { class: "bt-row-text" }, el("b", { text: it.title }), el("small", { text: it.author }))))));
  handle = transientModal(el("div", {},
    el("h2", { class: "bt-h", id, text: t("search.didYouMean") }),
    el("p", { class: "bt-lead", text: t("search.dymText", { q: query }) }),
    list), { labelledBy: id, className: "bt-narrow" });
}

// ---------------------------------------------------------------------------------------------
// Loading overlay ("opening the book")

function showLoading(query, onCancel) {
  closeLoading();
  const steps = t("loading.steps");
  const stepText = el("span", { text: steps[0] });
  const stepLine = el("p", { class: "bt-ld-step", id: "bt-ld-step", "aria-live": "polite" }, stepText);
  const dots = el("ol", { class: "bt-ld-dots", "aria-hidden": "true" }, steps.map((_, i) => el("li", { class: i === 0 ? "is-active" : "" })));
  const slow = el("p", { class: "bt-ld-slow", hidden: true, text: t("loading.slow") });
  const cancel = el("button", { type: "button", class: "btn-ghost bt-ld-cancel", text: t("loading.cancel") });
  const leaves = [0, 1, 2, 3].map((i) => el("i", { class: `bt-ld-leaf l${i}` }));
  const sparks = Array.from({ length: 12 }, (_, i) => el("i", { style: `--x:${((i * 37) % 100) - 50}px;--d:${(i * 0.23) % 2.6}s;--s:${0.6 + ((i * 7) % 5) / 10}` }));
  const book = el("div", { class: "bt-ld-book", "aria-hidden": "true" },
    el("div", { class: "bt-ld-glow" }),
    el("div", { class: "bt-ld-3d" },
      el("i", { class: "bt-ld-cover l" }), el("i", { class: "bt-ld-cover r" }),
      el("i", { class: "bt-ld-block l" }), el("i", { class: "bt-ld-block r" }),
      leaves),
    el("div", { class: "bt-ld-sparks" }, sparks));
  const node = el("div", { class: "bt-loading", role: "dialog", "aria-modal": "true", "aria-labelledby": "bt-ld-title", "aria-describedby": "bt-ld-step" },
    el("div", { class: "bt-ld-inner" },
      book,
      el("p", { class: "bt-ld-kicker", text: t("loading.kicker") }),
      el("h2", { class: "bt-ld-title", id: "bt-ld-title", "aria-label": t("loading.label", { q: query }) }, quoted(query)),
      stepLine,
      dots,
      slow,
      cancel));
  document.body.append(node);

  let step = 0;
  const setStep = (i, text = steps[i]) => {
    step = i;
    const span = el("span", { text });
    stepLine.replaceChildren(span);
    [...dots.children].forEach((d, k) => { d.className = k < i ? "is-done" : k === i ? "is-active" : ""; });
  };
  const timer = setInterval(() => { if (step < steps.length - 1) setStep(step + 1); }, 3400);
  const slowTimer = setTimeout(() => { slow.hidden = false; }, 14000);

  const handle = {
    node,
    backdrop: node,
    focusRoot: node,
    escape: () => cancel.click(),
    async found(meta) {
      clearInterval(timer);
      clearTimeout(slowTimer);
      const c = meta && meta.cover;
      if (c) {
        book.style.setProperty("--bk", safeColor(c.bg, "#0f4c6e"));
        book.style.setProperty("--bk2", safeColor(c.bg2, "#071a2e"));
        book.style.setProperty("--bk-accent", safeColor(c.accent, "#5fe1ff"));
      }
      book.classList.add("is-found");
      setStep(steps.length - 1, t("loading.found"));
      [...dots.children].forEach((d) => { d.className = "is-done"; });
      await wait(reduced() ? 0 : 650);
    },
    close() {
      clearInterval(timer);
      clearTimeout(slowTimer);
      if (state.loading === handle) state.loading = null;
      syncBlockers();
      node.classList.add("is-closing");
      setTimeout(() => node.remove(), reduced() ? 0 : 360);
    },
  };
  cancel.addEventListener("click", () => { onCancel?.(); });
  state.loading = handle;
  syncBlockers();
  cancel.focus({ preventScroll: true });
  return handle;
}

function closeLoading() {
  state.loading?.close();
}

// ---------------------------------------------------------------------------------------------
// Covers / thumbnails

function thumb(cover, title, cls = "sg-cover") {
  const span = el("span", { class: cls, "aria-hidden": "true" });
  const c = coverFor(cover, title);
  if (covers?.miniCoverSVG) span.innerHTML = covers.miniCoverSVG(c, { title, w: 30, h: 45 });
  else span.style.background = `linear-gradient(160deg, ${safeColor(c.bg)}, ${safeColor(c.bg2)})`;
  return span;
}

function bigCover(cover, title, author, lazy = null) {
  const box = el("span", { class: "bt-card-cover", "aria-hidden": "true" });
  const c = coverFor(cover, title);
  box.style.background = `linear-gradient(160deg, ${safeColor(c.bg)}, ${safeColor(c.bg2)})`;
  const paint = () => {
    if (!covers?.coverSVG) return;
    box.innerHTML = covers.coverSVG(c, { title, author, w: 260, h: 390, decorative: true });
    box.style.background = "";
  };
  if (lazy) lazy.add(box, paint);
  else paint();
  return box;
}

/** Paint covers only when they come near the screen (big libraries). → { add(node, paint), dispose() } */
function lazyPainter() {
  const jobs = new WeakMap();
  if (typeof IntersectionObserver !== "function") return { add: (_n, paint) => paint(), dispose() {} };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      try { jobs.get(e.target)?.(); } catch (err) { console.warn("[app] cover failed", err); }
      jobs.delete(e.target);
    }
  }, { rootMargin: "300px 0px" });
  return {
    add(node, paint) { jobs.set(node, paint); io.observe(node); },
    dispose() { io.disconnect(); },
  };
}

/** Grid of book cards; onPick(item) on click. Items: { id, title, author, year, cover }. */
function bookGrid(items, onPick, { compact = false, lazy = null } = {}) {
  return el("ul", { class: `bt-grid${compact ? " is-compact" : ""}` }, items.map((it, i) => el("li", { style: `--i:${i}` },
    el("button", { type: "button", class: "bt-card", onclick: () => onPick(it) },
      bigCover(it.cover, it.title, it.author, lazy),
      el("span", { class: "bt-card-title", text: it.title }),
      el("span", { class: "bt-card-meta" },
        it.author || "",
        !compact && Number.isFinite(it.year) ? el("span", { class: "bt-card-year", text: `${it.author ? " · " : ""}${formatYear(it.year)}` }) : null)))));
}

// ---------------------------------------------------------------------------------------------
// Route modals: how / library / premium

function openRouteModal(name) {
  if (state.routeModal?.name === name) return;
  closeRouteModal();
  const build = { how: buildHow, library: buildLibrary, premium: buildPremium }[name];
  const { node, labelId, className, dispose } = build();
  const handle = openModal(node, {
    labelledBy: labelId,
    className,
    onClose: (reason) => {
      try { dispose?.(); } catch { /* ignore */ }
      if (state.routeModal?.handle === handle) state.routeModal = null;
      if (reason === "user" && parseRoute()?.name === "modal") goBack(baseHref());
    },
  });
  state.routeModal = { name, handle };
}

function closeRouteModal() {
  const m = state.routeModal;
  state.routeModal = null;
  m?.handle.close("route");
}

/** Close the route modal like the user would (history back), then run `next` once the URL settled. */
function leaveModalThen(next) {
  const m = state.routeModal;
  if (!m) { next(); return; }
  const settled = parseRoute()?.name === "modal" ? nextRoute(500) : Promise.resolve();
  m.handle.close("user");
  settled.then(() => setTimeout(next, 0));
}

function header(kicker, title, lead, labelId) {
  return [
    el("p", { class: "bt-kicker", text: kicker }),
    el("h2", { class: "bt-h", id: labelId, text: title }),
    lead ? el("p", { class: "bt-lead", text: lead }) : null,
  ];
}

function buildHow() {
  const labelId = "bt-how-title";
  const steps = [1, 2, 3, 4].map((n) => el("li", { class: "bt-step", style: `--i:${n}` },
    el("span", { class: "bt-ico", html: ICON.how[n - 1] }),
    el("span", { class: "bt-step-n", "aria-hidden": "true", text: String(n).padStart(2, "0") }),
    el("h3", {}, el("span", { class: "sr-only", text: `${t("how.step", { n })}. ` }), t(`how.s${n}.title`)),
    el("p", { text: t(`how.s${n}.text`) })));
  const node = el("div", { class: "bt-how" },
    header(t("how.kicker"), t("how.title"), t("how.lead"), labelId),
    el("ol", { class: "bt-steps" }, steps),
    el("p", { class: "bt-note" }, el("span", { html: ICON.sparkle }), el("span", { text: t("how.note") })),
    el("div", { class: "bt-actions" },
      el("button", { type: "button", class: "btn-glow", onclick: () => leaveModalThen(focusSearch) }, el("span", { text: t("how.cta") })),
      el("a", { class: "btn-ghost", href: "#/library", onclick: (e) => { e.preventDefault(); navigate("#/library", { replace: true }); } },
        el("span", { html: ICON.library }), el("span", { text: t("nav.library") }))));
  return { node, labelId, className: "bt-mid" };
}

function buildLibrary() {
  const labelId = "bt-lib-title";
  const [kicker, ...rest] = header(t("library.loading"), t("library.title"), t("library.lead"), labelId);
  const count = kicker;
  const grid = el("div", { class: "bt-lib-grid" }, bookGrid([], () => {}));
  grid.firstChild.append(...Array.from({ length: 6 }, () => el("li", {}, el("div", { class: "skeleton bt-card-skel" }))));
  const recentBox = el("div", { class: "bt-lib-recent" });
  const body = el("div", { class: "bt-lib-body" }, grid, recentBox);
  const inputId = "bt-lib-q";
  const input = el("input", {
    id: inputId, type: "search", class: "bt-input bt-lib-input", placeholder: t("lib.filterPh"),
    autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
  });
  const chips = el("div", { class: "bt-chips", role: "group", "aria-label": t("lib.cats") });
  const tools = el("div", { class: "bt-lib-tools", hidden: true },
    el("div", { class: "bt-lib-search" },
      el("label", { class: "sr-only", for: inputId, text: t("lib.filter") }),
      el("span", { class: "bt-lib-ico", html: ICON.search }),
      input),
    chips);
  const note = el("p", { class: "bt-note" });
  const node = el("div", { class: "bt-lib" }, count, rest, tools, body, note);
  const lazy = lazyPainter();

  const open = (item) => navigate(bookPath(item.id), { replace: true });
  Promise.all([api.loadCatalog(), api.getHealth()]).then(([catalog, health]) => {
    if (!node.isConnected && state.routeModal?.name !== "library") return;
    const lang = getLang();
    const entries = catalog.map((e) => ({ ...api.localizeEntry(e, lang), cats: api.categoriesOf(e), entry: e }));
    const byId = new Map(entries.map((e) => [e.id, e]));
    const cats = api.CATEGORIES.filter((c) => entries.some((e) => e.cats.includes(c)));
    let cat = "all";
    const render = () => {
      let list = cat === "all" ? entries : entries.filter((e) => e.cats.includes(cat));
      const q = input.value.trim();
      if (q) list = api.rankCatalog(list.map((e) => e.entry), q, { lang, limit: 500, min: 0.45 }).map((r) => byId.get(r.id)).filter(Boolean);
      count.textContent = tn("library.count", list.length);
      grid.replaceChildren(list.length
        ? bookGrid(list, open, { lazy })
        : el("p", { class: "bt-empty" }, el("span", { html: ICON.library }), el("span", { text: entries.length ? t("lib.none") : t("library.empty") })));
    };
    if (entries.length > 6) {
      tools.hidden = false;
      if (cats.length > 1) {
        const buttons = ["all", ...cats].map((c) => el("button", {
          type: "button", class: "chip bt-chip", "aria-pressed": String(c === cat), dataset: { cat: c }, text: t(`cat.${c}`),
          onclick: () => {
            cat = c;
            for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.cat === cat));
            render();
          },
        }));
        chips.replaceChildren(...buttons);
      } else chips.hidden = true;
      let timer = 0;
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 120); });
      input.addEventListener("keydown", (e) => { if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; render(); } }, true);
    }
    render();
    // Live books this visitor opened before
    const ids = new Set(catalog.map((e) => e.id));
    const recent = health.live ? api.listMeta().filter((m) => !ids.has(m.id)).slice(0, 12).map((m) => {
      const loc = api.metaForLang(m, lang);
      return { id: m.id, title: loc.title, author: loc.author, year: loc.year, cover: coverFor(m.cover, loc.title) };
    }) : [];
    if (recent.length) recentBox.replaceChildren(el("h3", { class: "bt-sub", text: t("library.recent") }), bookGrid(recent, open, { compact: true, lazy }));
    note.replaceChildren(el("span", { html: ICON.sparkle }), el("span", { text: health.live ? t("library.liveNote") : t("library.demoNote") }));
  });
  return { node, labelId, className: "bt-wide", dispose: () => lazy.dispose() };
}

function buildPremium() {
  const labelId = "bt-prem-title";
  const pill = () => el("span", { class: "bt-pill", text: "…" });
  const pills = { portraits: pill(), video: pill() };
  const texts = {};
  const feature = (key, icon, extra, hero = false) => {
    const h3 = el("h3", { text: t(`premium.${key}.title`) });
    const p = el("p", { text: t(`premium.${key}.text`) });
    texts[key] = { h3, p };
    return el("li", { class: `bt-feat${hero ? " is-hero" : ""}` },
      el("div", { class: "bt-feat-top" }, el("span", { class: "bt-ico", html: icon }), extra), h3, p);
  };
  const freePill = el("span", { class: "bt-pill is-on", text: t("premium.on") });
  const lead = el("p", { class: "bt-lead", text: t("premium.lead") });
  const pricingList = el("ul", {}, t("premium.pricing.items").map((line) => el("li", {}, el("span", { html: ICON.check }), el("span", { text: line }))));
  const plans = el("div", { class: "bt-prem-plans", "aria-busy": "true" }, el("div", { class: "skeleton", style: "height:120px;border-radius:18px" }));
  const node = el("div", { class: "bt-prem" },
    el("div", { class: "bt-prem-hero" },
      el("p", { class: "badge bt-prem-badge" }, el("i", { html: ICON.crown }), el("b", { text: t("premium.kicker") })),
      el("h2", { class: "bt-h bt-prem-h", id: labelId, text: t("premium.title") }),
      lead),
    plans,
    el("ul", { class: "bt-feats" },
      feature("portraits", ICON.portrait, pills.portraits, true),
      feature("video", ICON.video, pills.video, true),
      feature("free", ICON.infinity, freePill)),
    el("section", { class: "bt-pricing", "aria-labelledby": "bt-price-h" },
      el("h3", { id: "bt-price-h", text: t("premium.pricing.title") }),
      pricingList),
    el("p", { class: "bt-note" }, el("span", { html: ICON.sparkle }), el("span", { text: t("premium.note") })),
    el("div", { class: "bt-actions" },
      el("a", { class: "btn-ghost", href: "#/library", onclick: (e) => { e.preventDefault(); navigate("#/library", { replace: true }); } },
        el("span", { html: ICON.library }), el("span", { text: t("premium.cta") }))));

  api.getHealth().then((h) => {
    const set = (n, on) => {
      n.textContent = on ? t("premium.on") : t("premium.off");
      n.title = t("premium.status");
      n.classList.toggle("is-on", on);
    };
    set(pills.portraits, h.portraits);
    set(pills.video, h.video);
    if (h.billing.enabled) {
      lead.textContent = t("premium.leadPaid");
      texts.free.h3.textContent = t("premium.free.titlePaid");
      texts.free.p.textContent = tn("premium.free.textPaid", h.freeBooks);
      const label = (period) => h.billing.prices.find((p) => p.period === period)?.label || "—";
      const lines = t("premium.pricing.paid", { free: h.freeBooks, month: label("month"), year: label("year") });
      pricingList.replaceChildren(...lines.map((line) => el("li", {}, el("span", { html: ICON.check }), el("span", { text: line }))));
    }
    plans.removeAttribute("aria-busy");
    plans.replaceChildren(account.plansBlock(h, { from: "premium" }));
  });
  return { node, labelId, className: "bt-mid" };
}

/** "AI is not connected yet" — offer the demo books (matches first) and the waitlist. */
async function openDemoNotice(query = "", matches = []) {
  const catalog = await api.loadCatalog();
  const lang = getLang();
  const first = new Set(matches.map((m) => m.id));
  const items = [
    ...matches.map((m) => api.localizeEntry(m.entry, lang)),
    ...catalog.filter((e) => !first.has(e.id)).map((e) => api.localizeEntry(e, lang)),
  ].slice(0, 6);
  const labelId = "bt-demo-title";
  let handle = null;
  const q = String(query || "").trim().slice(0, 200);
  const node = el("div", { class: "bt-demo" },
    el("p", { class: "chip bt-mode" }, el("i", { class: "bt-dot", "aria-hidden": "true" }), t("mode.demo")),
    el("h2", { class: "bt-h", id: labelId, text: t("search.demoTitle") }),
    el("p", { class: "bt-lead", text: q ? t("search.demoQuery", { q }) : t("search.demoText") }),
    items.length
      ? bookGrid(items, (it) => { handle?.close(); navigate(bookPath(it.id)); }, { compact: true })
      : el("p", { class: "bt-empty", text: t("library.empty") }),
    q ? waitlistForm(q) : null,
    el("div", { class: "bt-actions" },
      el("a", { class: "btn-ghost", href: "#/library", onclick: (e) => { e.preventDefault(); handle?.close(); navigate("#/library"); } },
        el("span", { html: ICON.library }), el("span", { text: t("search.allBooks") }))));
  handle = transientModal(node, { labelledBy: labelId, className: "bt-mid" });
  return handle;
}

let formN = 0;

/** "Leave your Telegram or e-mail — we'll tell you when this book is ready" → POST /api/waitlist. */
function waitlistForm(q) {
  const id = `bt-wl-${++formN}`;
  const input = el("input", {
    id, type: "text", name: "contact", class: "bt-input", autocomplete: "email", inputmode: "email", maxlength: "120",
    autocapitalize: "off", spellcheck: "false", placeholder: t("wl.ph"), "aria-describedby": `${id}-err`,
  });
  const err = el("p", { class: "bt-field-err", id: `${id}-err`, "aria-live": "polite" });
  const btn = el("button", { type: "submit", class: "btn-glow btn-sm" }, el("span", { text: t("wl.send") }));
  const form = el("form", { class: "bt-wl", novalidate: true },
    el("h3", { class: "bt-wl-h", text: t("wl.title") }),
    el("p", { class: "bt-wl-text", text: t("wl.text", { q }) }),
    el("label", { class: "sr-only", for: id, text: t("wl.label") }),
    el("div", { class: "bt-wl-row" }, input, btn),
    err);
  const setErr = (msg) => {
    err.textContent = msg;
    form.classList.toggle("is-invalid", Boolean(msg));
    if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
  };
  input.addEventListener("input", () => { if (form.classList.contains("is-invalid") && api.validContact(input.value)) setErr(""); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const contact = input.value.trim();
    if (!api.validContact(contact)) { setErr(t("wl.bad")); input.focus(); return; }
    setErr("");
    btn.disabled = true;
    form.setAttribute("aria-busy", "true");
    try {
      await api.joinWaitlist(q, contact, getLang());
      api.sendEvent("waitlist_join");
      const done = el("div", { class: "bt-wl is-done", role: "status", tabindex: "-1" },
        el("span", { class: "bt-wl-ok", html: ICON.check }), el("p", { text: t("wl.ok") }));
      form.replaceWith(done);
      done.focus({ preventScroll: true });
    } catch (error) {
      const e2 = api.toApiError(error);
      toast(e2.code === "rate_limited" || e2.code === "network" ? errorText(e2) : t("wl.error"), { error: true });
      btn.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
  return form;
}

// ---------------------------------------------------------------------------------------------
// Search box with suggestions (combobox pattern)

let searchBox = null;

function initSearchBox() {
  const form = $("#search-form");
  const input = $("#search-input");
  const list = $("#search-suggest");
  if (!form || !input || !list) return null;

  let options = [];   // [{ node, run() }]
  let active = -1;
  let seq = 0;        // bumping it cancels an in-flight update()
  let timer = 0;      // debounced update while typing

  const isOpen = () => !list.hidden;
  const close = () => {
    clearTimeout(timer);
    seq++;
    list.hidden = true;
    list.replaceChildren();
    options = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const setActive = (i) => {
    active = i;
    options.forEach((o, k) => o.node.setAttribute("aria-selected", String(k === i)));
    if (i >= 0 && options[i]) {
      input.setAttribute("aria-activedescendant", options[i].node.id);
      options[i].node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };

  const openBookItem = (id) => { close(); input.value = ""; input.blur(); navigate(bookPath(id)); };
  const searchQuery = (q) => { close(); input.blur(); navigate(`#/q/${enc(q)}`); };

  /** Render items: { kind: "book"|"query"|"ai"|"empty", … }. */
  function render(items, { head = "", qTokens = [] } = {}) {
    options = [];
    active = -1;
    const nodes = [];
    if (head) nodes.push(el("li", { class: "sg-head", role: "presentation", text: head }));
    for (const it of items) {
      if (it.kind === "empty") {
        nodes.push(el("li", { class: "sg-empty", role: "presentation" },
          el("span", { class: "sg-text" }, el("b", { class: "sg-title", text: it.title }), el("small", { class: "sg-author", text: it.hint }))));
        continue;
      }
      const id = `sg-opt-${options.length}`;
      let node;
      if (it.kind === "ai") {
        node = el("li", { id, role: "option", class: "sg-ai", "aria-selected": "false" },
          el("span", { class: "sg-cover sg-ai-ico", "aria-hidden": "true", html: ICON.sparkle }),
          el("span", { class: "sg-text" }, el("b", { class: "sg-title", text: t("search.askAi", { q: it.query }) }), el("small", { class: "sg-author", text: t("search.askAiHint") })),
          el("span", { class: "sg-tag is-ai", text: t("search.aiTag") }));
      } else {
        const title = el("b", { class: "sg-title" });
        title.append(highlight(it.title, qTokens));
        node = el("li", { id, role: "option", "aria-selected": "false" },
          thumb(it.cover, it.title),
          el("span", { class: "sg-text" }, title, el("small", { class: "sg-author", text: it.author || "" })),
          it.kind === "book" && Number.isFinite(it.year) ? el("span", { class: "sg-tag", text: formatYear(it.year) }) : null);
      }
      const run = it.kind === "book" ? () => openBookItem(it.id) : () => searchQuery(it.query);
      node.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
      node.addEventListener("click", run);
      node.addEventListener("mousemove", () => { if (active !== options.indexOf(entry)) setActive(options.indexOf(entry)); });
      const entry = { node, run };
      options.push(entry);
      nodes.push(node);
    }
    list.replaceChildren(...nodes);
    list.hidden = nodes.length === 0;
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.removeAttribute("aria-activedescendant");
  }

  async function update() {
    const my = ++seq;
    const raw = input.value;
    const q = raw.trim();
    const lang = getLang();
    if (!q) {
      const catalog = await api.loadCatalog();
      if (my !== seq || document.activeElement !== input) return;
      const items = catalog.slice(0, 6).map((e) => ({ kind: "book", ...api.localizeEntry(e, lang) }));
      render(items, { head: items.length ? t("search.popular") : "" });
      return;
    }
    const [matches, health] = await Promise.all([api.matchCatalog(q, { lang, limit: 6 }), api.getHealth()]);
    if (my !== seq || document.activeElement !== input) return;
    const items = matches.map((m) => ({ kind: "book", ...m }));
    const exact = matches[0] && matches[0].score >= 0.98;
    if (health.live && q.length >= 2 && !exact) items.push({ kind: "ai", query: q });
    if (!matches.length && !health.live) items.push({ kind: "empty", title: t("search.noMatches"), hint: t("search.noMatchesDemo") });
    if (!matches.length && health.live && q.length < 2) items.push({ kind: "empty", title: t("search.tooShort"), hint: "" });
    render(items, { qTokens: normalizeQuery(q).split(" ").filter(Boolean) });
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(update, 90);
  });
  input.addEventListener("focus", () => update());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) { update(); return; }
      if (!options.length) return;
      const n = options.length;
      setActive(e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === "Enter" && isOpen() && active >= 0 && options[active]) {
      e.preventDefault();
      options[active].run();
    } else if (e.key === "Escape") {
      if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (input.value) { e.preventDefault(); input.value = ""; }
    } else if (e.key === "Home" || e.key === "End") {
      if (isOpen() && active >= 0) setActive(-1);
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isOpen() && active >= 0 && options[active]) { options[active].run(); return; }
    const q = input.value.replace(/\s+/g, " ").trim();
    if (q.length < 2) {
      toast(t("search.tooShort"));
      input.focus();
      return;
    }
    searchQuery(q);
  });
  form.addEventListener("focusout", () => {
    setTimeout(() => { if (!form.contains(document.activeElement)) close(); }, 0);
  });
  document.addEventListener("pointerdown", (e) => { if (isOpen() && !form.contains(e.target)) close(); });

  return {
    input,
    form,
    close,
    refresh() { list.setAttribute("aria-label", t("search.listLabel")); if (isOpen()) update(); },
    /** Show a custom list (e.g. "Did you mean") with focus in the input. */
    showList(items, { head, value } = {}) {
      clearTimeout(timer);
      if (value != null) input.value = value;
      input.focus({ preventScroll: true });
      seq++; // cancel the focus-triggered update
      render(items, { head });
    },
  };
}

/** Wrap the parts of `text` that start with any query token in <mark> (safe DOM, no HTML). */
function highlight(text, qTokens) {
  const frag = document.createDocumentFragment();
  const s = String(text ?? "");
  if (!qTokens.length) { frag.append(s); return frag; }
  const re = /[\p{L}\p{N}]+/gu;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const word = m[0];
    let best = 0;
    for (const q of qTokens) {
      let acc = "";
      for (let i = 0; i < word.length; i++) {
        acc += normalizeQuery(word[i]);
        if (acc === q) { best = Math.max(best, i + 1); break; }
        if (!q.startsWith(acc)) break;
      }
    }
    if (best > 0) {
      frag.append(s.slice(last, m.index), el("mark", { text: word.slice(0, best) }));
      last = m.index + best;
    }
  }
  frag.append(s.slice(last));
  return frag;
}

function focusSearch() {
  if (state.view !== "home") {
    state.pendingFocus = true;
    navigate("#/");
    return;
  }
  state.pendingFocus = true;
  flushPendingFocus();
}

function flushPendingFocus() {
  if (!state.pendingFocus || state.view !== "home" || !searchBox) return;
  state.pendingFocus = false;
  const { input, form } = searchBox;
  setTimeout(() => {
    input.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
    form.classList.remove("bt-flash");
    void form.offsetWidth;
    form.classList.add("bt-flash");
    setTimeout(() => form.classList.remove("bt-flash"), 1200);
  }, 60);
}

/** Rotating examples in the search placeholder (home only, while the field is idle). */
function startPlaceholderRotation() {
  let i = 0;
  setInterval(() => {
    const input = searchBox?.input;
    if (!input || state.view !== "home" || document.hidden || input.value || document.activeElement === input) return;
    const examples = t("home.examples");
    if (!Array.isArray(examples) || !examples.length) return;
    i = (i + 1) % examples.length;
    input.classList.add("bt-ph-out");
    setTimeout(() => {
      input.setAttribute("placeholder", t("home.placeholderTpl", { example: examples[i] }));
      input.classList.remove("bt-ph-out");
    }, 220);
  }, 3600);
}

// ---------------------------------------------------------------------------------------------
// Footer

function buildFooter() {
  if ($("#site-footer")) return;
  const mark = $(".brand-mark")?.cloneNode(true);
  if (mark) {
    mark.querySelectorAll("[id]").forEach((n) => n.setAttribute("id", `ft-${n.id}`));
    mark.querySelectorAll("[fill^='url(#'],[stroke^='url(#']").forEach((n) => {
      for (const a of ["fill", "stroke"]) {
        const v = n.getAttribute(a);
        if (v && v.startsWith("url(#")) n.setAttribute(a, v.replace("url(#", "url(#ft-"));
      }
    });
  }
  const links = [["#/how", "nav.how"], ["#/library", "nav.library"], ["#/premium", "nav.premium"]];
  const legal = [["/terms", "legal.terms"], ["/privacy", "legal.privacy"], ["/refund", "legal.refund"]];
  const footer = el("footer", { class: "bt-footer", id: "site-footer", hidden: true },
    el("div", { class: "bt-footer-in" },
      el("div", { class: "bt-footer-brand" },
        el("a", { class: "brand", href: "/", "aria-label": "BookTrip" }, mark, el("span", { class: "brand-word", html: "<b>BOOK</b>TRIP" })),
        el("p", { class: "bt-footer-tag", "data-i18n": "brand.tagline", text: t("brand.tagline") })),
      el("nav", { class: "bt-footer-nav", "data-i18n-aria": "footer.label", "aria-label": t("footer.label") },
        links.map(([href, key]) => el("a", { href, "data-i18n": key, text: t(key) }))),
      el("p", { class: "bt-footer-note", "data-i18n": "footer.note", text: t("footer.note") }),
      el("nav", { class: "bt-footer-legal", id: "bt-footer-legal", "aria-label": "Legal" },
        legal.map(([href, key]) => el("a", { href, "data-i18n": key, text: t(key) }))),
      el("p", { class: "bt-footer-small" },
        el("span", { class: "bt-footer-copy", text: t("footer.rights", { year: new Date().getFullYear() }) }),
        el("span", { "aria-hidden": "true", text: " · " }),
        el("span", { "data-i18n": "footer.made", text: t("footer.made") }))));
  $("#main").after(footer);
  api.getHealth().then((h) => {
    if (!h.telegram || $("#bt-footer-tg")) return;
    $("#bt-footer-legal")?.append(el("a", { id: "bt-footer-tg", href: `https://t.me/${h.telegram}`, target: "_blank", rel: "noopener", "data-i18n": "footer.telegram", text: t("footer.telegram") }));
  });
}

// ---------------------------------------------------------------------------------------------
// Compact nav menu (≤ 860px): How it works / Library / Premium in a dropdown

function initNavMenu() {
  const nav = $("#nav");
  const btn = $("#nav-menu");
  const links = $("#nav-links");
  if (!nav || !btn || !links) return;
  const isOpen = () => nav.classList.contains("is-open");
  const set = (open) => {
    nav.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    set(!isOpen());
    if (isOpen() && e.detail === 0) links.querySelector("a")?.focus(); // opened from the keyboard
  });
  links.addEventListener("click", (e) => { if (e.target.closest("a, button")) set(false); });
  document.addEventListener("pointerdown", (e) => { if (isOpen() && !nav.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { e.stopPropagation(); set(false); btn.focus(); }
  }, true);
  nav.addEventListener("focusout", (e) => { if (isOpen() && e.relatedTarget && !nav.contains(e.relatedTarget)) set(false); });
  window.addEventListener("bt:route", () => set(false));
  try { matchMedia("(min-width: 861px)").addEventListener("change", () => set(false)); } catch { /* old Safari */ }
}

// ---------------------------------------------------------------------------------------------
// Language

function syncLangButtons() {
  const lang = getLang();
  for (const b of document.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

const RING_MAX = 18;
let ringIds = null; // random subset of the catalog shown on the ring (fixed for the visit)

async function ringItems() {
  const catalog = await api.loadCatalog();
  const lang = getLang();
  if (!ringIds) {
    const ids = catalog.map((e) => e.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ringIds = ids.slice(0, RING_MAX);
  }
  const byId = new Map(catalog.map((e) => [e.id, e]));
  return ringIds.filter((id) => byId.has(id)).map((id) => api.localizeEntry(byId.get(id), lang));
}

function onLangChange() {
  applyI18n();
  syncLangButtons();
  const copy = $(".bt-footer-copy");
  if (copy) copy.textContent = t("footer.rights", { year: new Date().getFullYear() });
  searchBox?.refresh();
  if (state.ring) ringItems().then((items) => state.ring?.setItems(items));
  account.refreshLabels();
  if (state.view === "book" && state.book) openBook(state.book.id, { force: true, instant: true });
  else document.title = t("meta.title");
}

/** Honest copy while only the curated library works ("great books"), the full promise once AI is live. */
async function syncVariant() {
  const h = await api.getHealth();
  if (!setVariant(h.live ? "" : "curated")) return;
  applyI18n();
  searchBox?.refresh();
  if (state.view !== "book") document.title = t("meta.title");
}

// ---------------------------------------------------------------------------------------------
// Boot

function isTypingTarget(node) {
  return node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
}

async function initHome() {
  loadStars().then((m) => { try { m?.startStars($("#starfield")); } catch (err) { console.error(err); } });
  const [ringMod, items] = await Promise.all([loadRing(), ringItems()]);
  const host = $("#ring");
  if (!ringMod || !host) return;
  try {
    state.ring = ringMod.createRing(host, items, {
      onOpen: (item) => item && ID_RE.test(item.id || "") && navigate(bookPath(item.id)),
      reducedMotion: reduced(),
    });
    if (state.view !== "home") state.ring.pause?.();
  } catch (err) {
    console.error("[app] ring failed", err);
  }
}

/** In-app links ("#/…", "/", "/#/…", "/book/<id>") switch views without a page load. */
function interceptLinks(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]");
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
  const href = a.getAttribute("href") || "";
  if (!/^(#\/|\/#\/|\/$|\/book\/[a-z0-9-]+\/?$)/i.test(href)) return;
  e.preventDefault();
  navigate(href);
}

const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** Vercel Web Analytics (served by Vercel only — skipped on local hosts where it would 404). */
function loadInsights() {
  if (isLocalHost() || location.protocol !== "https:" || document.querySelector('script[src="/_vercel/insights/script.js"]')) return;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "/_vercel/insights/script.js";
  document.head.append(s);
}

/** Offline support: service worker on https (or localhost), registered after load. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || isLocalHost())) return;
  const go = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("[app] service worker:", err && err.message));
  if (document.readyState === "complete") setTimeout(go, 0);
  else window.addEventListener("load", go, { once: true });
}

/** "Install app" item in the nav menu while the browser offers installation. */
function initInstall() {
  const links = $("#nav-links");
  if (!links) return;
  let deferred = null;
  const btn = el("button", { type: "button", class: "nav-links-btn nav-install", hidden: true, "data-i18n": "pwa.install", text: t("pwa.install") });
  links.append(btn);
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    const ev = deferred;
    deferred = null;
    btn.hidden = true;
    if (!ev) return;
    try {
      ev.prompt();
      const choice = await ev.userChoice;
      if (choice?.outcome === "accepted") api.sendEvent("install");
    } catch { /* ignore */ }
  });
  window.addEventListener("appinstalled", () => { btn.hidden = true; });
}

async function boot() {
  if (window.__btApp) return;
  window.__btApp = true;
  injectStyles();
  document.getElementById("ssr-book")?.remove(); // server-rendered SEO copy of /book/<id>

  // first paint: right view before anything async
  const loginParam = account.takeLoginParam(); // strips ?login=ok|expired before the router reads the URL
  const first = parseRoute();
  if (first?.name === "book" || first?.base?.name === "book") showBookPlaceholder();

  applyI18n();
  syncLangButtons();
  document.title = t("meta.title");
  buildFooter();
  initNavMenu();
  searchBox = initSearchBox();
  searchBox?.refresh();

  // history index for this entry (survives reloads)
  const st = history.state;
  if (st && Number.isInteger(st.btIdx)) state.histIdx = st.btIdx;
  else history.replaceState({ ...(st && typeof st === "object" ? st : {}), btIdx: 0 }, "");

  // events
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang));
  window.addEventListener("bt:lang", onLangChange);
  window.addEventListener("popstate", onHistoryChange);
  window.addEventListener("hashchange", onHistoryChange);
  document.addEventListener("click", (e) => {
    const cta = e.target.closest?.('[data-action="focus-search"]');
    if (cta) { e.preventDefault(); focusSearch(); }
  });
  document.addEventListener("click", interceptLinks);
  $(".skip-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    const target = state.view === "book" ? bookEl() : $("#main");
    target.setAttribute("tabindex", "-1");
    target.focus();
  });
  document.addEventListener("keydown", (e) => {
    const list = blockers();
    const top = list[list.length - 1];
    if (top) {
      if (e.key === "Escape") { e.preventDefault(); top.escape(); }
      else if (e.key === "Tab") trapTab(e, top.focusRoot);
      return;
    }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
      const own = state.view === "book" && [...bookEl().querySelectorAll('input[type="search"]')].find((n) => n.getClientRects().length);
      e.preventDefault();
      if (own) own.focus();
      else focusSearch();
    }
  });
  window.addEventListener("offline", () => toast(t("toast.offline"), { error: true }));
  window.addEventListener("online", () => toast(t("toast.online")));
  bookEl().setAttribute("tabindex", "-1");

  account.init({
    openModal: transientModal,
    toast,
    errorText,
    navigate,
    onAccountChange: ({ subscribed } = {}) => {
      state.allowed.clear();
      state.freeLeft = null;
      if (subscribed) {
        state.subscribed = true;
        const blocked = state.blocked;
        if (blocked && ID_RE.test(blocked)) navigate(bookPath(blocked));
        else if (state.view === "book" && state.book) openBook(state.book.id, { force: true, instant: true });
      }
    },
    icons: ICON,
  });
  initInstall();

  loadCovers().then((m) => { covers = m; });
  api.getHealth();
  syncVariant();
  await Promise.race([loadCovers(), wait(1500)]);

  if (first) route();
  else { state.lastHref = location.href; showHome({ animate: false }); } // e.g. "#main": not a route
  state.booted = true;
  account.afterBoot(loginParam);
  initHome();
  startPlaceholderRotation();
  loadInsights();
  registerServiceWorker();
}

// ---------------------------------------------------------------------------------------------
// Styles for everything this module renders (overlay, modals, footer, transitions).

const APP_CSS = String.raw`
.view:focus { outline: none; }
html.bt-lock { overflow: hidden; }

/* ---- view transitions ---- */
.view-home.bt-leave { animation: bt-home-out .3s var(--ease) forwards; pointer-events: none; }
@keyframes bt-home-out { to { opacity: 0; transform: scale(.965) translateY(-12px); } }
.view-home.bt-enter { animation: bt-home-in .75s var(--expo) both; }
@keyframes bt-home-in { from { opacity: 0; transform: scale(1.035); } }
.view-book.bt-leave { animation: bt-book-out .2s var(--ease) forwards; pointer-events: none; }
@keyframes bt-book-out { to { opacity: 0; transform: translateY(18px); } }
.view-book.bt-enter { animation: bt-book-in .85s var(--expo) both; }
@keyframes bt-book-in { from { opacity: 0; transform: translateY(54px) scale(.985); } }
.view-home.bt-seen .badge, .view-home.bt-seen .hero-title > span, .view-home.bt-seen .hero-sub,
.view-home.bt-seen .search, .view-home.bt-seen .hero-hint { animation: none !important; }

/* ---- search extras ---- */
.search.bt-flash::after {
  content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
  box-shadow: 0 0 0 2px rgba(95, 225, 255, .55), 0 0 46px -4px rgba(60, 190, 255, .5);
  animation: bt-flash 1.1s var(--ease) forwards;
}
@keyframes bt-flash { 0% { opacity: 0; } 25% { opacity: 1; } 100% { opacity: 0; } }
.search input.bt-ph-out::placeholder { opacity: 0; }
.search input::placeholder { transition: opacity .22s; }
.suggest .sg-head {
  min-height: 0; padding: 9px 10px 5px; cursor: default; background: none !important; box-shadow: none !important;
  font: 700 11px/1.2 var(--ui); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3);
}
.suggest .sg-empty { min-height: 64px; text-align: center; }
.suggest .sg-empty .sg-text { align-items: center; }
.suggest .sg-empty .sg-title { white-space: normal; color: var(--ink-2); }
.suggest .sg-empty .sg-author { white-space: normal; }
.suggest .sg-ai-ico {
  display: grid; place-items: center; color: #dff9ff;
  background: linear-gradient(to top, #2db7d6 0, #0b6f8a 18%, #073449 55%, #0a1426 100%);
  box-shadow: inset 0 0 0 1px rgba(150, 220, 250, .35), 0 6px 14px -4px rgba(0, 0, 0, .7) !important;
}
.suggest .sg-ai-ico svg { width: 18px; height: 18px; }
.suggest .sg-tag.is-ai { border-color: rgba(95, 225, 255, .35); color: #d9f8ff; }

/* ---- toast ---- */
.toast.is-error { border-color: rgba(255, 143, 177, .38); box-shadow: var(--shadow), inset 3px 0 0 rgba(255, 143, 177, .75); }

/* ---- modal shell ---- */
.modal:focus { outline: none; }
.modal { overflow-x: hidden; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .2) transparent; overscroll-behavior: contain; }
.modal.bt-mid { width: min(820px, 100%); }
.modal.bt-wide { width: min(1040px, 100%); }
.modal.bt-narrow { width: min(520px, 100%); }
.modal .modal-close svg { width: 18px; height: 18px; }
.bt-backdrop.is-closing { animation: bt-fade-out .2s var(--ease) forwards; }
.bt-backdrop.is-closing .modal { animation: bt-sink .2s var(--ease) forwards; }
@keyframes bt-fade-out { to { opacity: 0; } }
@keyframes bt-sink { to { opacity: 0; transform: translateY(10px) scale(.985); } }

.bt-kicker { font: 700 11.5px/1.2 var(--ui); letter-spacing: .14em; text-transform: uppercase; color: var(--cyan); margin-bottom: 10px; }
.modal h2.bt-h, .bt-h { font: 800 clamp(22px, 3.2vw, 30px)/1.16 var(--display); letter-spacing: -.012em; margin: 0 44px 10px 0; text-wrap: balance; }
.bt-lead { color: var(--ink-2); font-size: 15.5px; line-height: 1.6; max-width: 46em; text-wrap: pretty; }
.bt-sub { margin: 28px 0 0; font: 700 13px/1.2 var(--ui); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.bt-note { display: flex; gap: 10px; align-items: flex-start; margin-top: 18px; font-size: 14px; color: var(--ink-3); }
.bt-note > span:first-child { flex: none; color: var(--cyan); margin-top: 1px; }
.bt-note svg { width: 18px; height: 18px; }
.bt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 22px; }
.bt-actions .btn-glow { min-width: 160px; }
.bt-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 36px 16px; text-align: center; color: var(--ink-3); }
.bt-empty svg { width: 34px; height: 34px; color: var(--ink-3); }

.bt-ico {
  flex: none; width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; color: #c8f4ff;
  background: linear-gradient(to top, #46afc8 0px, #35abc7 2px, #0b859d 4px, #026c84 6px, #004e66 8px, #053f58 10px, #012c3d 12px, #031a2a 14px, #061125 16px, #090f25 19px, #090c1c 23px, #060d16 100%);
  box-shadow: inset 1px 0 0 rgba(150, 220, 250, .4), inset -1px 0 0 rgba(150, 220, 250, .5), 0 0 10px rgba(60, 190, 230, .18), 0 4px 12px -6px rgba(90, 220, 255, .6);
}
.bt-ico svg { width: 22px; height: 22px; filter: drop-shadow(0 0 4px rgba(95, 225, 255, .45)); }

/* how it works */
.bt-steps { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 24px 0 4px; }
.bt-step {
  position: relative; padding: 20px; border-radius: 18px; border: 1px solid var(--line);
  /* fully opaque colours: translucent cards inside the modal pick up compositing artefacts */
  background: linear-gradient(180deg, #1c2232, #141b2b);
  animation: rise .5s var(--expo) backwards; animation-delay: calc(var(--i, 0) * 60ms);
}
.bt-step .bt-ico { margin-bottom: 16px; }
.bt-step-n { position: absolute; top: 16px; right: 18px; font: 900 30px/1 var(--display); color: rgba(255, 255, 255, .06); letter-spacing: -.02em; }
.bt-step h3 { font: 700 16.5px/1.3 var(--ui); margin-bottom: 6px; }
.bt-step p { font-size: 14.2px; line-height: 1.55; color: var(--ink-2); }

/* library + book grids */
.bt-grid { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 24px 18px; margin-top: 24px; }
.bt-grid.is-compact { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 18px 14px; margin-top: 18px; }
.bt-grid > li { min-width: 0; animation: rise .5s var(--expo) backwards; animation-delay: calc(min(var(--i, 0), 14) * 30ms); }
.bt-card { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; border-radius: 12px; }
.bt-card-cover {
  display: block; position: relative; aspect-ratio: 2 / 3; margin-bottom: 8px; border-radius: 8px; overflow: hidden;
  background: #0b1020;
  box-shadow: 0 18px 30px -16px rgba(0, 0, 0, .95), 0 0 0 1px rgba(255, 255, 255, .08);
  transition: transform .4s var(--expo), box-shadow .4s var(--expo);
}
.bt-card-cover svg { width: 100%; height: 100%; }
.bt-card:hover .bt-card-cover, .bt-card:focus-visible .bt-card-cover {
  transform: translateY(-5px);
  box-shadow: 0 28px 40px -18px rgba(0, 0, 0, .95), 0 0 0 1px rgba(95, 225, 255, .4), 0 12px 44px -12px rgba(60, 190, 255, .45);
}
.bt-card:focus-visible { outline-offset: 6px; }
.bt-card-title { font-weight: 600; font-size: 14px; line-height: 1.3; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bt-card-meta { font-size: 12.5px; line-height: 1.35; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bt-card-skel { aspect-ratio: 2 / 3; border-radius: 8px; }
.bt-rows { list-style: none; display: grid; gap: 4px; margin-top: 18px; }
.bt-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 6px 10px; border-radius: 12px; text-align: left; }
.bt-row:hover { background: rgba(255, 255, 255, .05); }
.bt-row .sg-cover { flex: none; width: 30px; height: 45px; border-radius: 4px; overflow: hidden; box-shadow: 0 6px 14px -4px rgba(0, 0, 0, .7); }
.bt-row .sg-cover svg { width: 100%; height: 100%; }
.bt-row-text { display: flex; flex-direction: column; min-width: 0; }
.bt-row-text b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-row-text small { color: var(--ink-3); font-size: 13px; }
.bt-mode { margin-bottom: 14px; }
.bt-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 8px rgba(255, 207, 122, .7); }

/* premium */
.bt-prem-hero { position: relative; }
.bt-prem-hero::before {
  content: ""; position: absolute; z-index: -1; left: -28px; right: -28px; top: -28px; height: 260px; pointer-events: none;
  background: radial-gradient(60% 90% at 18% 0%, rgba(95, 225, 255, .14), transparent 70%), radial-gradient(50% 80% at 90% 10%, rgba(169, 155, 255, .12), transparent 70%);
}
.bt-prem { position: relative; isolation: isolate; }
.bt-prem-badge { margin-bottom: 16px; }
.bt-prem-badge i svg { width: 16px; height: 16px; }
.bt-prem-h { font-size: clamp(24px, 3.8vw, 34px) !important; }
.bt-feats { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 24px 0 14px; }
.bt-feat {
  position: relative; overflow: hidden; padding: 18px; border-radius: 18px; border: 1px solid var(--line);
  background: linear-gradient(180deg, #1b2131, #141b2b);
}
.bt-feat.is-hero { border-color: rgba(95, 225, 255, .2); background: radial-gradient(120% 80% at 50% 120%, rgba(60, 190, 255, .16), transparent 70%), linear-gradient(180deg, #1d2333, #151c2c); }
.bt-feat-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
.bt-feat h3 { font: 700 16px/1.3 var(--ui); margin-bottom: 6px; }
.bt-feat p { font-size: 14px; line-height: 1.55; color: var(--ink-2); }
.bt-pill {
  display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line-hi); font-size: 11.5px; font-weight: 600; line-height: 1.2; color: var(--ink-3); white-space: nowrap;
}
.bt-pill::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .7; }
.bt-pill.is-on { color: var(--mint); border-color: rgba(126, 240, 193, .3); background: rgba(126, 240, 193, .06); }
.bt-pricing { margin-top: 6px; padding: 20px 22px; border-radius: 18px; border: 1px solid rgba(95, 225, 255, .18); background: linear-gradient(180deg, rgba(95, 225, 255, .065), rgba(95, 225, 255, .012)); }
.bt-pricing h3 { font: 700 16px/1.3 var(--ui); margin-bottom: 12px; }
.bt-pricing ul { list-style: none; display: grid; gap: 10px; }
.bt-pricing li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; font-size: 14.5px; line-height: 1.5; color: var(--ink-2); }
.bt-pricing li svg { width: 20px; height: 20px; margin-top: 1px; color: var(--cyan); }

/* ---- loading overlay ---- */
.bt-loading {
  position: fixed; inset: 0; z-index: 850; display: flex; overflow-y: auto;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  background: radial-gradient(900px 560px at 50% 40%, rgba(30, 110, 255, .17), transparent 70%), rgba(2, 3, 9, .94);
  animation: fade-in .35s var(--ease);
}
.bt-loading.is-closing { animation: bt-fade-out .36s var(--ease) forwards; pointer-events: none; }
.bt-ld-inner { width: min(560px, 100%); margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; animation: rise .6s var(--expo); }
.bt-ld-kicker { font: 700 12px/1.2 var(--ui); letter-spacing: .16em; text-transform: uppercase; color: var(--cyan); }
.bt-ld-title {
  max-width: 100%; margin: 10px 0 14px; font: italic 600 clamp(26px, 5.4vw, 44px)/1.15 var(--serif); color: #fff;
  text-wrap: balance; overflow-wrap: anywhere; text-shadow: 0 0 30px rgba(60, 150, 255, .35);
}
.bt-ld-step { min-height: 1.6em; font-size: 16.5px; font-weight: 500; color: var(--ink-2); }
.bt-ld-step span { display: inline-block; animation: bt-step-in .55s var(--expo); }
@keyframes bt-step-in { from { opacity: 0; transform: translateY(9px); filter: blur(4px); } }
.bt-ld-dots { list-style: none; display: flex; gap: 6px; margin: 16px 0 4px; }
.bt-ld-dots li { position: relative; overflow: hidden; width: 30px; height: 4px; border-radius: 4px; background: rgba(255, 255, 255, .12); transition: background .4s, box-shadow .4s; }
.bt-ld-dots li.is-done { background: var(--cyan); box-shadow: 0 0 10px rgba(95, 225, 255, .6); }
.bt-ld-dots li.is-active::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, var(--cyan), transparent); animation: bt-dot 1.25s linear infinite; }
@keyframes bt-dot { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.bt-ld-slow { max-width: 30em; margin-top: 10px; font-size: 13.5px; color: var(--ink-3); animation: fade-in .6s var(--ease); }
.bt-ld-cancel { margin-top: 28px; }

/* the open book: covers + page blocks + flipping leaves, seen from above */
.bt-ld-book { --bk: #1b86b0; --bk2: #0a2f4f; --bk-accent: #5fe1ff; position: relative; width: 260px; height: 168px; margin-bottom: 30px; perspective: 900px; }
.bt-ld-glow {
  position: absolute; left: 50%; top: 58%; width: 340px; height: 150px; transform: translate(-50%, -50%);
  background: radial-gradient(closest-side, rgba(95, 225, 255, .42), rgba(60, 150, 255, .14) 55%, transparent);
  filter: blur(8px); animation: bt-glow 2.6s ease-in-out infinite;
}
@keyframes bt-glow { 50% { opacity: .65; transform: translate(-50%, -50%) scale(.92); } }
.bt-ld-3d { position: absolute; inset: 0; transform-style: preserve-3d; transform: rotateX(54deg); animation: bt-bob 4.2s ease-in-out infinite; }
@keyframes bt-bob { 50% { transform: rotateX(50deg) translateY(-6px); } }
.bt-ld-3d i { position: absolute; display: block; }
.bt-ld-cover {
  top: 4px; width: 126px; height: 162px; background: linear-gradient(150deg, var(--bk), var(--bk2));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .14), 0 0 22px -4px var(--bk-accent), 0 30px 40px -10px rgba(0, 0, 0, .8);
}
.bt-ld-cover.l { right: 50%; border-radius: 10px 2px 2px 10px; }
.bt-ld-cover.r { left: 50%; border-radius: 2px 10px 10px 2px; }
.bt-ld-block {
  top: 11px; width: 114px; height: 148px; transform: translateZ(5px);
  background: repeating-linear-gradient(180deg, transparent 0 9px, rgba(60, 70, 90, .13) 9px 10px) 14px 18px / 78px 112px no-repeat, linear-gradient(90deg, #ddd5c4, #f6f1e5 14%, #fbf8f0);
}
.bt-ld-block.l { right: 50%; border-radius: 6px 0 0 6px; transform: translateZ(5px) scaleX(-1); }
.bt-ld-block.r { left: 50%; border-radius: 0 6px 6px 0; }
.bt-ld-leaf {
  top: 11px; left: 50%; width: 114px; height: 148px; border-radius: 0 6px 6px 0; transform-origin: 0 50%;
  transform: translateZ(6px) rotateY(0deg);
  background: repeating-linear-gradient(180deg, transparent 0 9px, rgba(60, 70, 90, .12) 9px 10px) 14px 18px / 78px 112px no-repeat, linear-gradient(90deg, #e2dacb, #fbf7ee 20%, #fffdf7);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .04);
  animation: bt-flip 2.8s cubic-bezier(.5, .05, .3, 1) infinite;
}
.bt-ld-leaf.l1 { animation-delay: .7s; }
.bt-ld-leaf.l2 { animation-delay: 1.4s; }
.bt-ld-leaf.l3 { animation-delay: 2.1s; }
@keyframes bt-flip {
  0% { transform: translateZ(6px) rotateY(0deg); filter: brightness(1); }
  50% { filter: brightness(.82); }
  70%, 100% { transform: translateZ(6px) rotateY(-180deg); filter: brightness(.96); }
}
.bt-ld-sparks { position: absolute; left: 50%; top: 46%; width: 0; height: 0; }
.bt-ld-sparks i {
  position: absolute; left: var(--x); top: 0; width: 4px; height: 4px; border-radius: 50%; opacity: 0;
  background: #dffaff; box-shadow: 0 0 8px 2px rgba(95, 225, 255, .8);
  animation: bt-spark 2.6s ease-out infinite; animation-delay: var(--d);
}
@keyframes bt-spark {
  0% { opacity: 0; transform: translate(0, 0) scale(var(--s)); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(var(--x) * .35), -110px) scale(calc(var(--s) * .4)); }
}
.bt-ld-book.is-found .bt-ld-glow { animation: bt-found 0.7s var(--expo) forwards; }
@keyframes bt-found { 0% { transform: translate(-50%, -50%) scale(1); } 40% { transform: translate(-50%, -50%) scale(1.35); opacity: 1; } 100% { transform: translate(-50%, -50%) scale(1.15); opacity: .9; } }
.bt-ld-book.is-found .bt-ld-leaf { animation-play-state: paused; }

/* ---- footer ---- */
.bt-footer { position: relative; z-index: 1; margin-top: 56px; padding: 40px 0 calc(32px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: linear-gradient(180deg, rgba(10, 16, 32, 0), rgba(10, 16, 32, .55)); }
.bt-footer-in { width: min(1200px, calc(100% - 2 * clamp(16px, 4vw, 40px))); margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px 40px; align-items: start; }
.bt-footer-brand .brand { display: inline-flex; }
.bt-footer-tag { margin-top: 8px; font: italic 600 15px/1.4 var(--serif); color: var(--ink-2); }
.bt-footer-nav { display: flex; flex-wrap: wrap; gap: 6px 22px; justify-content: flex-end; }
.bt-footer-nav a { display: inline-flex; align-items: center; min-height: 44px; font-size: 14px; color: var(--ink-2); transition: color .2s; }
.bt-footer-nav a:hover { color: #fff; }
.bt-footer-note { grid-column: 1 / -1; max-width: 46em; font-size: 13.5px; color: var(--ink-3); }
.bt-footer-small { grid-column: 1 / -1; font-size: 12.5px; color: var(--ink-3); opacity: .8; }

/* ---- direct-link placeholder + fallback book page (used until js/book-view.js exists) ---- */
.bt-wait { display: flex; gap: 28px; align-items: flex-start; width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: calc(var(--nav-h) + 56px) 0 80px; }
.bt-wait-cover { flex: none; width: min(200px, 36vw); aspect-ratio: 2 / 3; border-radius: 10px; }
.bt-wait-lines { flex: 1; display: grid; gap: 12px; padding-top: 12px; }
.bt-fb { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: calc(var(--nav-h) + 36px) 0 40px; display: grid; gap: 18px; }
.bt-fb-back { justify-self: start; }
.bt-fb-head { display: flex; gap: 28px; align-items: flex-end; flex-wrap: wrap; }
.bt-fb-cover { width: min(200px, 44vw); aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; box-shadow: var(--shadow); }
.bt-fb-cover svg { width: 100%; height: 100%; }
.bt-fb-head h1 { font: 800 clamp(28px, 5vw, 48px)/1.1 var(--display); text-wrap: balance; }
.bt-fb-author { margin-top: 6px; color: var(--ink-2); }
.bt-fb-tagline { margin-top: 10px; font: italic 600 18px/1.4 var(--serif); color: var(--amber); }
.bt-fb-sec { padding: 22px; }
.bt-fb-sec h2 { font: 700 18px/1.2 var(--display); margin-bottom: 12px; }
.bt-fb-sec p + p { margin-top: 10px; }
.bt-fb-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }
.bt-fb-skel { display: grid; gap: 10px; }
.bt-fb-error { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--rose); }

/* ---- small screens ---- */
@media (max-width: 720px) {
  .bt-feats { grid-template-columns: 1fr; }
  .bt-footer-in { grid-template-columns: 1fr; }
  .bt-footer-nav { justify-content: flex-start; }
}
@media (max-width: 600px) {
  .modal-backdrop { padding: 10px; align-items: end; }
  .modal { padding: 24px 18px 20px; max-height: calc(100dvh - 20px); border-radius: 22px; }
  .bt-steps { grid-template-columns: 1fr; }
  .bt-grid { grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 18px 12px; }
  .bt-grid.is-compact { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); }
  .bt-card-year { display: none; }
  .bt-actions > * { flex: 1 1 auto; }
  .bt-ld-book { transform: scale(.82); margin: -10px 0 18px; }
  .bt-wait { flex-direction: column; }
}
@media (max-height: 520px) {
  .bt-ld-book { transform: scale(.68); margin: 6px 0 -18px; }
  .bt-ld-title { font-size: clamp(22px, 7.5vh, 34px); margin: 6px 0 8px; }
  .bt-ld-dots { margin-top: 10px; }
  .bt-ld-cancel { margin-top: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .bt-ld-leaf, .bt-ld-sparks, .bt-ld-dots li.is-active::after { animation: none !important; }
  .bt-ld-sparks { display: none; }
  .bt-ld-3d { animation: none; }
}
`;

function injectStyles() {
  if (document.getElementById("bt-app-css")) return;
  const style = document.createElement("style");
  style.id = "bt-app-css";
  style.textContent = APP_CSS;
  document.head.append(style);
}

if (document.getElementById("view-home") && document.getElementById("view-book")) boot();
