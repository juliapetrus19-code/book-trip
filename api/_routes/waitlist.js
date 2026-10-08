// POST /api/waitlist { q, contact, lang } → { ok: true }. "Tell me when this book is available":
// stored in the `waitlist` list (newest 5000) and counted per query in the `waitlist:count` ZSET.
import { normalizeQuery } from "../_lib/cache.js";
import { LANGS } from "../_lib/enums.js";
import { HttpError, NO_STORE, cleanText, json, readJson, route } from "../_lib/http.js";
import { enforce } from "../_lib/ratelimit.js";
import { normalizeEmail } from "../_lib/session.js";
import { getStore } from "../_lib/store.js";

const MAX_ITEMS = 5000;

/** "@handle" / "handle" (Telegram-style, 5–32 [A-Za-z0-9_]) or an e-mail, ≤ 120 chars; else null. */
export function normalizeContact(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > 120) return null;
  const handle = /^@?([A-Za-z0-9_]{5,32})$/.exec(v);
  if (handle) return "@" + handle[1];
  return normalizeEmail(v);
}

/** Validated { q, contact, lang }; throws bad_request. */
export function waitlistEntry(body) {
  const q = cleanText(typeof body.q === "string" ? body.q : "");
  if (!q || q.length > 200) throw new HttpError("bad_request", 'Field "q" must be 1–200 characters');
  const contact = normalizeContact(body.contact);
  if (!contact) throw new HttpError("bad_request", 'Field "contact" must be a Telegram @username or an e-mail');
  const lang = LANGS.includes(body.lang) ? body.lang : "uk";
  return { q, contact, lang };
}

export const POST = route(async (request) => {
  enforce(request, "waitlist");
  const entry = waitlistEntry(await readJson(request, 2000));
  const store = getStore();
  try {
    await store.pipeline([
      ["LPUSH", "waitlist", JSON.stringify({ ...entry, at: new Date().toISOString() })],
      ["LTRIM", "waitlist", 0, MAX_ITEMS - 1],
      ["ZINCRBY", "waitlist:count", 1, normalizeQuery(entry.q)],
    ]);
  } catch (err) {
    console.error(`[waitlist] store error: ${err.message}`);
    throw new HttpError("upstream", "Could not save, please try again");
  }
  return json({ ok: true }, { cache: NO_STORE });
});
