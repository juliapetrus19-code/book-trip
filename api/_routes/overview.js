// GET /api/overview?id=&title=&author=&lang= → { summary, themes, terms, similar }.
// Paywalled per book (402) when billing is on; cached in the store by id + lang.
import { addLiveBook } from "../_lib/cache.js";
import { callJson, effortFor } from "../_lib/claude.js";
import { bookParams, route, searchParams } from "../_lib/http.js";
import { servePart } from "../_lib/book-input.js";
import { OVERVIEW_SYSTEM, userMessage } from "../_lib/prompts.js";
import { sanitizeOverview } from "../_lib/sanitize.js";
import { OVERVIEW_SCHEMA } from "../_lib/schemas.js";

export const GET = route(async (request) => {
  const book = bookParams(searchParams(request));
  return servePart(request, {
    part: "overview",
    book,
    async generate({ title, author }) {
      const data = await callJson({
        system: OVERVIEW_SYSTEM,
        user: userMessage(book.lang, { id: book.id, title, author }),
        schema: OVERVIEW_SCHEMA,
        effort: effortFor("overview"),
        maxTokens: 16000,
        label: `overview ${book.id}/${book.lang}`,
      });
      return sanitizeOverview(data, { title });
    },
    onCached: () => addLiveBook(book.id),
  });
});
