// POST /api/auth/start { email, lang, next } → { ok: true } and a magic-link e-mail
// (with AUTH_DEV_LINKS=1 — dev/tests only — the link is returned as `devLink` instead of mailed).
// Rate-limited per IP (memory) and per address (store: 5 per hour).
import { createHash } from "node:crypto";
import { LANGS } from "../_lib/enums.js";
import { HttpError, NO_STORE, json, readJson, route, siteOrigin } from "../_lib/http.js";
import { devLinksEnabled, mailConfigured, sendLoginMail } from "../_lib/mail.js";
import { enforce, tooManyError } from "../_lib/ratelimit.js";
import { normalizeEmail, safeNext } from "../_lib/session.js";
import { canSign, seal } from "../_lib/sign.js";
import { getStore } from "../_lib/store.js";

const LOGIN_TTL = 30 * 60;
const PER_EMAIL_LIMIT = 5;
const PER_EMAIL_WINDOW = 3600;

async function countEmail(email) {
  const key = `login:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
  try {
    const store = getStore();
    const n = await store.incr(key);
    if (n === 1) await store.expire(key, PER_EMAIL_WINDOW);
    return n;
  } catch (err) {
    console.error(`[auth] per-email counter: ${err.message}`);
    return 0; // the per-IP limit still applies
  }
}

export const POST = route(async (request) => {
  if (!canSign() || !mailConfigured()) throw new HttpError("not_configured", "Sign-in is not configured");
  enforce(request, "login");
  const body = await readJson(request, 2000);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError("bad_request", "Please enter a valid e-mail address");
  const lang = LANGS.includes(body.lang) ? body.lang : "uk";
  const next = safeNext(body.next);

  if ((await countEmail(email)) > PER_EMAIL_LIMIT) throw tooManyError(PER_EMAIL_WINDOW);

  const link = `${siteOrigin(request)}/api/auth/verify?t=${seal("login", { email, next }, LOGIN_TTL)}`;
  if (devLinksEnabled()) {
    console.warn("[auth] AUTH_DEV_LINKS=1: returning the login link instead of mailing it (never use in production)");
    return json({ ok: true, devLink: link }, { cache: NO_STORE });
  }
  await sendLoginMail(email, link, lang);
  return json({ ok: true }, { cache: NO_STORE });
});
