// GET /api/portrait?book=&char=&lang=&prompt=&token=  → AI portrait (image bytes) for a live character.
// GET /api/portrait?demo=<bookId>&char=<charId>       → the same for a bundled demo book (prompt from data file).
// Live-book portraits are paywalled per book (402) when billing is on and then cached only by the
// visitor's browser (private); demo portraits are a fixed public set and stay CDN-cacheable.
import { gateBook } from "./_lib/access.js";
import { demoPortraitPrompt } from "./_lib/demo.js";
import { PORTRAIT_STYLE, generateImage, isConfigured } from "./_lib/gemini.js";
import { CACHE_IMMUTABLE, HttpError, cleanText, idParam, route, searchParams } from "./_lib/http.js";
import { enforce } from "./_lib/ratelimit.js";
import { verify } from "./_lib/sign.js";

// Demo prompts can change when the data files are edited, so their images are cached for less time.
const CACHE_DEMO = "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400";
// Paywalled images: never shared by the CDN, but the browser may keep them (regenerating costs money).
const CACHE_PRIVATE_IMAGE = "private, max-age=31536000, immutable";
const MAX_PROMPT = 600;

export const GET = route(async (request) => {
  const params = searchParams(request);
  if (!isConfigured()) throw new HttpError("not_configured", "Portraits are not configured (GEMINI_API_KEY is missing)");
  let prompt, cache, bucket;
  let extraHeaders = {};

  if (params.has("demo")) {
    const bookId = idParam(params, "demo");
    const charId = idParam(params, "char");
    prompt = await demoPortraitPrompt(bookId, charId);
    cache = CACHE_DEMO;
    bucket = "portrait_demo";
  } else {
    const bookId = idParam(params, "book");
    const charId = idParam(params, "char");
    // Verify against the exact string we signed in /api/characters (no normalisation first).
    prompt = params.get("prompt") || "";
    if (!prompt.trim()) throw new HttpError("bad_request", 'Missing parameter "prompt"');
    if (prompt.length > MAX_PROMPT) throw new HttpError("bad_request", `Parameter "prompt" is too long (max ${MAX_PROMPT} characters)`);
    if (!verify("portrait", [bookId, charId, prompt], params.get("token"))) {
      throw new HttpError("forbidden", "Invalid portrait token");
    }
    const gate = await gateBook(request, bookId);
    cache = gate.gated ? CACHE_PRIVATE_IMAGE : CACHE_IMMUTABLE;
    extraHeaders = gate.headers;
    bucket = "portrait";
  }

  enforce(request, bucket);

  const image = await generateImage(`${PORTRAIT_STYLE}. The character: ${cleanText(prompt)}`);
  return new Response(image.bytes, {
    status: 200,
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.bytes.length),
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      ...extraHeaders,
    },
  });
});
