// Tokens: HMAC-SHA256 signatures for prompts we generated (portraitToken / videoToken) and
// AES-256-GCM sealed, expiring references for video operations and files (opaque to the client).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

const sha256 = (text) => createHash("sha256").update(text).digest();

/** Secret material: SIGNING_SECRET, else derived from the API keys (rotating a key invalidates tokens). */
function masterSecret() {
  const e = process.env;
  if (e.SIGNING_SECRET) return "s:" + e.SIGNING_SECRET;
  if (e.ANTHROPIC_API_KEY) return "a:" + sha256(e.ANTHROPIC_API_KEY).toString("hex");
  if (e.GEMINI_API_KEY) return "g:" + sha256(e.GEMINI_API_KEY).toString("hex");
  return null;
}

function key(label) {
  const secret = masterSecret();
  if (!secret) throw new HttpError("not_configured", "Signing is not configured (set SIGNING_SECRET)");
  return sha256(`booktrip:${label}:v1|${secret}`);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** HMAC over a purpose label + an ordered list of strings (unambiguous JSON encoding). */
export function sign(purpose, parts) {
  return b64url(createHmac("sha256", key("hmac")).update(JSON.stringify([purpose, ...parts.map(String)])).digest());
}

export function safeEqual(a, b) {
  // Hash first so differing lengths do not leak through timing.
  return timingSafeEqual(sha256(String(a ?? "")), sha256(String(b ?? "")));
}

export function verify(purpose, parts, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return safeEqual(sign(purpose, parts), token);
}

/** Encrypt + authenticate `payload` (JSON) for `purpose`, valid for `ttlSec`. */
export function seal(purpose, payload, ttlSec, now = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("seal"), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = JSON.stringify({ p: payload, e: Math.floor(now / 1000) + ttlSec });
  const enc = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

/** Returns the payload, or null when the token is malformed, forged, for another purpose or expired. */
export function unseal(purpose, token, now = Date.now()) {
  if (typeof token !== "string" || token.length < 40 || token.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key("seal"), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    if (!body || typeof body.e !== "number" || body.e * 1000 < now) return null;
    return body.p;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  }
}

export const portraitToken = (bookId, charId, prompt) => sign("portrait", [bookId, charId, prompt]);
export const videoToken = (bookId, prompts) => sign("video", [bookId, ...prompts]);
