// GET /api/film?id=&title=&author=&lang=&cast=id:Name,… → Film + videoToken.
// Paywalled per book (402) when billing is on; cached by id + lang + a hash of the cast (the film's
// scenes reference the cast ids, so a different cast is a different film).
import { hashKey } from "./_lib/cache.js";
import { callJson, effortFor } from "./_lib/claude.js";
import { bookParams, castParam, route, searchParams } from "./_lib/http.js";
import { servePart } from "./_lib/book-input.js";
import { FILM_SYSTEM, userMessage } from "./_lib/prompts.js";
import { sanitizeFilm } from "./_lib/sanitize.js";
import { FILM_SCHEMA } from "./_lib/schemas.js";
import { videoToken } from "./_lib/sign.js";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const book = bookParams(params);
  const cast = castParam(params);
  return servePart(request, {
    part: "film",
    book,
    key: `${book.id}:${hashKey(cast)}`,
    async generate({ title, author }) {
      const data = await callJson({
        system: FILM_SYSTEM,
        user: userMessage(book.lang, { id: book.id, title, author, cast }),
        schema: FILM_SCHEMA,
        effort: effortFor("film"),
        maxTokens: 16000,
        label: `film ${book.id}/${book.lang}`,
      });
      return sanitizeFilm(data, cast);
    },
    // The token lets POST /api/video render exactly these three prompts for this book (premium).
    finish: (film) => ({ ...film, videoToken: videoToken(book.id, Array.isArray(film.videoPrompts) ? film.videoPrompts : []) }),
  });
});
