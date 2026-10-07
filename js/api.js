// BookTrip — client data layer (owned by app): health, demo catalog + fuzzy search, demo books,
// live AI parts with a localStorage LRU cache, portraits and premium video.
//
// Every network call goes through fetchJson(): AbortController + timeout, typed errors
// ({ code, message, status }) with codes matching SPEC §3 plus client-side ones:
// network | timeout | aborted | bad_response | needs_characters.

import { normalizeQuery, store } from "./util.js";
import { LANGS } from "./enums.js";

// ---------------------------------------------------------------------------------------------
// Errors + fetch

export class ApiError extends Error {
  constructor(code, message, { status = 0, retryAfter = 0 } = {}) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const STATUS_CODES = { 400: "bad_request", 401: "login_required", 402: "paywall", 403: "forbidden", 404: "not_found", 422: "refused", 429: "rate_limited", 502: "upstream", 503: "not_configured", 504: "timeout" };

/** Normalise anything thrown into an ApiError (handy for UI code). */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err && err.name === "AbortError") return new ApiError("aborted", "Request aborted");
  return new ApiError("network", (err && err.message) || "Network error");
}

/**
 * fetch + JSON with a timeout and an optional external AbortSignal.
 * Non-JSON answers (an HTML 404 page from a static host) become `not_configured` for /api/ calls.
 */
