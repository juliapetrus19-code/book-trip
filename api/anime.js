// GET /api/anime?demo=<bookId>&char=<charId>              → anime portrait of a catalogue character
// GET /api/anime?demo=<bookId>&scene=<n>&frame=<0|1>       → anime key frame of a catalogue film scene
// Drawn by Cloudflare Workers AI (FLUX.1 schnell) on the account's free daily allowance and cached by the CDN.
// Prompts are built here from the bundled data files (js/anime-prompts.js), never taken from the client.
// Not configured (no CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) → 503; the client then draws the picture
// with Pollinations in the browser instead.
import { ANIME_SIZE, portraitPromptFor, scenePromptFor, seedFor } from "../js/anime-prompts.js";
import { loadDemoBook } from "./_lib/demo.js";
import { httpFetch } from "./_lib/fetch.js";
import { HttpError, idParam, route, searchParams } from "./_lib/http.js";
import { enforce } from "./_lib/ratelimit.js";
import { soft } from "./_lib/store.js";

const MODEL = "@cf/black-forest-labs/flux-1-schnell";
// Pictures only change when the data file changes: a month at the CDN, a week in the browser.
const CACHE = "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=604800";
const DAILY_CAP = () => Math.max(1, Number(process.env.ANIME_DAILY_CAP) || 1500);

export function animeConfigured() {
  const e = process.env;
  return Boolean(e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_API_TOKEN);
}

/** Build the prompt + seed for a demo request, or throw not_found / bad_request. */
export async function demoAnimeJob(params) {
  const bookId = idParam(params, "demo");
  const book = await loadDemoBook(bookId);
  if (!book) throw new HttpError("not_found", "Unknown demo book");
  const en = book.i18n?.en || {};
  const meta = { title: en.title || bookId, originalTitle: en.originalTitle || "" };
  if (params.has("char")) {
    const charId = idParam(params, "char");
    const ch = (book.characters || []).find((c) => c && c.id === charId);
    if (!ch) throw new HttpError("not_found", "Unknown character");
    const named = { ...ch, name: en.characters?.[charId]?.name || charId };
    return { prompt: portraitPromptFor(meta, named), seed: seedFor(`${bookId}/${charId}`), size: ANIME_SIZE.portrait };
  }
  const index = Number(params.get("scene"));
  const frame = params.get("frame") === "1" ? 1 : 0;
  const scene = Number.isInteger(index) ? book.film?.scenes?.[index] : null;
  if (!scene) throw new HttpError("not_found", "Unknown scene");
  const cast = new Map((book.characters || []).map((c) => [c.id, c]));
  const narrationEn = en.film?.scenes?.[index]?.narration || "";
  return {
    prompt: scenePromptFor(meta, scene, cast, { frame, narrationEn }),
    seed: seedFor(`${bookId}/scene${index}/${frame}`),
    size: ANIME_SIZE.frame,
  };
}

async function drawWithCloudflare({ prompt, seed }) {
  const e = process.env;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(e.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${MODEL}`;
  let res;
  try {
    res = await httpFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 6, seed }),
    }, 60000);
  } catch (err) {
    throw new HttpError("upstream", `Image service unreachable (${err && err.name === "TimeoutError" ? "timeout" : "network"})`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data?.success || typeof data?.result?.image !== "string") {
    const why = data?.errors?.[0]?.message || `HTTP ${res.status}`;
    console.error(`[anime] cloudflare failed: ${why}`);
    throw new HttpError(res.status === 429 ? "rate_limited" : "upstream", "Image service failed");
  }
  return Buffer.from(data.result.image, "base64");
}

export const GET = route(async (request) => {
  const params = searchParams(request);
  if (!animeConfigured()) throw new HttpError("not_configured", "Anime images are not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)");
  if (!params.has("demo")) throw new HttpError("bad_request", 'Parameter "demo" is required');
  const job = await demoAnimeJob(params);
  enforce(request, "portrait_demo");

  // A global daily cap keeps us inside Cloudflare's free allowance (cached pictures do not count).
  const day = new Date().toISOString().slice(0, 10);
  const used = await soft("anime cap", async (s) => {
    const n = await s.incr(`anime:${day}`);
    if (n === 1) await s.expire(`anime:${day}`, 2 * 86400);
    return n;
  }, 0);
  if (used > DAILY_CAP()) throw new HttpError("rate_limited", "Daily image allowance used up", { headers: { "retry-after": "3600" } });

  const bytes = await drawWithCloudflare(job);
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": png ? "image/png" : "image/jpeg",
      "content-length": String(bytes.length),
      "cache-control": CACHE,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
});
