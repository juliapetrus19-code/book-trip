// GET /api/resolve?q=&lang= → identify the book behind a (possibly misspelled) query.
import { callJson, effortFor, requireLive } from "./_lib/claude.js";
import { CACHE_PUBLIC, CACHE_SHORT, json, langParam, queryParam, route, searchParams } from "./_lib/http.js";
import { RESOLVE_SYSTEM, userMessage } from "./_lib/prompts.js";
import { enforce } from "./_lib/ratelimit.js";
import { sanitizeResolve } from "./_lib/sanitize.js";
import { RESOLVE_SCHEMA } from "./_lib/schemas.js";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const q = queryParam(params);
  const lang = langParam(params);
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
  return json(result, { cache: result.found ? CACHE_PUBLIC : CACHE_SHORT });
});
