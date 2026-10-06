// GET /api/overview?id=&title=&author=&lang= → { summary, themes, terms, similar }.
import { callJson, effortFor, requireLive } from "./_lib/claude.js";
import { CACHE_PUBLIC, bookParams, json, route, searchParams } from "./_lib/http.js";
import { OVERVIEW_SYSTEM, userMessage } from "./_lib/prompts.js";
import { enforce } from "./_lib/ratelimit.js";
import { sanitizeOverview } from "./_lib/sanitize.js";
import { OVERVIEW_SCHEMA } from "./_lib/schemas.js";

export const GET = route(async (request) => {
  const book = bookParams(searchParams(request));
  requireLive();
  enforce(request, "text");
  const data = await callJson({
    system: OVERVIEW_SYSTEM,
    user: userMessage(book.lang, { id: book.id, title: book.title, author: book.author }),
    schema: OVERVIEW_SCHEMA,
    effort: effortFor("overview"),
    maxTokens: 16000,
    label: `overview ${book.id}/${book.lang}`,
  });
  return json(sanitizeOverview(data, { title: book.title }), { cache: CACHE_PUBLIC });
});
