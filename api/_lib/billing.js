// Paddle Billing: configuration from env, subscription records (sub:<uid>), webhook signatures.
import { createHmac } from "node:crypto";
import { canSign, safeEqual } from "./sign.js";
import { getStore } from "./store.js";

const PRICE_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SUBSCRIBED = new Set(["active", "trialing", "past_due"]);
export const SIGNATURE_TOLERANCE_SEC = 300;

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Billing is "enabled" when the client token, at least one price and the webhook secret are set
 * (contract) — and sessions can be signed, since checkout needs a logged-in user.
 */
export function billingConfig() {
  const e = process.env;
  const env = clean(e.PADDLE_ENV) === "production" ? "production" : "sandbox";
  const clientToken = clean(e.PADDLE_CLIENT_TOKEN);
  const prices = [];
  const month = clean(e.PADDLE_PRICE_MONTH);
  const year = clean(e.PADDLE_PRICE_YEAR);
  if (PRICE_RE.test(month)) prices.push({ id: month, period: "month", label: clean(e.PRICE_LABEL_MONTH).slice(0, 40) || "$4.99" });
  if (PRICE_RE.test(year)) prices.push({ id: year, period: "year", label: clean(e.PRICE_LABEL_YEAR).slice(0, 40) || "$29" });
  const webhookSecret = clean(e.PADDLE_WEBHOOK_SECRET);
  const enabled = Boolean(clientToken && prices.length && webhookSecret && canSign());
  return { enabled, env, clientToken, prices, webhookSecret, apiKey: clean(e.PADDLE_API_KEY) };
}

/** The public part for /api/health. */
export function publicBilling() {
  const b = billingConfig();
  return { enabled: b.enabled, env: b.env, clientToken: b.enabled ? b.clientToken : null, prices: b.enabled ? b.prices : [] };
}

export function paddleApiBase(env = billingConfig().env) {
  return env === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

/** "month" | "year" | null for a Paddle price id. */
export function planFor(priceId) {
  const p = billingConfig().prices.find((x) => x.id === priceId);
  return p ? p.period : null;
}

/** subscribed = active|trialing|past_due, or canceled with a paid period that has not ended yet. */
export function isSubscribed(sub, now = Date.now()) {
  if (!sub || typeof sub !== "object") return false;
  if (SUBSCRIBED.has(sub.status)) return true;
  if (sub.status === "canceled" && sub.endsAt) {
    const end = Date.parse(sub.endsAt);
    return Number.isFinite(end) && end > now;
  }
  return false;
}

export async function readSub(uid) {
  return getStore().getJson(`sub:${uid}`);
}

/** Parse `ts=<unix>;h1=<hex>[;h1=<hex>…]` → { ts, h1: [] } or null. */
export function parseSignatureHeader(header) {
  if (typeof header !== "string" || header.length > 1000) return null;
  let ts = null;
  const h1 = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "ts" && /^\d{1,12}$/.test(v)) ts = Number(v);
    else if (k === "h1" && /^[0-9a-f]{64}$/i.test(v)) h1.push(v.toLowerCase());
  }
  return ts !== null && h1.length ? { ts, h1 } : null;
}

export function paddleSignature(secret, ts, rawBody) {
  return createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
}

/** HMAC-SHA256(secret, `${ts}:${rawBody}`) must equal an h1 (constant time) and |now − ts| ≤ 300 s. */
export function verifyPaddleSignature(header, rawBody, secret, now = Date.now()) {
  if (!secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(Math.floor(now / 1000) - parsed.ts) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = paddleSignature(secret, parsed.ts, rawBody);
  let ok = false;
  for (const h of parsed.h1) ok = safeEqual(expected, h) || ok;
  return ok;
}