async function fetchJson(url, { timeout = 30000, signal, method = "GET", body, headers = {} } = {}) {
  if (signal?.aborted) throw new ApiError("aborted", "Request aborted");
  const ctrl = new AbortController();
  let reason = "";
  const timer = setTimeout(() => { reason = "timeout"; ctrl.abort(); }, timeout);
  const onAbort = () => { reason = "aborted"; ctrl.abort(); };
  signal?.addEventListener("abort", onAbort, { once: true });

  let res;
  try {
    res = await fetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      signal: ctrl.signal,
      credentials: "same-origin",
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (reason === "timeout") throw new ApiError("timeout", "The request took too long");
    if (reason === "aborted" || err?.name === "AbortError") throw new ApiError("aborted", "Request aborted");
    throw new ApiError("network", "Network error");
  }

  try {
    const isApi = String(url).startsWith("/api/") || String(url).includes("/api/");
    const type = res.headers.get("content-type") || "";
    let data = null;
    if (type.includes("json")) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      // No API at all (static hosting): HTML / plain-text 404 or 405.
      if (isApi && !data && (res.status === 404 || res.status === 405)) {
        throw new ApiError("not_configured", "The AI back-end is not available", { status: res.status });
      }
      const code = (data && typeof data.error === "string" && data.error) || STATUS_CODES[res.status] || (res.status >= 500 ? "server" : "bad_request");
      throw new ApiError(code, (data && data.message) || res.statusText || code, { status: res.status, retryAfter });
    }
    if (data == null || typeof data !== "object") {
      throw new ApiError(isApi ? "not_configured" : "bad_response", "Unexpected response", { status: res.status });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (reason === "timeout") throw new ApiError("timeout", "The request took too long");
    if (reason === "aborted" || err?.name === "AbortError") throw new ApiError("aborted", "Request aborted");
    throw new ApiError("bad_response", "Unexpected response");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const qs = (params) => Object.entries(params)
  .filter(([, v]) => v != null && v !== "")
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join("&");

const pickLang = (lang) => (LANGS.includes(lang) ? lang : "en");
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------------------------
// Health

const NO_BILLING = Object.freeze({ enabled: false, env: "sandbox", clientToken: "", prices: [] });
const OFFLINE_HEALTH = Object.freeze({
  live: false, portraits: false, video: false, premiumCodeRequired: true, model: "", demoOnly: true, failed: false,
  account: false, billing: NO_BILLING, freeBooks: 2, telegram: null, store: "memory",
});
let healthPromise = null;

/** billing block of /api/health → { enabled, env, clientToken, prices: [{ id, period, label }] } (month first). */
function cleanBilling(b) {
  if (!b || typeof b !== "object" || b.enabled !== true) return NO_BILLING;
  const prices = arr(b.prices)
    .filter((p) => p && isStr(p.id) && (p.period === "month" || p.period === "year"))
    .map((p) => ({ id: p.id, period: p.period, label: isStr(p.label) ? p.label.trim().slice(0, 24) : "" }))
    .sort((a, b2) => (a.period === b2.period ? 0 : a.period === "month" ? -1 : 1));
  return {
    enabled: prices.length > 0,
    env: b.env === "production" ? "production" : "sandbox",
    clientToken: isStr(b.clientToken) ? b.clientToken : "",
    prices,
  };
}

/** Telegram username for "write us" links, or null. */
const cleanTelegram = (v) => (typeof v === "string" && /^[A-Za-z0-9_]{5,32}$/.test(v.replace(/^@/, "")) ? v.replace(/^@/, "") : null);

/**
 * { live, portraits, video, premiumCodeRequired, model, demoOnly, failed,
 *   account, billing: { enabled, env, clientToken, prices }, freeBooks, telegram, store }. Never rejects; memoized.
 * `failed` = the check itself did not get through (network / timeout), so a later retry may help.
 */
export function getHealth({ refresh = false } = {}) {
  if (!healthPromise || refresh) {
    healthPromise = fetchJson("/api/health", { timeout: 4000 })
      .then((h) => {
        const live = h.live === true;
        return {
          live,
          portraits: h.portraits === true,
          video: h.video === true,
          premiumCodeRequired: h.premiumCodeRequired !== false,
          model: typeof h.model === "string" ? h.model : "",
          demoOnly: !live,
          failed: false,
          account: h.account === true,
          billing: cleanBilling(h.billing),
          freeBooks: Number.isInteger(h.freeBooks) && h.freeBooks >= 0 ? h.freeBooks : 2,
          telegram: cleanTelegram(h.telegram),
          store: h.store === "redis" ? "redis" : "memory",
        };
      })
      .catch((err) => ({ ...OFFLINE_HEALTH, failed: err?.code === "network" || err?.code === "timeout" }));
  }
  return healthPromise;
}

/** Downgrade the cached health (e.g. after a live call answered not_configured). */
export function markNotConfigured() {
  const prev = healthPromise || Promise.resolve(OFFLINE_HEALTH);
  healthPromise = prev.then((h) => ({ ...h, live: false, portraits: false, video: false, demoOnly: true }), () => ({ ...OFFLINE_HEALTH }));
}

// ---------------------------------------------------------------------------------------------
// Demo catalog

/** Known demo ids, used until data/catalog.json exists. */
export const DEMO_IDS = [
  "little-prince", "harry-potter-philosophers-stone", "alice-in-wonderland", "the-hobbit",
  "nineteen-eighty-four", "pride-and-prejudice", "hound-of-the-baskervilles", "the-great-gatsby",
  "three-musketeers", "treasure-island", "shadows-of-forgotten-ancestors", "romeo-and-juliet",
];

const rawBooks = new Map(); // id → Promise<raw demo file>
let catalogPromise = null;

function fetchRawBook(id) {
  if (!/^[a-z0-9-]{1,100}$/.test(String(id))) return Promise.reject(new ApiError("not_found", "Unknown book"));
  if (!rawBooks.has(id)) {
    const p = fetchJson(`/data/books/${id}.json`, { timeout: 15000 }).then((b) => {
      if (!b || typeof b !== "object" || !b.i18n) throw new ApiError("bad_response", "Broken demo book");
      return b;
    });
    p.catch(() => rawBooks.delete(id)); // allow a retry later
    rawBooks.set(id, p);
  }
  return rawBooks.get(id);
}

/** Same shape as data/catalog.json, built from a full demo file. */
function catalogEntry(b) {
  const pick = (k) => Object.fromEntries(LANGS.map((l) => [l, b.i18n?.[l]?.[k] || b.i18n?.en?.[k] || ""]));
  const aliases = new Set(arr(b.aliases).filter(isStr));
  for (const l of LANGS) {
    if (isStr(b.i18n?.[l]?.title)) aliases.add(b.i18n[l].title);
    if (isStr(b.i18n?.[l]?.originalTitle)) aliases.add(b.i18n[l].originalTitle);
  }
  const originalTitle = b.i18n?.en?.originalTitle || b.i18n?.uk?.originalTitle || b.i18n?.ru?.originalTitle || "";
  return { id: b.id, year: b.year ?? null, cover: b.cover, title: pick("title"), author: pick("author"), genre: pick("genre"), originalTitle, aliases: [...aliases] };
}

function cleanCatalog(list) {
  const seen = new Set();
  return arr(list).filter((e) => e && typeof e === "object" && /^[a-z0-9-]+$/.test(e.id || "") && e.title && !seen.has(e.id) && seen.add(e.id));
}

/** Array of { id, year, cover, title:{ru,uk,en}, author:{ru,uk,en}, aliases }. Never rejects; memoized. */
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchJson("/data/catalog.json", { timeout: 10000 })
      .then((list) => {
        if (!Array.isArray(list)) throw new ApiError("bad_response", "catalog is not an array");
        return cleanCatalog(list);
      })
      .catch(async () => {
        const books = await Promise.allSettled(DEMO_IDS.map(fetchRawBook));
        return cleanCatalog(books.filter((r) => r.status === "fulfilled").map((r) => catalogEntry(r.value)));
      });
  }
  return catalogPromise;
}

