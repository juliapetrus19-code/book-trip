// Shared request pipeline for the per-book AI parts (overview / characters / film):
// paywall gate → shared cache → live generation with the canonical book identity → cache write.
import { gateBook } from "./access.js";
import { canonicalBook, readCache, writeCache } from "./cache.js";
import { requireLive } from "./claude.js";
import { CACHE_PUBLIC, PRIVATE, json } from "./http.js";
import { enforce } from "./ratelimit.js";

/**
 * Runs one part. `generate({ title, author })` calls the model and returns the sanitized result
 * (cacheable, without per-deployment tokens); `finish(result)` adds tokens before sending;
 * `onCached(result)` runs after a fresh result was stored.
 */
export async function servePart(request, { part, book, key = book.id, generate, finish = (r) => r, onCached }) {
  const gate = await gateBook(request, book.id);
  const send = (result) => json(finish(result), { cache: gate.gated ? PRIVATE : CACHE_PUBLIC, headers: gate.headers });

  const cached = await readCache(part, book.lang, key);
  if (cached && typeof cached === "object") return send(cached);

  requireLive();
  enforce(request, "text");
  const canonical = await canonicalBook(book.id, book.lang);
  const identity = canonical
    ? { title: canonical.meta.title || book.title, author: canonical.meta.author || "" }
    : { title: book.title, author: book.author };
  const result = await generate(identity);
  if (canonical) {
    const stored = await writeCache(part, book.lang, key, result);
    if (stored && onCached) await onCached(result);
  }
  return send(result);
}
