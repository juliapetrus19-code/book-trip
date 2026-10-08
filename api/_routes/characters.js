// GET /api/characters?id=&title=&author=&lang= → { characters: [Character + portraitToken] }.
// Paywalled per book (402) when billing is on; cached in the store by id + lang (tokens are added
// on every answer, so rotating SIGNING_SECRET never leaves stale tokens in the cache).
import { callJson, effortFor } from "../_lib/claude.js";
import { bookParams, route, searchParams } from "../_lib/http.js";
import { servePart } from "../_lib/book-input.js";
import { CHARACTERS_SYSTEM, userMessage } from "../_lib/prompts.js";
import { sanitizeCharacters } from "../_lib/sanitize.js";
import { CHARACTERS_SCHEMA } from "../_lib/schemas.js";
import { portraitToken } from "../_lib/sign.js";

export const GET = route(async (request) => {
  const book = bookParams(searchParams(request));
  return servePart(request, {
    part: "characters",
    book,
    async generate({ title, author }) {
      const data = await callJson({
        system: CHARACTERS_SYSTEM,
        user: userMessage(book.lang, { id: book.id, title, author }),
        schema: CHARACTERS_SCHEMA,
        effort: effortFor("characters"),
        maxTokens: 20000,
        label: `characters ${book.id}/${book.lang}`,
      });
      return { characters: sanitizeCharacters(data).characters };
    },
    // The token lets /api/portrait render exactly this prompt for exactly this book + character.
    finish: ({ characters }) => ({
      characters: (Array.isArray(characters) ? characters : []).map((c) => ({ ...c, portraitToken: portraitToken(book.id, c.id, c.portraitPrompt) })),
    }),
  });
});
