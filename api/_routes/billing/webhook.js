// POST /api/billing/webhook — Paddle Billing notifications.
// Paddle-Signature: ts=<unix>;h1=<hex> = HMAC-SHA256(PADDLE_WEBHOOK_SECRET, `${ts}:${rawBody}`), ±300 s.
// subscription.* events write sub:<uid> (uid from data.custom_data.uid, set by /api/billing/checkout).
// Any validly signed event gets 200 (ignored ones too), so Paddle does not retry it.
import { billingConfig, verifyPaddleSignature } from "../../_lib/billing.js";
import { HttpError, NO_STORE, json, route } from "../../_lib/http.js";
import { getStore } from "../../_lib/store.js";

export const HANDLED = new Set([
  "subscription.created", "subscription.updated", "subscription.activated", "subscription.canceled",
  "subscription.past_due", "subscription.paused", "subscription.resumed",
]);
const MAX_BODY = 256 * 1024;
const UID_RE = /^[0-9a-f]{16}$/;
const str = (v, max = 120) => (typeof v === "string" && v.length <= max ? v : null);

/** The sub:<uid> record for a subscription event's `data`. */
export function subscriptionRecord(data) {
  const item = Array.isArray(data.items) ? data.items[0] : null;
  const endsAt = (data.current_billing_period && str(data.current_billing_period.ends_at, 40))
    || (data.scheduled_change && str(data.scheduled_change.effective_at, 40))
    || null;
  return {
    status: str(data.status, 40) || "unknown",
    id: str(data.id),
    customerId: str(data.customer_id),
    priceId: item && item.price ? str(item.price.id) : null,
    endsAt,
  };
}

const ok = (extra = {}) => json({ ok: true, ...extra }, { cache: NO_STORE });

export const POST = route(async (request) => {
  const { webhookSecret } = billingConfig();
  if (!webhookSecret) throw new HttpError("not_configured", "Webhooks are not configured");
  const raw = await request.text(); // the signature covers the exact raw bytes: read before parsing
  if (raw.length > MAX_BODY) throw new HttpError("payload_too_large", "Body too large");
  if (!verifyPaddleSignature(request.headers.get("paddle-signature"), raw, webhookSecret)) {
    throw new HttpError("unauthorized", "Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.warn("[billing] webhook: signed body is not JSON — ignored");
    return ok({ ignored: true });
  }
  const type = event && event.event_type;
  const data = event && event.data && typeof event.data === "object" ? event.data : null;
  if (!HANDLED.has(type) || !data) return ok({ ignored: true });

  const uid = data.custom_data && typeof data.custom_data === "object" ? data.custom_data.uid : null;
  if (typeof uid !== "string" || !UID_RE.test(uid)) {
    console.warn(`[billing] webhook ${type} ${str(data.id) || "?"}: no custom_data.uid — ignored`);
    return ok({ ignored: true });
  }

  const record = subscriptionRecord(data);
  const store = getStore();
  // A store failure → 500, so Paddle retries the notification later.
  await store.setJson(`sub:${uid}`, record);
  await store.sadd("subs", uid);
  console.log(`[billing] ${type}: ${uid} → ${record.status}`);
  return ok();
});