/** Localised { id, title, author, year, cover } for one catalog entry. */
export function localizeEntry(entry, lang) {
  const l = pickLang(lang);
  const loc = (v) => (v && typeof v === "object" ? v[l] || v.en || v.ru || Object.values(v)[0] || "" : String(v ?? ""));
  return { id: entry.id, title: loc(entry.title), author: loc(entry.author), year: entry.year ?? null, cover: entry.cover, genre: loc(entry.genre) };
}

// Library categories, derived from the English genre text (+ the original title for Ukrainian classics).
const CATEGORY_RULES = [
  ["fantasy", /fantas|fairy|fable|myth|magic|legend|tale\b/],
  ["scifi", /science|sci-?fi|dystop|utopi|space|cyber|futur/],
  ["detective", /detect|myster|crime|thriller|noir|spy|sleuth/],
  ["adventure", /adventur|pirate|sea story|travel|quest|survival|western/],
  ["romance", /roman(ce|tic)|\blove|manners/],
  ["drama", /trag|drama|\bplay\b|comed|poem|poetry|verse|ballad/],
  ["children", /child|kids|juvenile|young|picture book/],
];
export const CATEGORIES = ["ukrainian", ...CATEGORY_RULES.map(([k]) => k), "classic"];

/** Category keys of one catalog entry (at least one: "classic" when nothing else matches). */
export function categoriesOf(entry) {
  const g = String((entry && entry.genre && (entry.genre.en || Object.values(entry.genre)[0])) || "").toLowerCase();
  const out = [];
  if (/[іїєґ]/i.test(String(entry?.originalTitle || ""))) out.push("ukrainian");
  for (const [key, re] of CATEGORY_RULES) if (re.test(g)) out.push(key);
  if (!out.length || (out.length === 1 && out[0] === "ukrainian")) out.push("classic");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fuzzy search over the catalog

const STOP = new Set(["the", "a", "an", "of", "and", "или", "и", "в", "во", "на", "о", "об", "та", "й", "у", "з", "із", "de", "la", "le", "les", "du", "der", "die", "das"]);

const words = (s) => normalizeQuery(s).split(" ").filter(Boolean);
const meaningful = (tokens) => {
  const m = tokens.filter((w) => w.length > 1 && !STOP.has(w));
  return m.length ? m : tokens;
};

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one query word matches one candidate word (0…1). */
function wordScore(q, w) {
  if (q === w) return 1;
  if (w.startsWith(q)) return q.length >= 2 ? 0.92 - Math.min(0.2, (w.length - q.length) * 0.025) : 0.45;
  if (q.length >= 4 && w.length >= 4 && q.startsWith(w)) return 0.82; // inflected form: «принца» → «принц»
  if (q.length >= 4 && w.length >= 4) {
    const max = q.length >= 5 ? 2 : 1;
    const d = levenshtein(q, w, max);
    if (d <= max) return d <= 1 ? 0.8 : 0.62;
    // a typo inside a word that is still being typed: compare with the same-length prefix
    if (w.length > q.length && levenshtein(q, w.slice(0, q.length), 1) <= 1) return 0.7;
  }
  return 0;
}

/** Score a query against one normalised candidate string. */
function stringScore(qNorm, qTokens, cand) {
  const { norm, tokens, mean } = cand;
  if (!norm) return 0;
  if (norm === qNorm) return 1;
  let base = 0;
  if (qNorm.length >= 2 && norm.startsWith(qNorm)) base = 0.9 + 0.08 * (qNorm.length / norm.length);
  else if (qNorm.length >= 3 && (" " + norm).includes(" " + qNorm)) base = 0.78 + 0.1 * (qNorm.length / norm.length);

  const used = new Set();
  let sum = 0;
  for (const q of qTokens) {
    let best = 0;
    let bi = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (used.has(i)) continue;
      const s = wordScore(q, tokens[i]);
      if (s > best) { best = s; bi = i; }
    }
    if (bi >= 0) used.add(bi);
    sum += best;
  }
  const qCov = sum / qTokens.length;
  const matchedMeaningful = [...used].filter((i) => mean.has(i)).length;
  const sCov = Math.min(1, matchedMeaningful / Math.max(1, mean.size));
  return Math.max(base, qCov * (0.7 + 0.3 * sCov));
}

