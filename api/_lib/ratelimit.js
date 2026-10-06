// Best-effort in-memory sliding-window rate limiter, per client IP and bucket.
// Each serverless instance keeps its own counters, so this is a soft guard against abuse —
// the real protection is the Vercel Firewall (see docs/DEPLOY.md) plus CDN caching.
import { HttpError, clientIp } from "./http.js";

const MIN = 60 * 1000;

export const BUCKETS = {
  text: { limit: 30, windowMs: 10 * MIN },      // resolve / overview / characters / film
  portrait: { limit: 10, windowMs: 10 * MIN },  // image generation
  video: { limit: 3, windowMs: 60 * MIN },      // starting a premium video (3 clips each)
  premium_fail: { limit: 10, windowMs: 60 * MIN }, // wrong premium codes (brute-force guard)
  poll: { limit: 300, windowMs: 10 * MIN },     // polling video operations
  file: { limit: 60, windowMs: 10 * MIN },      // streaming finished videos (incl. range requests)
};

const MAX_KEYS = 20000;
const hits = new Map(); // "bucket|ip" → ascending timestamps (ms)

function prune(list, now, windowMs) {
  let i = 0;
  while (i < list.length && list[i] <= now - windowMs) i++;
  if (i) list.splice(0, i);
}

function sweep(now) {
  const longest = Math.max(...Object.values(BUCKETS).map((b) => b.windowMs));
  for (const [key, list] of hits) {
    if (!list.length || list[list.length - 1] <= now - longest) hits.delete(key);
  }
  // Still too many distinct clients: drop the oldest-inserted keys.
  for (const key of hits.keys()) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(key);
  }
}

/**
 * Count one hit for `ip` in `bucket`. Returns { ok: true } or { ok: false, retryAfter } (seconds).
 * Over-limit attempts are not recorded, so a blocked client is released when its window slides.
 */
export function hit(bucket, ip, now = Date.now()) {
  const conf = BUCKETS[bucket];
  if (!conf) throw new Error(`Unknown rate-limit bucket "${bucket}"`);
  const key = `${bucket}|${ip}`;
  let list = hits.get(key);
  if (!list) {
    if (hits.size >= MAX_KEYS) sweep(now);
    list = [];
    hits.set(key, list);
  }
  prune(list, now, conf.windowMs);
  if (list.length >= conf.limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + conf.windowMs - now) / 1000)) };
  }
  list.push(now);
  return { ok: true };
}

/** Peek without counting (used to block brute force before comparing a premium code). */
export function isLimited(bucket, ip, now = Date.now()) {
  const conf = BUCKETS[bucket];
  const list = hits.get(`${bucket}|${ip}`);
  if (!list) return false;
  prune(list, now, conf.windowMs);
  return list.length >= conf.limit;
}

export function tooManyError(retryAfter) {
  return new HttpError("rate_limited", "Too many requests, please try again later", {
    headers: { "retry-after": String(retryAfter) },
  });
}

/** Throws HttpError("rate_limited") with Retry-After when the request's IP is over the bucket limit. */
export function enforce(request, bucket) {
  const result = hit(bucket, clientIp(request));
  if (!result.ok) throw tooManyError(result.retryAfter);
}

export function resetRateLimits() {
  hits.clear();
}
