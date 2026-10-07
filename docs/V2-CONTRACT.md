# BookTrip v2 — contract between server (api/**) and client (js/**)

Goal: accounts by email magic link, "2 free books, then subscription" (Paddle Billing),
server-side cache of AI results (one paid generation per book for everybody), waitlist,
pretty book URLs `/book/<id>` with per-book meta, funnel events, PWA, Ukrainian by default.

**Golden rule: the site never breaks without keys.** Every feature turns on only when its env
vars are present. Paywall is OFF unless billing is configured. No Redis → in-memory store.

## Env vars (all optional)
| var | effect |
|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) | Upstash Redis REST (Vercel Marketplace sets the KV_* names). Absent → in-memory Map |
| `SIGNING_SECRET` | required for sessions/anon cookies (falls back to existing masterSecret() derivation in api/_lib/sign.js) |
| `RESEND_API_KEY`, `MAIL_FROM` (default `BookTrip <onboarding@resend.dev>`) | magic-link e-mails |
| `AUTH_DEV_LINKS=1` | DEV/TEST ONLY: /api/auth/start returns `{ devLink }` instead of sending mail (never set in production) |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_MONTH`, `PADDLE_PRICE_YEAR`, `PADDLE_ENV` (`sandbox`\|`production`, default sandbox) | billing. Billing "enabled" = CLIENT_TOKEN + at least one PRICE + WEBHOOK_SECRET |
| `PRICE_LABEL_MONTH`, `PRICE_LABEL_YEAR` | display strings, default `$4.99` / `$29` |
| `FREE_BOOKS` | default 2 |
| `PUBLIC_TELEGRAM` | Telegram username without @ for "write us" buttons |
| `ADMIN_TOKEN` | enables GET /api/admin |
| `SITE_URL` | canonical origin, default from request |

## Identity
- `bt_session` cookie: HttpOnly, Secure (except http://localhost), SameSite=Lax, Path=/, 180 days.
  Value = `seal("session", { uid, email }, 180d)`. uid = first 16 hex of sha256(lowercased email).
- `bt_anon` cookie: same flags, 365 days, `seal("anon", { aid }, 365d)`, aid = 16 random hex. Set by
  /api/access (and /api/me) when missing.
- "subject" = `u:<uid>` if logged in else `a:<aid>`.

## Store keys (Redis)
- `cache:<part>:<lang>:<key>` → JSON of resolve/overview/characters/film results (no TTL; resolve "not found" 1 day)
- `quota:<subject>` → SET of book ids opened
- `sub:<uid>` → JSON `{ status, id, customerId, priceId, endsAt }`
- `user:<uid>` → JSON `{ email, createdAt }`; `users` → SET of uids
- `waitlist` → LIST of JSON `{ q, contact, lang, at }` (LPUSH, trim 5000); `waitlist:count` → ZSET query → count
- `ev:<yyyy-mm-dd>` → HASH name → count
- `login:<sha email>` → rate counter

## Access policy
- Paywall enabled only when billing enabled (see env). Otherwise every check returns allowed.
- subscribed = sub.status in (active, trialing, past_due) OR (status canceled AND endsAt > now).
- A subject may open up to FREE_BOOKS distinct book ids (demo and AI books alike). Re-opening an id
  already in its set is always free. Subscribed users: unlimited.
- On login, anon set is merged into the user's set (union) — logging in never gives extra free books.
- Demo books are static JSON (public) → their gate is client-side (soft). AI parts (overview,
  characters, film, portrait for live books) are gated server-side (hard): if the subject may not
  open `id`, they answer **402** `{ error: "paywall", message, freeLeft: 0, loggedIn }`.
  Gated endpoints use `cache-control: private, no-store` (CDN must not share them); savings come from
  the Redis cache instead.

## Endpoints
All JSON, errors `{ error, message }` as in v1. Cookies `credentials: "same-origin"` (already used by js/api.js fetchJson).

- `GET /api/health` (existing) adds:
  `account: bool` (session signing works and (RESEND_API_KEY or AUTH_DEV_LINKS)),
  `billing: { enabled, env, clientToken, prices: [{ id, period: "month"|"year", label }] }`,
  `freeBooks: number`, `telegram: string|null`, `store: "redis"|"memory"`. Cache stays short.
- `GET /api/me` → `{ user: null | { email, subscribed, plan: "month"|"year"|null, endsAt }, opened: [ids], freeLeft, paywall: bool }` (no-store; sets bt_anon if missing). `paywall` = paywall enabled.
- `POST /api/access` `{ id }` → 200 `{ allowed: true, freeLeft, subscribed }` or 402 `{ error: "paywall", freeLeft: 0, loggedIn }`.
  Counts the id. id must match `[a-z0-9-]{1,100}`.
- `POST /api/auth/start` `{ email, lang, next }` → `{ ok: true }` (+ `devLink` with AUTH_DEV_LINKS). 503 not_configured when no mail and no dev links. Rate limits per IP and per e-mail. `next` = same-origin path only (`/^\/[^/\\]/`), default `/`.
- `GET /api/auth/verify?t=<sealed>` → sets bt_session, merges anon quota, 302 to `next` with `?login=ok` appended (or `?login=expired` on bad/expired token, 302 to `/`). Token = `seal("login", { email, next }, 30 min)`.
- `POST /api/auth/logout` → clears bt_session, `{ ok: true }`.
- `POST /api/billing/checkout` `{ period }` → `{ priceId, customData: { uid }, email, env, clientToken }` (401 `login_required` if no session). Client then calls Paddle.js.
- `POST /api/billing/webhook` — Paddle Billing webhook. Header `Paddle-Signature: ts=<unix>;h1=<hex>`; valid when HMAC-SHA256(PADDLE_WEBHOOK_SECRET, `${ts}:${rawBody}`) equals h1 (constant-time) and |now−ts| ≤ 300 s. Handles `subscription.created|updated|activated|canceled|past_due|paused|resumed`: uid from `data.custom_data.uid`, writes `sub:<uid>` from `data.status`, `data.id`, `data.customer_id`, `data.items[0].price.id`, `data.current_billing_period.ends_at` (or `data.scheduled_change.effective_at`). Always 200 for valid signatures (ignored events too); 401 for bad signature.
- `POST /api/billing/portal` → `{ url }` — Paddle `POST {base}/customers/{customerId}/portal-sessions` (Bearer PADDLE_API_KEY), base `https://api.paddle.com` or `https://sandbox-api.paddle.com`; returns `data.urls.general.overview`. 401 if not logged in, 404 if no subscription.
- `POST /api/waitlist` `{ q, contact, lang }` → `{ ok: true }`. q 1..200 chars, contact = `@handle`/handle (5–32 [A-Za-z0-9_]) or e-mail, ≤ 120 chars. Rate-limited.
- `POST /api/event` `{ name, id? }` → 204. name ∈ `search, book_open, paywall_shown, checkout_start, signup_start, signup_done, waitlist_join, install`. Rate-limited, never fails loudly.
- `GET /api/admin` header `x-admin-token` → `{ waitlist: { top: [{ q, count }], recent: [...] }, events: { "<day>": { name: count } } (last 30 days), users, subscribers }`. 404 when ADMIN_TOKEN unset, 403 when wrong.
- `GET /book/<id>` (vercel rewrite → `/api/book?id=<id>`): returns index.html with per-book `<title>`, meta description, canonical `/book/<id>`, Open Graph/Twitter tags, `<html lang>`, hreflang links (`?lang=uk|ru|en`), and an SEO block `<section id="ssr-book">` (title, author, tagline, summary paragraphs, terms) that the client removes on boot. Language: `?lang=` else Accept-Language (ru→ru, en→en, else uk). Unknown id (not demo, not in cache) → plain index.html with 200 (client handles it). Book data: data/books/<id>.json, else the cached resolve/overview in store.
- `GET /sitemap.xml` (rewrite → `/api/sitemap`) — home + every demo book + cached AI books, with hreflang alternates. `robots.txt` static, points to sitemap.

## Static pages
`/terms`, `/privacy`, `/refund` (terms.html …; cleanUrls) — trilingual (uk default, ru, en tabs), draft legal text naming BookTrip, Paddle as Merchant of Record, 14-day refund, contact via Telegram. Linked from the site footer and paywall.

## Client
- All asset URLs in index.html absolute (`/css/…`, `/js/app.js`, `/vendor/three.min.js`, `/icon.svg`), all fetches `/api/…`, `/data/…` absolute — because the same index.html is served at `/book/<id>`.
- Router: book routes live at path `/book/<id>`; other routes stay hash-based on `/` (`/#/q/…`); modals `#/how|library|premium` overlay the current path. Legacy `#/book/<id>` → replaceState to `/book/<id>`. Internal `<a href="#/…">` clicks are intercepted (no reload). popstate + hashchange both route.
- Default language uk (explicit user choice in storage wins; else navigator.language ru→ru, en→en, else uk).