const prepared = new WeakMap();
function candidates(entry) {
  if (prepared.has(entry)) return prepared.get(entry);
  const make = (text, weight) => {
    const tokens = words(text);
    const mean = new Set();
    tokens.forEach((w, i) => { if (w.length > 1 && !STOP.has(w)) mean.add(i); });
    return { norm: tokens.join(" "), tokens, mean, weight };
  };
  const list = [];
  const seen = new Set();
  const add = (text, weight) => {
    if (!isStr(text)) return;
    const c = make(text, weight);
    const key = c.norm + "|" + weight;
    if (c.norm && !seen.has(key)) { seen.add(key); list.push(c); }
  };
  const vals = (v) => (v && typeof v === "object" ? Object.values(v) : [v]);
  for (const t of vals(entry.title)) add(t, 1);
  for (const a of arr(entry.aliases)) add(a, 0.98);
  for (const a of vals(entry.author)) add(a, 0.8);
  for (const l of LANGS) {
    const t = entry.title?.[l];
    const a = entry.author?.[l];
    if (isStr(t) && isStr(a)) add(`${t} ${a}`, 0.95);
  }
  prepared.set(entry, list);
  return list;
}

/** Synchronous ranking over a given catalog → [{ id, score, title, author, year, cover, entry }]. */
export function rankCatalog(catalog, query, { lang, limit = 8, min = 0.34 } = {}) {
  const qTokensAll = words(query);
  if (!qTokensAll.length) return [];
  const qNorm = qTokensAll.join(" ");
  const qTokens = meaningful(qTokensAll);
  const out = [];
  for (const entry of arr(catalog)) {
    let best = 0;
    for (const c of candidates(entry)) {
      const s = stringScore(qNorm, qTokens, c) * c.weight;
      if (s > best) best = s;
    }
    if (best >= min) out.push({ ...localizeEntry(entry, lang), score: Math.round(best * 1000) / 1000, entry });
  }
  out.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  return out.slice(0, limit);
}

/** Fuzzy search over titles / authors / aliases in all languages. Resolves to ranked results. */
export async function matchCatalog(query, opts = {}) {
  return rankCatalog(await loadCatalog(), query, opts);
}

