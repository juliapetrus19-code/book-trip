// Access policy (contract §Access policy): FREE_BOOKS distinct books per subject, re-opening is free,
// subscribers are unlimited. The paywall is only active when billing is configured.
import { billingConfig, isSubscribed, planFor } from "./billing.js";
import { HttpError } from "./http.js";
import { ensureAnon, readSession, subject } from "./session.js";
import { getStore } from "./store.js";

const ANON_QUOTA_TTL = 400 * 24 * 3600; // anonymous sets outlive the 365-day cookie, then expire

export function paywallEnabled() {
  return billingConfig().enabled;
}

export function freeBooks() {
  const raw = process.env.FREE_BOOKS;
  if (raw == null || String(raw).trim() === "") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : 2;
}

/**
 * Who is asking: { session, aid, subject, setCookie }. With `createAnon` a visitor without a valid
 * bt_anon cookie gets a fresh aid (send `setCookie` back). subject is null only when signing is off.
 */
export function identify(request, { createAnon = true } = {}) {
  const session = readSession(request);
  const anon = createAnon ? ensureAnon(request) : null;
  const aid = anon ? anon.aid : null;
  return { session, aid, subject: subject(session, aid), setCookie: anon ? anon.setCookie : null };
}

export const quotaKey = (subj) => `quota:${subj}`;

/** { subscribed, sub, plan, opened: [ids] } for a subject (store errors → nothing opened, not subscribed). */
export async function accountState(ident) {
  if (!ident.subject) return { subscribed: false, sub: null, plan: null, opened: [] };
  const store = getStore();
  try {
    const [opened, rawSub] = await store.pipeline([
      ["SMEMBERS", quotaKey(ident.subject)],
      ["GET", ident.session ? `sub:${ident.session.uid}` : "sub:-"],
    ]);
    let sub = null;
    try { sub = rawSub ? JSON.parse(rawSub) : null; } catch { sub = null; }
    return { subscribed: isSubscribed(sub), sub, plan: sub ? planFor(sub.priceId) : null, opened: (opened || []).map(String).sort() };
  } catch (err) {
    console.error(`[access] state for ${ident.subject}: ${err.message}`);
    return { subscribed: false, sub: null, plan: null, opened: [] };
  }
}

/**
 * May `ident` open book `id`? Records the id when allowed.
 * → { allowed, freeLeft, subscribed, loggedIn }.
 * A store outage allows the request (logged): locking paying users out is worse than a few free opens.
 */
export async function checkAccess(ident, id) {
  const free = freeBooks();
  const loggedIn = Boolean(ident.session);
  if (!ident.subject) return { allowed: true, freeLeft: free, subscribed: false, loggedIn };
  const store = getStore();
  const key = quotaKey(ident.subject);
  const anon = !ident.session;
  try {
    const [member, count, rawSub] = await store.pipeline([
      ["SISMEMBER", key, id],
      ["SCARD", key],
      ["GET", ident.session ? `sub:${ident.session.uid}` : "sub:-"],
    ]);
    let sub = null;
    try { sub = rawSub ? JSON.parse(rawSub) : null; } catch { sub = null; }
    const subscribed = isSubscribed(sub);
    const left = (n) => Math.max(0, free - n);
    if (Number(member) === 1) return { allowed: true, freeLeft: left(Number(count)), subscribed, loggedIn };

    const added = await store.sadd(key, id);
    if (anon) await store.expire(key, ANON_QUOTA_TTL);
    const total = await store.scard(key);
    if (!paywallEnabled() || subscribed || total <= free) {
      return { allowed: true, freeLeft: left(total), subscribed, loggedIn };
    }
    // Over the limit: undo our own insert (two parallel opens cannot both slip through).
    if (added) await store.srem(key, id);
    return { allowed: false, freeLeft: 0, subscribed, loggedIn };
  } catch (err) {
    console.error(`[access] check ${ident.subject} ${id}: ${err.message} → allowing`);
    return { allowed: true, freeLeft: free, subscribed: false, loggedIn };
  }
}

export function paywallError(loggedIn, headers = {}) {
  return new HttpError("paywall", "The free books are used up — subscribe to open more books", {
    status: 402,
    headers,
    extra: { freeLeft: 0, loggedIn: Boolean(loggedIn) },
  });
}

/** Headers for a fresh anon cookie (or none). */
export function cookieHeaders(ident) {
  return ident && ident.setCookie ? { "set-cookie": ident.setCookie } : {};
}

/**
 * Hard gate for the AI parts of book `id`. Without a paywall → { gated: false }.
 * Otherwise counts the id for the visitor, throws 402 when not allowed, and returns the headers
 * (a new anon cookie) to add to the response; the caller must answer with private caching.
 */
export async function gateBook(request, id) {
  if (!paywallEnabled()) return { gated: false, headers: {} };
  const ident = identify(request);
  const headers = cookieHeaders(ident);
  const result = await checkAccess(ident, id);
  if (!result.allowed) throw paywallError(result.loggedIn, headers);
  return { gated: true, headers };
}

/** On login: the anonymous visitor's opened books join the user's set (never extra free books). */
export async function mergeAnonInto(uid, aid) {
  if (!aid) return;
  const userKey = quotaKey(`u:${uid}`);
  await getStore().sunionstore(userKey, userKey, quotaKey(`a:${aid}`));
}
