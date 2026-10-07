// POST /api/access { id } → 200 { allowed: true, freeLeft, subscribed }
//                         | 402 { error: "paywall", message, freeLeft: 0, loggedIn }.
// Counts the book for the visitor (re-opening a counted book is always free).
import { checkAccess, cookieHeaders, identify, paywallError } from "./_lib/access.js";
import { HttpError, ID_RE, NO_STORE, json, readJson, route } from "./_lib/http.js";
import { enforce } from "./_lib/ratelimit.js";

export const POST = route(async (request) => {
  enforce(request, "access");
  const body = await readJson(request, 2000);
  const id = body.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError("bad_request", 'Field "id" must match [a-z0-9-]{1,100}');
  const ident = identify(request);
  const headers = cookieHeaders(ident);
  const result = await checkAccess(ident, id);
  if (!result.allowed) throw paywallError(result.loggedIn, headers);
  return json({ allowed: true, freeLeft: result.freeLeft, subscribed: result.subscribed }, { cache: NO_STORE, headers });
});
