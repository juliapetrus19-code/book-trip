// Identity cookies (contract §Identity): bt_session (logged-in user) and bt_anon (anonymous visitor),
// both sealed with api/_lib/sign.js. "subject" = u:<uid> when logged in, else a:<aid>.
import { createHash, randomBytes } from "node:crypto";
import { canSign, seal, unseal } from "./sign.js";

export const SESSION_COOKIE = "bt_session";
export const ANON_COOKIE = "bt_anon";
export const SESSION_TTL = 180 * 24 * 3600;
export const ANON_TTL = 365 * 24 * 3600;

const UID_RE = /^[0-9a-f]{16}$/;
export const EMAIL_RE = /^[^\s@"'<>()[\]\\,;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

/** Lowercased, trimmed e-mail or null when it is not a plausible address (≤ 254 chars). */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** uid = first 16 hex chars of sha256(lowercased e-mail). */
export function uidFor(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (request, name) => parseCookies(request.headers.get("cookie")).get(name) || null;

/** Secure everywhere except plain-http localhost (the dev server). */
export function isSecureContext(request) {
  const url = new URL(request.url);
  return !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

export function serializeCookie(request, name, value, maxAge) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isSecureContext(request)) parts.push("Secure");
  return parts.join("; ");
}

/** { uid, email } from a valid bt_session cookie, else null (also when signing is not configured). */
export function readSession(request) {
  if (!canSign()) return null;
  const data = unseal("session", cookie(request, SESSION_COOKIE));
  if (!data || !UID_RE.test(data.uid || "") || typeof data.email !== "string") return null;
  return { uid: data.uid, email: data.email };
}

/** aid from a valid bt_anon cookie, else null. */
export function readAnon(request) {
  if (!canSign()) return null;
  const data = unseal("anon", cookie(request, ANON_COOKIE));
  return data && UID_RE.test(data.aid || "") ? data.aid : null;
}

/** The visitor's aid; when missing a new one plus the Set-Cookie value to send. Null when signing is off. */
export function ensureAnon(request) {
  const aid = readAnon(request);
  if (aid) return { aid, setCookie: null };
  if (!canSign()) return null;
  const fresh = randomBytes(8).toString("hex");
  return { aid: fresh, setCookie: serializeCookie(request, ANON_COOKIE, seal("anon", { aid: fresh }, ANON_TTL), ANON_TTL) };
}

export function sessionCookie(request, email) {
  const value = seal("session", { uid: uidFor(email), email }, SESSION_TTL);
  return serializeCookie(request, SESSION_COOKIE, value, SESSION_TTL);
}

export function clearSessionCookie(request) {
  return serializeCookie(request, SESSION_COOKIE, "", 0);
}

/** "u:<uid>" when logged in, else "a:<aid>", else null. */
export function subject(session, aid) {
  if (session) return `u:${session.uid}`;
  return aid ? `a:${aid}` : null;
}

/** Same-origin path only (`/x…`, never `//host` or `/\host`); anything else → "/". */
export function safeNext(value) {
  if (typeof value !== "string" || value.length > 500) return "/";
  const path = value.replace(/[\u0000-\u001f\u007f\s]/g, "");
  return path === "/" || /^\/[^/\\]/.test(path) ? path : "/";
}

/** `next` with login=<status> appended to its query (before any #fragment). */
export function withLoginParam(next, status) {
  const hashAt = next.indexOf("#");
  const path = hashAt >= 0 ? next.slice(0, hashAt) : next;
  const hash = hashAt >= 0 ? next.slice(hashAt) : "";
  return `${path}${path.includes("?") ? "&" : "?"}login=${status}${hash}`;
}