/** Is this live-resolved book one of our demo books? Returns the demo id or null. */
export async function demoIdFor(meta) {
  if (!meta) return null;
  const catalog = await loadCatalog();
  if (catalog.some((e) => e.id === meta.id)) return meta.id;
  const authorWords = new Set(meaningful(words(meta.author)));
  for (const title of [meta.originalTitle, meta.title]) {
    if (!isStr(title)) continue;
    const [best] = rankCatalog(catalog, title, { limit: 1, min: 0.95 });
    if (!best) continue;
    if (!authorWords.size) return best.id;
    const demoAuthor = Object.values(best.entry.author || {}).flatMap(words);
    if (demoAuthor.some((w) => [...authorWords].some((a) => wordScore(a, w) >= 0.8))) return best.id;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Demo books → BookView (SPEC §2.7)

/** Merge a demo file + language into a BookView. Missing texts fall back to en, then ru. */
export function demoToBookView(raw, lang) {
  const l = pickLang(lang);
  const order = [l, "en", "ru", "uk"];
  const L = order.map((k) => raw.i18n?.[k]).find(Boolean) || {};
  const get = (k) => {
    for (const k2 of order) {
      const v = raw.i18n?.[k2]?.[k];
      if (v != null && v !== "") return v;
    }
    return undefined;
  };
  const charText = (id) => order.map((k) => raw.i18n?.[k]?.characters?.[id]).find(Boolean) || {};

  const characters = arr(raw.characters).filter((c) => c && c.id).map((c) => {
    const tx = charText(c.id);
    return {
      id: c.id,
      name: tx.name || c.id,
      role: c.role || "supporting",
      traits: arr(tx.traits),
      description: tx.description || "",
      appearance: c.appearance || {},
      portraitPrompt: c.portraitPrompt || "",
    };
  });

  const shared = raw.film || {};
  const texts = (L.film && L.film.scenes) || get("film")?.scenes || [];
  const film = {
    title: L.film?.title || get("film")?.title || "",
    intro: L.film?.intro || get("film")?.intro || "",
    outro: L.film?.outro || get("film")?.outro || "",
    scenes: arr(shared.scenes).map((s, i) => {
      const tx = texts[i] || {};
      const line = s.line && s.line.speaker ? { speaker: s.line.speaker, text: (tx.line && tx.line.text) || "" } : null;
      return { ...s, title: tx.title || "", narration: tx.narration || "", line: line && line.text ? line : null };
    }),
    videoPrompts: arr(shared.videoPrompts),
  };

  return {
    id: raw.id,
    lang: l,
    source: "demo",
    title: get("title") || raw.id,
    originalTitle: get("originalTitle") || "",
    author: get("author") || "",
    year: Number.isFinite(raw.year) ? raw.year : null,
    genre: get("genre") || "",
    tagline: get("tagline") || "",
    cover: raw.cover || null,
    summary: arr(L.summary ?? get("summary")),
    themes: arr(L.themes ?? get("themes")),
    terms: arr(L.terms ?? get("terms")),
    similar: arr(L.similar ?? get("similar")),
    characters,
    film,
  };
}

/** BookView for a bundled demo book. Rejects with ApiError(not_found) for unknown ids. */
export async function loadDemoBook(id, lang) {
  return demoToBookView(await fetchRawBook(id), lang);
}

// ---------------------------------------------------------------------------------------------
// Live mode

const TEXT_TIMEOUT = 280000;
const RESOLVE_TIMEOUT = 150000;
const resolveMemo = new Map(); // lang|normalized query → Promise

/** GET /api/resolve → { found:true, id, title, … } | { found:false, suggestions }. */
export function resolveLive(query, lang, { signal } = {}) {
  const l = pickLang(lang);
  const q = String(query ?? "").trim().slice(0, 200);
  if (!q) return Promise.reject(new ApiError("bad_request", "Empty query"));
  const key = l + "|" + normalizeQuery(q);
  if (resolveMemo.has(key)) return resolveMemo.get(key);
  const p = fetchJson(`/api/resolve?${qs({ q, lang: l })}`, { timeout: RESOLVE_TIMEOUT, signal }).then((r) => {
    if (r.found === true && isStr(r.id) && isStr(r.title)) return { ...r, found: true };
    return { found: false, suggestions: arr(r.suggestions).filter((s) => s && isStr(s.title)) };
  });
  resolveMemo.set(key, p);
  p.catch(() => resolveMemo.delete(key));
  return p;
}

// --- localStorage LRU cache for live parts: bt-cache:<id>:<lang>:<part> ---

const CACHE_PREFIX = "bt-cache:";
const CACHE_INDEX = "bt-cache-lru";
const CACHE_MAX = 40;

const cacheKey = (id, lang, part) => `${CACHE_PREFIX}${id}:${lang}:${part}`;

function readIndex() {
  let idx = [];
  try {
    const v = JSON.parse(store.get(CACHE_INDEX) || "[]");
    if (Array.isArray(v)) idx = v.filter((k) => typeof k === "string" && k.startsWith(CACHE_PREFIX));
  } catch { /* corrupted index → rebuild */ }
  // entries written by another tab or left without an index become the oldest
  const known = new Set(idx);
  const stray = store.keys().filter((k) => k.startsWith(CACHE_PREFIX) && !known.has(k));
  return [...stray, ...idx.filter((k, i) => idx.indexOf(k) === i)];
}

const writeIndex = (idx) => store.set(CACHE_INDEX, JSON.stringify(idx));

export function cacheGet(key) {
  const raw = store.get(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !("d" in v)) throw new Error("bad entry");
    const idx = readIndex().filter((k) => k !== key);
    idx.push(key);
    writeIndex(idx);
    return v.d;
  } catch {
    store.remove(key);
    return null;
  }
}

export function cacheSet(key, data) {
  const value = JSON.stringify({ t: Date.now(), d: data });
  const idx = readIndex().filter((k) => k !== key);
  while (idx.length >= CACHE_MAX) store.remove(idx.shift());
  // quota exceeded → evict the oldest entries and try again
  let ok = store.set(key, value);
  while (!ok && idx.length) {
    store.remove(idx.shift());
    ok = store.set(key, value);
  }
  if (ok) idx.push(key);
  writeIndex(idx);
  return ok;
}

/** cast param for /api/film: "id:Name,id:Name…" */
function castParam(characters) {
  return arr(characters)
    .filter((c) => c && /^[a-z0-9-]+$/.test(c.id || "") && isStr(c.name))
    .slice(0, 14)
    .map((c) => `${c.id}:${String(c.name).replace(/[,\n]/g, " ").trim()}`)
    .join(",");
}

/** Light shape checks so a broken cache entry or answer never reaches the UI. */
function validPart(part, d) {
  if (!d || typeof d !== "object") return false;
  if (part === "overview") return Array.isArray(d.summary) && d.summary.length > 0;
  if (part === "characters") return Array.isArray(d.characters) && d.characters.length > 0;
  if (part === "film") return Array.isArray(d.scenes) && d.scenes.length > 0;
  return false;
}

const inflight = new Map();

/**
 * Load one live part for a book: "overview" → { summary, themes, terms, similar },
 * "characters" → { characters }, "film" → Film (+ videoToken). `meta` = { id, title, author, characters? }.
 * The film needs the cast, so pass a book whose `characters` already arrived.
 */
export function loadLivePart(meta, part, lang, { signal, force = false } = {}) {
  const l = pickLang(lang);
  if (!meta || !isStr(meta.id) || !isStr(meta.title)) return Promise.reject(new ApiError("bad_request", "Missing book"));
  if (!["overview", "characters", "film"].includes(part)) return Promise.reject(new ApiError("bad_request", `Unknown part ${part}`));
  const key = cacheKey(meta.id, l, part);
  if (!force) {
    const cached = cacheGet(key);
    if (validPart(part, cached)) return Promise.resolve(cached);
  }

  const params = { id: meta.id, title: meta.apiTitle || meta.title, author: meta.apiAuthor || meta.author || "", lang: l };
  if (part === "film") {
    const cast = castParam(meta.characters);
    if (!cast) return Promise.reject(new ApiError("needs_characters", "The film needs the characters first"));
    params.cast = cast;
  }
  const url = `/api/${part}?${qs(params)}`;
  // Two callers asking for the same part share one request (the first caller's signal governs it).
  if (inflight.has(url)) return inflight.get(url);
  const p = fetchJson(url, { timeout: TEXT_TIMEOUT, signal }).then((data) => {
    if (!validPart(part, data)) throw new ApiError("bad_response", `Empty ${part}`);
    cacheSet(key, data);
    return data;
  });
  inflight.set(url, p);
  p.finally(() => inflight.delete(url)).catch(() => {});
  return p;
}

/**
 * SPEC §4: one-shot search. Demo match first (high score), else the live resolver when connected.
 * → { demo: BookView|null, live: {found,…}|null, suggestions: [{ id?, title, author }] }
 */
export async function searchBooks(query, lang, { signal, threshold } = {}) {
  const [matches, health] = await Promise.all([matchCatalog(query, { lang, limit: 6 }), getHealth()]);
  const best = matches[0];
  const need = threshold ?? (health.live ? 0.9 : 0.6);
  const suggestions = matches.map((m) => ({ id: m.id, title: m.title, author: m.author }));
  if (best && best.score >= need) return { demo: await loadDemoBook(best.id, lang), live: null, suggestions };
  if (!health.live) return { demo: null, live: null, suggestions };
  const live = await resolveLive(query, lang, { signal });
  return { demo: null, live, suggestions: live.found ? suggestions : [...arr(live.suggestions), ...suggestions] };
}

// --- remembered live books: bt-meta:<id> ---

const META_PREFIX = "bt-meta:";
const META_MAX = 30;
const memMeta = new Map(); // session copy: works even when localStorage is unavailable
const META_TEXT = ["title", "author", "genre", "tagline"];

/** Remember a resolved live book (per language) so #/book/<id> survives a reload. */
export function saveMeta(meta, lang) {
  if (!meta || !isStr(meta.id)) return null;
  const l = pickLang(lang);
  const prev = getMeta(meta.id) || {};
  const byLang = { ...(prev.byLang || {}) };
  byLang[l] = Object.fromEntries(META_TEXT.map((k) => [k, meta[k] || byLang[l]?.[k] || ""]));
  const next = {
    id: meta.id,
    originalTitle: meta.originalTitle || prev.originalTitle || "",
    year: Number.isFinite(meta.year) ? meta.year : prev.year ?? null,
    cover: meta.cover || prev.cover || null,
    byLang,
    lastOpened: Date.now(),
  };
  memMeta.set(meta.id, next);
  store.set(META_PREFIX + meta.id, JSON.stringify(next));
  // prune the oldest
  const all = listMeta();
  for (const old of all.slice(META_MAX)) store.remove(META_PREFIX + old.id);
  return next;
}

export function getMeta(id) {
  try {
    const v = JSON.parse(store.get(META_PREFIX + id) || "null");
    if (v && v.id === id && v.byLang) return v;
  } catch { /* fall through */ }
  return memMeta.get(id) || null;
}

export function touchMeta(id) {
  const m = getMeta(id);
  if (!m) return;
  const next = { ...m, lastOpened: Date.now() };
  memMeta.set(id, next);
  store.set(META_PREFIX + id, JSON.stringify(next));
}

/** All remembered live books, most recently opened first. */
export function listMeta() {
  const ids = new Set([...memMeta.keys(), ...store.keys().filter((k) => k.startsWith(META_PREFIX)).map((k) => k.slice(META_PREFIX.length))]);
  return [...ids].map(getMeta).filter(Boolean).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

/** Book header fields for `lang` from stored meta (falls back to any stored language). */
export function metaForLang(stored, lang) {
  if (!stored) return null;
  const l = pickLang(lang);
  const texts = stored.byLang?.[l] || Object.values(stored.byLang || {})[0] || {};
  return {
    id: stored.id,
    title: texts.title || stored.originalTitle || stored.id,
    originalTitle: stored.originalTitle || "",
    author: texts.author || "",
    year: stored.year ?? null,
    genre: texts.genre || "",
    tagline: texts.tagline || "",
    cover: stored.cover || null,
    localized: Boolean(stored.byLang?.[l]),
  };
}

// ---------------------------------------------------------------------------------------------
// Premium: portraits and video

/** URL of an AI portrait image, or null when the character cannot have one. */
export function portraitUrl(book, character) {
  if (!book || !character || !isStr(character.id)) return null;
  if (book.source === "demo") return `/api/portrait?${qs({ demo: book.id, char: character.id })}`;
  if (!isStr(character.portraitPrompt) || !isStr(character.portraitToken)) return null;
  return `/api/portrait?${qs({ book: book.id, char: character.id, lang: book.lang, prompt: character.portraitPrompt, token: character.portraitToken })}`;
}

/** POST /api/video → { jobs: [opId…] }. `code` = the visitor's premium access code. */
export function startVideo(book, code, { signal } = {}) {
  const film = book && book.film;
  const prompts = arr(film && film.videoPrompts).slice(0, 3);
  if (prompts.length !== 3) return Promise.reject(new ApiError("bad_request", "This book has no video prompts"));
  const body = { id: book.id, title: book.title || "", prompts, token: film.videoToken || "" };
  if (book.source === "demo") body.demo = book.id;
  return fetchJson("/api/video", {
    method: "POST",
    body,
    headers: { "x-premium-code": String(code ?? "").trim() },
    timeout: 90000,
    signal,
  }).then((r) => ({ jobs: arr(r.jobs).filter(isStr) }));
}

/** GET /api/video?op= → { done:false } | { done:true, url }. */
export function pollVideo(job, { signal } = {}) {
  return fetchJson(`/api/video?${qs({ op: job })}`, { timeout: 30000, signal }).then((r) => ({
    done: r.done === true && isStr(r.url),
    url: r.done === true && isStr(r.url) ? r.url : null,
  }));
}

/** Poll one job until its clip is ready (resolves with the video URL). */
export async function waitForVideo(job, { signal, interval = 10000, onPoll } = {}) {
  for (let i = 0; ; i++) {
    const r = await pollVideo(job, { signal });
    onPoll?.(i, r);
    if (r.done) return r.url;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new ApiError("aborted", "Request aborted")); }, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// v2: account (magic link), access quota, billing (Paddle), waitlist, funnel events

const NO_ME = Object.freeze({ user: null, opened: [], freeLeft: 0, paywall: false, failed: true });
let mePromise = null;

function cleanMe(m) {
  const u = m && m.user && typeof m.user === "object" && isStr(m.user.email) ? m.user : null;
  return {
    user: u ? {
      email: u.email.trim().slice(0, 254),
      subscribed: u.subscribed === true,
      plan: u.plan === "month" || u.plan === "year" ? u.plan : null,
      endsAt: isStr(u.endsAt) || Number.isFinite(u.endsAt) ? u.endsAt : null,
    } : null,
    opened: arr(m && m.opened).filter((id) => typeof id === "string"),
    freeLeft: Number.isFinite(m && m.freeLeft) ? Math.max(0, m.freeLeft) : 0,
    paywall: m && m.paywall === true,
    failed: false,
  };
}

/** GET /api/me → { user: null | { email, subscribed, plan, endsAt }, opened, freeLeft, paywall, failed }. Never rejects. */
export function getMe({ refresh = false } = {}) {
  if (!mePromise || refresh) {
    mePromise = fetchJson("/api/me", { timeout: 8000 }).then(cleanMe).catch(() => ({ ...NO_ME }));
  }
  return mePromise;
}

/**
 * POST /api/access { id } → { allowed: true, freeLeft, subscribed } | { allowed: false, freeLeft: 0, loggedIn }.
 * Anything but an explicit 402 lets the visitor in (the demo gate is soft; AI parts are gated server-side).
 */
export async function access(id) {
  try {
    const r = await fetchJson("/api/access", { method: "POST", body: { id }, timeout: 8000 });
    return { allowed: r.allowed !== false, freeLeft: Number.isFinite(r.freeLeft) ? Math.max(0, r.freeLeft) : null, subscribed: r.subscribed === true };
  } catch (err) {
    const e = toApiError(err);
    if (e.status === 402 || e.code === "paywall") return { allowed: false, freeLeft: 0, subscribed: false, loggedIn: null };
    return { allowed: true, freeLeft: null, subscribed: false, unknown: true };
  }
}

/** POST /api/auth/start → { ok, devLink? }. `next` must be a same-origin path. */
export function authStart(email, lang, next = "/") {
  const path = typeof next === "string" && /^\/(?:[^/\\]|$)/.test(next) ? next : "/";
  return fetchJson("/api/auth/start", { method: "POST", body: { email: String(email || "").trim(), lang: pickLang(lang), next: path }, timeout: 15000 })
    .then((r) => ({ ok: r.ok === true, devLink: isStr(r.devLink) ? r.devLink : null }));
}

export function logout() {
  return fetchJson("/api/auth/logout", { method: "POST", body: {}, timeout: 8000 }).finally(() => { mePromise = null; });
}

/** POST /api/billing/checkout { period } → { priceId, customData: { uid }, email, env, clientToken }. */
export function billingCheckout(period) {
  return fetchJson("/api/billing/checkout", { method: "POST", body: { period: period === "year" ? "year" : "month" }, timeout: 15000 })
    .then((r) => {
      if (!isStr(r.priceId) || !isStr(r.clientToken)) throw new ApiError("bad_response", "Incomplete checkout");
      return {
        priceId: r.priceId,
        customData: r.customData && typeof r.customData === "object" ? r.customData : {},
        email: isStr(r.email) ? r.email : "",
        env: r.env === "production" ? "production" : "sandbox",
        clientToken: r.clientToken,
      };
    });
}

/** POST /api/billing/portal → { url } (Paddle customer portal). */
export function billingPortal() {
  return fetchJson("/api/billing/portal", { method: "POST", body: {}, timeout: 15000 }).then((r) => {
    if (!isStr(r.url) || !/^https:\/\//.test(r.url)) throw new ApiError("bad_response", "No portal URL");
    return { url: r.url };
  });
}

/** POST /api/waitlist { q, contact, lang } → { ok }. */
export function joinWaitlist(q, contact, lang) {
  return fetchJson("/api/waitlist", { method: "POST", body: { q: String(q || "").trim().slice(0, 200), contact: String(contact || "").trim(), lang: pickLang(lang) }, timeout: 10000 })
    .then((r) => ({ ok: r.ok !== false }));
}

/** Waitlist contact rules (same as the server): @handle / handle (5–32 [A-Za-z0-9_]) or an e-mail, ≤ 120 chars. */
export function validContact(value) {
  const v = String(value || "").trim();
  if (!v || v.length > 120) return false;
  return /^@?[A-Za-z0-9_]{5,32}$/.test(v) || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export const EVENTS = ["search", "book_open", "paywall_shown", "checkout_start", "signup_start", "signup_done", "waitlist_join", "install"];

/** Funnel event, fire-and-forget (sendBeacon when possible). Never throws. */
export function sendEvent(name, id) {
  if (!EVENTS.includes(name)) return;
  const body = JSON.stringify(id && /^[a-z0-9-]{1,100}$/.test(String(id)) ? { name, id: String(id) } : { name });
  try {
    if (navigator.sendBeacon && navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }))) return;
  } catch { /* fall back to fetch */ }
  try {
    fetch("/api/event", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch { /* ignore */ }
}
