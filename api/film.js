// GET /api/film?id=&title=&author=&lang=&cast=id:Name,… → Film + videoToken.
import { callJson, effortFor, requireLive } from "./_lib/claude.js";
import { CACHE_PUBLIC, bookParams, castParam, json, route, searchParams } from "./_lib/http.js";
import { FILM_SYSTEM, userMessage } from "./_lib/prompts.js";
import { enforce } from "./_lib/ratelimit.js";
import { sanitizeFilm } from "./_lib/sanitize.js";
import { FILM_SCHEMA } from "./_lib/schemas.js";
import { videoToken } from "./_lib/sign.js";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const book = bookParams(params);
  const cast = castParam(params);
  requireLive();
  enforce(request, "text");
  const data = await callJson({
    system: FILM_SYSTEM,
    user: userMessage(book.lang, { id: book.id, title: book.title, author: book.author, cast }),
    schema: FILM_SCHEMA,
    effort: effortFor("film"),
    maxTokens: 16000,
    label: `film ${book.id}/${book.lang}`,
  });
  const film = sanitizeFilm(data, cast);
  // The token lets POST /api/video render exactly these three prompts for this book (premium).
  film.videoToken = videoToken(book.id, film.videoPrompts);
  return json(film, { cache: CACHE_PUBLIC });
});
