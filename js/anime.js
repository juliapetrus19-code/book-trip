// BookTrip — anime look: image URLs for character portraits and film key frames, plus a small loader.
//
// Providers (chosen by the server in /api/health → anime.provider):
//   "cloudflare"   — catalogue (demo) books are drawn by /api/anime on Cloudflare Workers AI (free daily quota) and
//                    cached by the CDN; AI-found books still use Pollinations in the visitor's browser.
//   "pollinations" — every image is drawn by image.pollinations.ai straight from the browser (free, no key; slow).
//   "off"          — no anime: the 3D voxel figures and the 3D film are used.
// Whatever happens, the caller keeps the 3D version until an anime image has really loaded, so a slow or failed
// image never leaves a hole on the page.

import { ANIME_SIZE, portraitPromptFor, scenePromptFor, seedFor } from "./anime-prompts.js";
import { store } from "./util.js";

const PREF_KEY = "bt-look"; // "anime" | "3d" — the visitor's own choice on the book page
const POLL = "https://image.pollinations.ai/prompt/";

let provider = "pollinations";

/** Called by the app once /api/health is known. */
export function setAnimeProvider(p) {
  provider = p === "cloudflare" || p === "off" ? p : "pollinations";
}
export const animeProvider = () => provider;

/** Is the anime look active (server allows it and the visitor did not switch to 3D)? */
export function animeOn() {
  if (provider === "off") return false;
  let pref = null;
  try { pref = store.get(PREF_KEY); } catch { /* storage blocked */ }
  return pref !== "3d";
}
export function setAnimePreference(on) {
  try { store.set(PREF_KEY, on ? "anime" : "3d"); } catch { /* ignore */ }
}
export const animeAvailable = () => provider !== "off";

const isDemo = (book) => book && book.source !== "live";

function pollinationsUrl(prompt, { w, h }, seed) {
  return `${POLL}${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&model=flux&nologo=true&referrer=booktrip`;
}

/**
 * Image URLs of a character portrait, best first (the loader tries them in order), or null when anime is off.
 * Catalogue books ask our server first (Cloudflare) and fall back to Pollinations.
 */
export function animePortraitUrl(book, character) {
  if (!animeOn() || !book || !character?.id) return null;
  const poll = pollinationsUrl(portraitPromptFor(englishMeta(book), character), ANIME_SIZE.portrait, seedFor(`${book.id}/${character.id}`));
  if (provider === "cloudflare" && isDemo(book)) {
    return [`/api/anime?demo=${encodeURIComponent(book.id)}&char=${encodeURIComponent(character.id)}`, poll];
  }
  return [poll];
}

/**
 * Image URL of key frame `frame` (0 wide, 1 closer) of scene `index`. `extra.narrationEn` improves the picture
 * (see englishNarrations()).
 */
export function animeFrameUrl(book, index, frame, extra = {}) {
  if (!animeOn() || !book) return null;
  const scene = book.film?.scenes?.[index];
  if (!scene) return null;
  const cast = new Map((book.characters || []).map((c) => [c.id, c]));
  const prompt = scenePromptFor(englishMeta(book), scene, cast, { frame, narrationEn: extra.narrationEn || "" });
  const poll = pollinationsUrl(prompt, ANIME_SIZE.frame, seedFor(`${book.id}/scene${index}/${frame}`));
  if (provider === "cloudflare" && isDemo(book)) {
    return [`/api/anime?demo=${encodeURIComponent(book.id)}&scene=${index}&frame=${frame}`, poll];
  }
  return [poll];
}

/** Titles go into the prompt: prefer the original (usually Latin-script) title the model knows best. */
function englishMeta(book) {
  return { title: book.title || "", originalTitle: book.originalTitle || "" };
}

/** English scene narrations of a catalogue book (the BookView only carries the current language). */
const enCache = new Map();
export function englishNarrations(book) {
  if (!isDemo(book) || !book?.id) return Promise.resolve([]);
  if (book.lang === "en") return Promise.resolve((book.film?.scenes || []).map((s) => s.narration || ""));
  if (!enCache.has(book.id)) {
    enCache.set(book.id, fetch(`/data/books/${encodeURIComponent(book.id)}.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => (raw?.i18n?.en?.film?.scenes || []).map((s) => (typeof s?.narration === "string" ? s.narration : "")))
      .catch(() => []));
  }
  return enCache.get(book.id);
}

// ---------------------------------------------------------------------------------------------
// Loader: Pollinations throttles anonymous visitors, so its images are fetched two at a time.

const queue = [];
let running = 0;
const LIMIT = () => (provider === "cloudflare" ? 4 : 2);

function pump() {
  while (running < LIMIT() && queue.length) {
    const job = queue.shift();
    if (job.cancelled) continue;
    running++;
    job.run().finally(() => { running--; pump(); });
  }
}

/**
 * Load the first image of `urls` (a URL or a list, best first) that works; resolves to that URL once decoded,
 * rejects when all fail / time out / are aborted. `opts.priority` jumps the queue (the frame about to be shown).
 */
export async function loadAnimeImage(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  let last = new Error("no url");
  for (const url of list) {
    try { return await loadOne(url, opts); } catch (err) {
      last = err;
      if (opts.signal?.aborted) break;
    }
  }
  throw last;
}

function loadOne(url, { timeout = 90000, signal, priority = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!url) { reject(new Error("no url")); return; }
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const job = { cancelled: false };
    const onAbort = () => { job.cancelled = true; job.img && (job.img.src = ""); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    job.run = () => new Promise((done) => {
      const img = new Image();
      job.img = img;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      let finished = false;
      const end = (ok, err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        done();
        if (ok) resolve(url); else reject(err);
      };
      const timer = setTimeout(() => { img.src = ""; end(false, new Error("timeout")); }, timeout);
      img.onload = () => {
        // Tiny images are error placeholders (rate limit / blocked prompt), not real pictures.
        if (img.naturalWidth < 64 || img.naturalHeight < 64) end(false, new Error("placeholder"));
        else (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => end(true));
      };
      img.onerror = () => end(false, new Error("load failed"));
      img.src = url;
    });
    if (priority) queue.unshift(job); else queue.push(job);
    pump();
  });
}
