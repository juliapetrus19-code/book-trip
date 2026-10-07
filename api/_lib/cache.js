// Shared server-side cache of AI results (contract: cache:<part>:<lang>:<key>), so every book is
// generated once for everybody. Reads and writes never throw: a store outage is a cache miss.
//
// Cache poisoning guard: overview / characters / film are keyed by book id, but their input
// (title, author) comes from the client. Results are only written to the shared cache when the id
// is "canonical" — it was returned by /api/resolve (cache:book:<lang>:<id>) — and then the
// canonical title/author are sent to the model instead of the client's.
import { createHash } from "node:crypto";
import { LANGS } from "./enums.js";
import { soft } from "./store.js";

export const NOT_FOUND_TTL = 24 * 3600;

/** Lowercase, trimmed, single-spaced query (the resolve cache key). */
export function normalizeQuery(q) {
  return String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

export const cacheKey = (part, lang, key) => `cache:${part}:${lang}:${key}`;

/** Short stable hash for composite keys (e.g. the film's cast). */
export const hashKey = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export function readCache(part, lang, key) {
  return soft(`read ${part}/${lang}`, (s) => s.getJson(cacheKey(part, lang, key)));
}

export function writeCache(part, lang, key, value, { ttl, nx } = {}) {
  return soft(`write ${part}/${lang}`, (s) => s.setJson(cacheKey(part, lang, key), value, { ex: ttl, nx }), false);
}

/** Remember the identity of a resolved book (first resolution wins, so cached parts stay consistent). */
export function rememberBook(lang, result) {
  if (!result || !result.found || !result.id) return Promise.resolve(false);
  const meta = {
    id: result.id, title: result.title, originalTitle: result.originalTitle, author: result.author,
    year: result.year, genre: result.genre, tagline: result.tagline, cover: result.cover,
  };
  return writeCache("book", lang, result.id, meta, { nx: true });
}

/**
 * The canonical identity of a live book: { meta, lang } for the requested language, else any other
 * language it was resolved in, else null.
 */
export async function canonicalBook(id, lang) {
  const order = [lang, ...LANGS.filter((l) => l !== lang)];
  const metas = await soft(`canonical ${id}`, (s) => s.mgetJson(order.map((l) => cacheKey("book", l, id))), []);
  for (let i = 0; i < order.length; i++) {
    const m = metas && metas[i];
    if (m && typeof m === "object" && m.id === id && typeof m.title === "string") return { meta: m, lang: order[i] };
  }
  return null;
}

/** Books with a cached overview (listed in the sitemap). */
export function addLiveBook(id) {
  return soft("add live book", (s) => s.sadd("books", id), 0);
}

export function liveBooks() {
  return soft("list live books", (s) => s.smembers("books"), []);
}
