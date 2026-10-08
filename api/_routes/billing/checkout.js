// POST /api/billing/checkout { period: "month"|"year" } → { priceId, customData: { uid }, email, env, clientToken }.
// The browser then opens Paddle.js checkout with these; the webhook links the subscription to uid.
import { billingConfig } from "../../_lib/billing.js";
import { HttpError, NO_STORE, json, readJson, route } from "../../_lib/http.js";
import { enforce } from "../../_lib/ratelimit.js";
import { readSession } from "../../_lib/session.js";

export const POST = route(async (request) => {
  const billing = billingConfig();
  if (!billing.enabled) throw new HttpError("not_configured", "Payments are not configured");
  enforce(request, "billing");
  const body = await readJson(request, 1000);
  const session = readSession(request);
  if (!session) throw new HttpError("login_required", "Please sign in first");
  const period = body.period === "year" ? "year" : body.period === "month" ? "month" : null;
  if (!period) throw new HttpError("bad_request", 'Field "period" must be "month" or "year"');
  const price = billing.prices.find((p) => p.period === period);
  if (!price) throw new HttpError("bad_request", `No ${period}ly plan is offered`);
  return json(
    { priceId: price.id, customData: { uid: session.uid }, email: session.email, env: billing.env, clientToken: billing.clientToken },
    { cache: NO_STORE },
  );
});
