// GET /api/characters?id=&title=&author=&lang= → { characters: [Character + portraitToken] }.
import { callJson, effortFor, requireLive } from "./_lib/claude.js";
import { CACHE_PUBLIC, bookParams, json, route, searchParams } from "./_lib/http.js";
import { CHARACTERS_SYSTEM, userMessage } from "./_lib/prompts.js";
import { enforce } from "./_lib/ratelimit.js";
import { sanitizeCharacters } from "./_lib/sanitize.js";
import { CHARACTERS_SCHEMA } from "./_lib/schemas.js";
import { portraitToken } from "./_lib/sign.js";

export const GET = route(async (request) => {
  const book = bookParams(searchParams(request));
  requireLive();
  enforce(request, "text");
  const data = await callJson({
    system: CHARACTERS_SYSTEM,
    user: userMessage(book.lang, { id: book.id, title: book.title, author: book.author }),
    schema: CHARACTERS_SCHEMA,
    effort: effortFor("characters"),
    maxTokens: 20000,
    label: `characters ${book.id}/${book.lang}`,
  });
  const { characters } = sanitizeCharacters(data);
  // The token lets /api/portrait render exactly this prompt for exactly this book + character.
  for (const c of characters) c.portraitToken = portraitToken(book.id, c.id, c.portraitPrompt);
  return json({ characters }, { cache: CACHE_PUBLIC });
});
