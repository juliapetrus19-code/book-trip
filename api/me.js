// GET /api/me → { user: null | { email, subscribed, plan, endsAt }, opened: [ids], freeLeft, paywall }.
// Per-visitor (no-store); gives a new visitor its bt_anon cookie.
import { accountState, cookieHeaders, freeBooks, identify, paywallEnabled } from "./_lib/access.js";
import { NO_STORE, json, route } from "./_lib/http.js";
import { enforce } from "./_lib/ratelimit.js";

export const GET = route(async (request) => {
  enforce(request, "access");
  const ident = identify(request);
  const state = await accountState(ident);
  const user = ident.session
    ? {
      email: ident.session.email,
      subscribed: state.subscribed,
      plan: state.subscribed ? state.plan : null,
      endsAt: state.sub && typeof state.sub.endsAt === "string" ? state.sub.endsAt : null,
    }
    : null;
  return json(
    { user, opened: state.opened, freeLeft: Math.max(0, freeBooks() - state.opened.length), paywall: paywallEnabled() },
    { cache: NO_STORE, headers: cookieHeaders(ident) },
  );
});
