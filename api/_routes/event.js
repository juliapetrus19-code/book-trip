// POST /api/event { name, id? } → 204. Anonymous funnel counters: HINCRBY ev:<yyyy-mm-dd> name 1.
// Only whitelisted names; over-limit and store failures are dropped silently (never break the page).
import { HttpError, ID_RE, clientIp, readJson, route } from "../_lib/http.js";
import { hit } from "../_lib/ratelimit.js";
import { soft } from "../_lib/store.js";

export const EVENTS = new Set(["search", "book_open", "paywall_shown", "checkout_start", "signup_start", "signup_done", "waitlist_join", "install", "quiz_done"]);
const KEEP_DAYS = 400;

export const dayKey = (now = new Date()) => `ev:${now.toISOString().slice(0, 10)}`;

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const POST = route(async (request) => {
  const body = await readJson(request, 1000);
  if (typeof body.name !== "string" || !EVENTS.has(body.name)) throw new HttpError("bad_request", "Unknown event");
  if (body.id !== undefined && body.id !== null && (typeof body.id !== "string" || !ID_RE.test(body.id))) {
    throw new HttpError("bad_request", 'Field "id" must match [a-z0-9-]{1,100}');
  }
  if (!hit("event", clientIp(request)).ok) return noContent();
  const key = dayKey();
  await soft("event", (s) => s.pipeline([["HINCRBY", key, body.name, 1], ["EXPIRE", key, KEEP_DAYS * 24 * 3600]]));
  return noContent();
});
