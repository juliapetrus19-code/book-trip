// POST /api/billing/portal → { url } of a Paddle customer-portal session (manage / cancel the plan).
import { billingConfig, paddleApiBase, readSub } from "../../_lib/billing.js";
import { httpFetch } from "../../_lib/fetch.js";
import { HttpError, NO_STORE, json, route } from "../../_lib/http.js";
import { enforce } from "../../_lib/ratelimit.js";
import { readSession } from "../../_lib/session.js";

const CUSTOMER_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const POST = route(async (request) => {
  const billing = billingConfig();
  if (!billing.enabled || !billing.apiKey) throw new HttpError("not_configured", "The billing portal is not configured");
  enforce(request, "billing");
  const session = readSession(request);
  if (!session) throw new HttpError("login_required", "Please sign in first");

  let sub;
  try {
    sub = await readSub(session.uid);
  } catch (err) {
    console.error(`[billing] portal: store error ${err.message}`);
    throw new HttpError("upstream", "Could not load the subscription, please try again");
  }
  if (!sub || typeof sub.customerId !== "string" || !CUSTOMER_RE.test(sub.customerId)) {
    throw new HttpError("not_found", "No subscription found for this account");
  }

  let res;
  try {
    res = await httpFetch(`${paddleApiBase(billing.env)}/customers/${encodeURIComponent(sub.customerId)}/portal-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${billing.apiKey}`, "content-type": "application/json" },
      body: "{}",
    }, 10_000);
  } catch (err) {
    console.error(`[billing] portal: Paddle unreachable: ${err && err.message}`);
    throw new HttpError("upstream", "Could not reach the payment provider");
  }
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  const url = data && data.data && data.data.urls && data.data.urls.general && data.data.urls.general.overview;
  if (!res.ok || typeof url !== "string" || !/^https:\/\//.test(url)) {
    console.error(`[billing] portal: Paddle HTTP ${res.status} ${JSON.stringify(data && data.error ? data.error : null).slice(0, 300)}`);
    throw new HttpError("upstream", "The payment provider did not return a portal link");
  }
  return json({ url }, { cache: NO_STORE });
});
