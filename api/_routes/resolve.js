// GET /api/resolve?q=&lang= → identify the book behind a (possibly misspelled) query.
// Answers are cached in the store by normalised query (not-found answers for one day), and every
// found book is remembered as canonical (cache:book:<lang>:<id>) for the other parts and SEO pages.
import { NOT_FOUND_TTL, normalizeQuery, readCache, rememberBook, writeCache } from "../_lib/cache.js";
import { callJson, effortFor, requireLive } from "../_lib/claude.js";
import { CACHE_PUBLIC, CACHE_SHORT, json, langParam, queryParam, route, searchParams } from "../_lib/http.js";
import { RESOLVE_SYSTEM, userMessage } from "../_lib/prompts.js";
import { enforce } from "../_lib/ratelimit.js";
import { sanitizeResolve } from "../_lib/sanitize.js";
import { RESOLVE_SCHEMA } from "../_lib/schemas.js";

const respond = (result) => json(result, { cache: result.found ? CACHE_PUBLIC : CACHE_SHORT });

export const GET = route(async (request) => {
  const params = searchParams(request);
  const q = queryParam(params);
  const lang = langParam(params);
  const key = normalizeQuery(q);

  const cached = await readCache("resolve", lang, key);
  if (cached && typeof cached.found === "boolean") return respond(cached);

  requireLive();
  enforce(request, "text");
  const data = await callJson({
    system: RESOLVE_SYSTEM,
    user: userMessage(lang, { query: q }),
    schema: RESOLVE_SCHEMA,
    effort: effortFor("resolve"),
    maxTokens: 8000,
    label: "resolve",
  });
  const result = sanitizeResolve(data);
  await writeCache("resolve", lang, key, result, { ttl: result.found ? undefined : NOT_FOUND_TTL });
  if (result.found) await rememberBook(lang, result);
  return respond(result);
});
