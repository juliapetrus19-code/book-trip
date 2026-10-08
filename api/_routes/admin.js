// GET /api/admin (header x-admin-token: <ADMIN_TOKEN>) → waitlist top/recent, daily events (30 days),
// user and subscriber counts. 404 when ADMIN_TOKEN is unset, 403 for a wrong token.
import { isSubscribed } from "../_lib/billing.js";
import { HttpError, NO_STORE, clientIp, json, route } from "../_lib/http.js";
import { hit, isLimited, tooManyError } from "../_lib/ratelimit.js";
import { safeEqual } from "../_lib/sign.js";
import { getStore } from "../_lib/store.js";

const DAYS = 30;

export const GET = route(async (request) => {
  const token = (process.env.ADMIN_TOKEN || "").trim();
  if (!token) throw new HttpError("not_found", "Not found");
  const ip = clientIp(request);
  const blocked = isLimited("admin_fail", ip);
  if (blocked) throw tooManyError(blocked);
  if (!safeEqual((request.headers.get("x-admin-token") || "").trim(), token)) {
    hit("admin_fail", ip);
    throw new HttpError("forbidden", "Wrong admin token");
  }

  const store = getStore();
  const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  let results;
  try {
    results = await store.pipeline([
      ["ZREVRANGE", "waitlist:count", 0, 49, "WITHSCORES"],
      ["LRANGE", "waitlist", 0, 49],
      ["SCARD", "users"],
      ["SMEMBERS", "subs"],
      ...days.map((d) => ["HGETALL", `ev:${d}`]),
    ]);
  } catch (err) {
    console.error(`[admin] store error: ${err.message}`);
    throw new HttpError("upstream", "Store unavailable");
  }
  const [topRaw, recentRaw, users, subUids, ...evRaw] = results;

  const top = [];
  for (let i = 0; i + 1 < (topRaw || []).length; i += 2) top.push({ q: String(topRaw[i]), count: Number(topRaw[i + 1]) });
  const recent = (recentRaw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

  const events = {};
  days.forEach((d, i) => {
    const raw = evRaw[i];
    const obj = {};
    if (Array.isArray(raw)) for (let j = 0; j + 1 < raw.length; j += 2) obj[raw[j]] = Number(raw[j + 1]);
    else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) obj[k] = Number(v);
    if (Object.keys(obj).length) events[d] = obj;
  });

  let subscribers = 0;
  const uids = (subUids || []).map(String);
  for (let i = 0; i < uids.length; i += 100) {
    const subs = await store.mgetJson(uids.slice(i, i + 100).map((u) => `sub:${u}`));
    subscribers += subs.filter((s) => isSubscribed(s)).length;
  }

  return json({ waitlist: { top, recent }, events, users: Number(users) || 0, subscribers }, { cache: NO_STORE });
});
