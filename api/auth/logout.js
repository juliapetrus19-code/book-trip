// POST /api/auth/logout → clears bt_session, { ok: true }. The anonymous cookie stays.
import { NO_STORE, json, route } from "../_lib/http.js";
import { clearSessionCookie } from "../_lib/session.js";

export const POST = route(async (request) => json({ ok: true }, { cache: NO_STORE, headers: { "set-cookie": clearSessionCookie(request) } }));
