// GET /api/auth/verify?t=<sealed> → sets bt_session, merges the anonymous quota into the user's,
// then 302 to `next` with ?login=ok (bad or expired token → 302 /?login=expired).
import { mergeAnonInto } from "../../_lib/access.js";
import { route, searchParams } from "../../_lib/http.js";
import { normalizeEmail, readAnon, safeNext, sessionCookie, uidFor, withLoginParam } from "../../_lib/session.js";
import { canSign, unseal } from "../../_lib/sign.js";
import { getStore } from "../../_lib/store.js";

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } });
}

export const GET = route(async (request) => {
  const data = canSign() ? unseal("login", searchParams(request).get("t")) : null;
  const email = data && normalizeEmail(data.email);
  if (!email) return redirect("/?login=expired");
  const next = safeNext(data.next);
  const uid = uidFor(email);

  try {
    const store = getStore();
    await store.setJson(`user:${uid}`, { email, createdAt: new Date().toISOString() }, { nx: true });
    await store.sadd("users", uid);
    await mergeAnonInto(uid, readAnon(request));
  } catch (err) {
    // The session still works; the quota merge is retried on the next login.
    console.error(`[auth] verify bookkeeping for ${uid}: ${err.message}`);
  }
  return redirect(withLoginParam(next, "ok"), { "set-cookie": sessionCookie(request, email) });
});
