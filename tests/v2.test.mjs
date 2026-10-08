// BookTrip v2 server tests (node --test): store, sessions, access policy / paywall, auth, billing
// webhook, waitlist, events, admin, SEO pages and sitemap. No network: fetch, Claude and the
// store are injected.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryStore, createRedisStore, setStoreForTests, soft, StoreError, storeKind } from "../api/_lib/store.js";
import { setFetchForTests } from "../api/_lib/fetch.js";
import { setClientForTests } from "../api/_lib/claude.js";
import { setDemoDirForTests } from "../api/_lib/demo.js";
import { setProjectRootForTests } from "../api/_lib/files.js";
import { resetRateLimits } from "../api/_lib/ratelimit.js";
import { CACHE_PUBLIC, PRIVATE } from "../api/_lib/http.js";
import { seal } from "../api/_lib/sign.js";
import {
  ANON_COOKIE, SESSION_COOKIE, ensureAnon, normalizeEmail, parseCookies, readAnon, readSession, safeNext, serializeCookie,
  sessionCookie, subject, uidFor, withLoginParam,
} from "../api/_lib/session.js";
import { isSubscribed, paddleSignature, parseSignatureHeader, verifyPaddleSignature } from "../api/_lib/billing.js";
import { loginMail } from "../api/_lib/mail.js";
import { normalizeQuery } from "../api/_lib/cache.js";

import { GET as health } from "../api/_routes/health.js";
import { GET as me } from "../api/_routes/me.js";
import { POST as access } from "../api/_routes/access.js";
import { POST as authStart } from "../api/_routes/auth/start.js";
import { GET as authVerify } from "../api/_routes/auth/verify.js";
import { POST as authLogout } from "../api/_routes/auth/logout.js";
import { POST as checkout } from "../api/_routes/billing/checkout.js";
import { POST as portal } from "../api/_routes/billing/portal.js";
import { POST as webhook, subscriptionRecord } from "../api/_routes/billing/webhook.js";
import { POST as waitlist, normalizeContact } from "../api/_routes/waitlist.js";
import { POST as event } from "../api/_routes/event.js";
import { GET as admin } from "../api/_routes/admin.js";
import { GET as bookPage, pickLang, scriptJson } from "../api/_routes/book.js";
import { GET as sitemap } from "../api/_routes/sitemap.js";
import { GET as resolve } from "../api/_routes/resolve.js";
import { GET as overview } from "../api/_routes/overview.js";
import { GET as characters } from "../api/_routes/characters.js";
import { GET as portrait } from "../api/_routes/portrait.js";
import { portraitToken } from "../api/_lib/sign.js";

// ---------------------------------------------------------------------------------------------
// Helpers

const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "SIGNING_SECRET", "SITE_URL", "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "RESEND_API_KEY", "MAIL_FROM", "AUTH_DEV_LINKS",
  "PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET", "PADDLE_CLIENT_TOKEN", "PADDLE_PRICE_MONTH", "PADDLE_PRICE_YEAR", "PADDLE_ENV",
  "PRICE_LABEL_MONTH", "PRICE_LABEL_YEAR", "FREE_BOOKS", "PUBLIC_TELEGRAM", "ADMIN_TOKEN", "VERCEL",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const WEBHOOK_SECRET = "pdl_ntfset_test_secret";

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SIGNING_SECRET = "v2-test-secret";
}

function billingEnv(extra = {}) {
  Object.assign(process.env, {
    PADDLE_CLIENT_TOKEN: "test_client_token", PADDLE_PRICE_MONTH: "pri_month", PADDLE_PRICE_YEAR: "pri_year",
    PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET, PADDLE_API_KEY: "pdl_test_apikey",
  }, extra);
}

let store;
let ipCounter = 0;

function req(path, { method = "GET", headers = {}, body, ip, cookies, origin = "https://booktrip.test" } = {}) {
  const h = { "x-forwarded-for": ip || `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...headers };
  if (cookies) h.cookie = Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request(origin + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

/** name → value from a response's Set-Cookie headers. */
function setCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** A browser-like visitor: keeps cookies between requests. */
function visitor() {
  const jar = {};
  const call = async (handler, path, opts = {}) => {
    const res = await handler(req(path, { ...opts, cookies: { ...jar } }));
    for (const [k, v] of Object.entries(setCookies(res))) { if (v) jar[k] = v; else delete jar[k]; }
    return res;
  };
  return { jar, call };
}

function useFetch(handler) {
  const calls = [];
  setFetchForTests(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

function message(obj) {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null,
    content: [{ type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function useClaude(responder) {
  const calls = [];
  setClientForTests({ beta: { messages: { create: async (p) => { calls.push(p); return responder(p); } } } });
  return calls;
}

function signedWebhook(payload, { ts = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  return req("/api/billing/webhook", { method: "POST", body: raw, headers: { "paddle-signature": `ts=${ts};h1=${paddleSignature(secret, ts, raw)}` } });
}

function subEvent(type, uid, data = {}) {
  return {
    event_id: "evt_1", event_type: type,
    data: {
      id: "sub_01", status: "active", customer_id: "ctm_01", items: [{ price: { id: "pri_month" } }],
      current_billing_period: { starts_at: "2026-10-01T00:00:00Z", ends_at: "2099-11-01T00:00:00Z" },
      scheduled_change: null, custom_data: { uid }, ...data,
    },
  };
}

beforeEach(() => {
  clearEnv();
  resetRateLimits();
  store = createMemoryStore();
  setStoreForTests(store);
  setFetchForTests(async () => { throw new Error("network disabled in tests"); });
  setClientForTests(null);
  setDemoDirForTests(null);
  setProjectRootForTests(null);
});

after(() => {
  setStoreForTests(null);
  setFetchForTests(null);
  setClientForTests(null);
  setDemoDirForTests(null);
  setProjectRootForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

// ---------------------------------------------------------------------------------------------
describe("store (memory)", () => {
  test("strings: set/get, NX, EX expiry, incr, mget, del", async () => {
    assert.equal(await store.get("a"), null);
    assert.equal(await store.set("a", "1"), true);
    assert.equal(await store.set("a", "2", { nx: true }), false);
    assert.equal(await store.get("a"), "1");
    assert.equal(await store.incr("a"), 2);
    assert.equal(await store.incr("new"), 1);
    await store.setJson("j", { x: [1, 2] });
    assert.deepEqual(await store.getJson("j"), { x: [1, 2] });
    assert.deepEqual(await store.mget(["a", "missing", "new"]), ["2", null, "1"]);
    assert.equal(await store.del("a"), 1);
    assert.equal(await store.get("a"), null);

    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      await store.set("ttl", "v", { ex: 10 });
      await store.set("ttl2", "v");
      await store.expire("ttl2", 5);
      Date.now = () => t0 + 9_000;
      assert.equal(await store.get("ttl"), "v");
      assert.equal(await store.get("ttl2"), null);
      Date.now = () => t0 + 10_001;
      assert.equal(await store.get("ttl"), null);
    } finally {
      Date.now = realNow;
    }
  });

  test("sets, lists, sorted sets, hashes, pipeline, wrong type", async () => {
    assert.equal(await store.sadd("s1", "a", "b", "a"), 2);
    assert.equal(await store.sadd("s2", "b", "c"), 2);
    assert.equal(await store.scard("s1"), 2);
    assert.equal(await store.sismember("s1", "a"), true);
    assert.equal(await store.sismember("s1", "z"), false);
    assert.equal(await store.sunionstore("s3", "s1", "s2", "nope"), 3);
    assert.deepEqual((await store.smembers("s3")).sort(), ["a", "b", "c"]);
    assert.equal(await store.srem("s3", "a", "zz"), 1);
    assert.equal(await store.scard("s3"), 2);

    for (let i = 0; i < 6; i++) await store.lpush("l", `v${i}`);
    await store.ltrim("l", 0, 3);
    assert.deepEqual(await store.lrange("l", 0, -1), ["v5", "v4", "v3", "v2"]);
    assert.deepEqual(await store.lrange("l", 1, 2), ["v4", "v3"]);

    await store.zincrby("z", 1, "hobbit");
    await store.zincrby("z", 3, "dune");
    await store.zincrby("z", 1, "hobbit");
    assert.deepEqual(await store.zrevrangeWithScores("z", 0, 9), [{ member: "dune", score: 3 }, { member: "hobbit", score: 2 }]);

    assert.equal(await store.hincrby("h", "search"), 1);
    assert.equal(await store.hincrby("h", "search", 4), 5);
    await store.hincrby("h", "install");
    assert.deepEqual(await store.hgetall("h"), { search: "5", install: "1" });
    assert.deepEqual(await store.hgetall("none"), {});

    const results = await store.pipeline([["SET", "p", "1"], ["INCR", "p"], ["GET", "p"]]);
    assert.deepEqual(results, ["OK", 2, "2"]);
    await assert.rejects(store.sadd("p", "x"), StoreError);
    assert.equal(storeKind(), "memory");
  });

  test("Upstash REST wiring: command body, auth header, pipeline, errors → StoreError, soft() fallback", async () => {
    const calls = useFetch((url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/pipeline")) return Response.json(body.map(() => ({ result: "OK" })));
      if (body[0] === "GET" && body[1] === "boom") return Response.json({ error: "ERR boom" }, { status: 400 });
      if (body[0] === "HGETALL") return Response.json({ result: ["a", "1", "b", "2"] });
      return Response.json({ result: body[0] === "GET" ? "value" : 1 });
    });
    const redis = createRedisStore("https://eu1-x.upstash.io/", "tok");
    assert.equal(redis.kind, "redis");
    assert.equal(await redis.get("k"), "value");
    assert.equal(calls[0].url, "https://eu1-x.upstash.io");
    assert.equal(calls[0].init.headers.authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(calls[0].init.body), ["GET", "k"]);
    await redis.set("k", "v", { ex: 60 });
    assert.deepEqual(JSON.parse(calls[1].init.body), ["SET", "k", "v", "EX", "60"]);
    assert.deepEqual(await redis.hgetall("h"), { a: "1", b: "2" });
    assert.deepEqual(await redis.pipeline([["SET", "a", 1], ["SET", "b", 2]]), ["OK", "OK"]);
    assert.ok(calls.at(-1).url.endsWith("/pipeline"));
    await assert.rejects(redis.get("boom"), StoreError);

    setFetchForTests(async () => { throw new TypeError("fetch failed"); });
    await assert.rejects(redis.get("x"), StoreError);
    setStoreForTests(redis);
    assert.equal(await soft("test", (s) => s.get("x"), "fallback"), "fallback");
  });

  test("env selects Redis (KV_* or UPSTASH_*), else memory", () => {
    setStoreForTests(null);
    assert.equal(storeKind(), "memory");
    process.env.UPSTASH_REDIS_REST_URL = "https://x.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    assert.equal(storeKind(), "redis");
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.KV_REST_API_URL = "https://y.upstash.io";
    process.env.KV_REST_API_TOKEN = "t";
    assert.equal(storeKind(), "redis");
  });
});

// ---------------------------------------------------------------------------------------------
describe("sessions and cookies", () => {
  test("session cookie round-trip, flags, forgery", () => {
    const email = "Reader@Example.com";
    const line = sessionCookie(req("/"), normalizeEmail(email));
    assert.match(line, /^bt_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure$/);
    const value = line.split(";")[0].split("=")[1];
    const session = readSession(req("/", { cookies: { [SESSION_COOKIE]: value } }));
    assert.deepEqual(session, { uid: uidFor("reader@example.com"), email: "reader@example.com" });
    assert.match(session.uid, /^[0-9a-f]{16}$/);
    assert.equal(uidFor(" READER@example.com "), session.uid);
    assert.equal(subject(session, "abcd"), `u:${session.uid}`);

    // forged / wrong purpose / garbage
    assert.equal(readSession(req("/", { cookies: { [SESSION_COOKIE]: seal("anon", { uid: session.uid, email }, 60) } })), null);
    assert.equal(readSession(req("/", { cookies: { [SESSION_COOKIE]: value.slice(0, -2) + "AA" } })), null);
    assert.equal(readSession(req("/", { cookies: { [SESSION_COOKIE]: "x" } })), null);
    process.env.SIGNING_SECRET = "another-secret";
    assert.equal(readSession(req("/", { cookies: { [SESSION_COOKIE]: value } })), null);
  });

  test("Secure is off only for plain-http localhost", () => {
    assert.ok(!serializeCookie(req("/", { origin: "http://localhost:5600" }), "a", "b", 1).includes("Secure"));
    assert.ok(!serializeCookie(req("/", { origin: "http://127.0.0.1:5600" }), "a", "b", 1).includes("Secure"));
    assert.ok(serializeCookie(req("/", { origin: "http://booktrip.test" }), "a", "b", 1).includes("Secure"));
    assert.ok(serializeCookie(req("/", { origin: "https://localhost" }), "a", "b", 1).includes("Secure"));
  });

  test("anon cookie: created once, then read back; no signing → null", () => {
    const first = ensureAnon(req("/"));
    assert.match(first.aid, /^[0-9a-f]{16}$/);
    assert.match(first.setCookie, /^bt_anon=.+; Max-Age=31536000; Secure$/);
    const value = first.setCookie.split(";")[0].split("=")[1];
    const again = ensureAnon(req("/", { cookies: { [ANON_COOKIE]: value } }));
    assert.deepEqual(again, { aid: first.aid, setCookie: null });
    assert.equal(readAnon(req("/", { cookies: { [ANON_COOKIE]: value } })), first.aid);
    assert.equal(subject(null, first.aid), `a:${first.aid}`);
    delete process.env.SIGNING_SECRET;
    assert.equal(ensureAnon(req("/")), null);
  });

  test("e-mail validation, safe next, cookie parsing", () => {
    assert.equal(normalizeEmail("  A.B+tag@Mail.Example.UA "), "a.b+tag@mail.example.ua");
    for (const bad of ["", "a@b", "no-at.example.com", "a b@c.com", "<a@b.com>", "a@-b.com", "a@b.c", `${"x".repeat(250)}@b.com`, 42, null]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
    assert.equal(safeNext("/book/the-hobbit?lang=en#x"), "/book/the-hobbit?lang=en#x");
    assert.equal(safeNext("/"), "/");
    for (const bad of ["//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com", "evil", "", null, "/\n/evil"]) {
      assert.equal(safeNext(bad), "/", JSON.stringify(bad));
    }
    assert.equal(withLoginParam("/", "ok"), "/?login=ok");
    assert.equal(withLoginParam("/book/x?lang=ru#/how", "ok"), "/book/x?lang=ru&login=ok#/how");
    assert.deepEqual([...parseCookies("a=1; b=x=y;  c=; bad")], [["a", "1"], ["b", "x=y"], ["c", ""]]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("access policy", () => {
  test("paywall disabled without billing env: everything allowed, opened ids still listed", async () => {
    const v = visitor();
    for (const id of ["a", "b", "c", "d"]) {
      const res = await v.call(access, "/api/access", { method: "POST", body: { id } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).allowed, true);
    }
    const body = await (await v.call(me, "/api/me")).json();
    assert.equal(body.paywall, false);
    assert.deepEqual(body.opened, ["a", "b", "c", "d"]);
    assert.equal(body.user, null);
  });

  test("billing without SIGNING_SECRET (and no API key) stays off", async () => {
    billingEnv();
    delete process.env.SIGNING_SECRET;
    const body = await (await health(req("/api/health"))).json();
    assert.equal(body.billing.enabled, false);
    assert.equal(body.account, false);
  });

  test("on Vercel the paywall needs Redis (subscriptions must be visible to every instance)", async () => {
    billingEnv({ VERCEL: "1" });
    assert.equal((await (await health(req("/api/health"))).json()).billing.enabled, false);
    setStoreForTests(createRedisStore("https://x.upstash.io", "t"));
    assert.equal((await (await health(req("/api/health"))).json()).billing.enabled, true);
  });

  test("FREE_BOOKS distinct books, re-open free, then 402", async () => {
    billingEnv();
    const v = visitor();
    const open = (id) => v.call(access, "/api/access", { method: "POST", body: { id } });
    const r1 = await open("book-one");
    assert.equal(r1.headers.get("cache-control"), "no-store");
    assert.ok(v.jar[ANON_COOKIE], "anon cookie set");
    assert.deepEqual(await r1.json(), { allowed: true, freeLeft: 1, subscribed: false });
    assert.deepEqual(await (await open("book-two")).json(), { allowed: true, freeLeft: 0, subscribed: false });
    const denied = await open("book-three");
    assert.equal(denied.status, 402);
    const body = await denied.json();
    assert.equal(body.error, "paywall");
    assert.equal(body.freeLeft, 0);
    assert.equal(body.loggedIn, false);
    assert.equal(typeof body.message, "string");
    assert.equal((await open("book-one")).status, 200, "re-opening is free");
    const meBody = await (await v.call(me, "/api/me")).json();
    assert.deepEqual(meBody, { user: null, opened: ["book-one", "book-two"], freeLeft: 0, paywall: true });

    process.env.FREE_BOOKS = "3";
    assert.equal((await open("book-three")).status, 200);
  });

  test("bad ids and bodies → 400", async () => {
    for (const body of [{ id: "Bad_Id" }, { id: "a".repeat(101) }, {}, "not json", [1]]) {
      const res = await access(req("/api/access", { method: "POST", body }));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("subscribed users are unlimited; canceled counts until endsAt", async () => {
    billingEnv();
    const email = "sub@example.com";
    const uid = uidFor(email);
    const sessionValue = sessionCookie(req("/"), email).split(";")[0].split("=")[1];
    const open = (id) => access(req("/api/access", { method: "POST", body: { id }, cookies: { [SESSION_COOKIE]: sessionValue } }));
    await store.setJson(`sub:${uid}`, { status: "active", id: "sub_1", customerId: "ctm_1", priceId: "pri_year", endsAt: "2099-01-01T00:00:00Z" });
    for (const id of ["a", "b", "c", "d", "e"]) assert.equal((await open(id)).status, 200);
    const meBody = await (await me(req("/api/me", { cookies: { [SESSION_COOKIE]: sessionValue } }))).json();
    assert.deepEqual(meBody.user, { email, subscribed: true, plan: "year", endsAt: "2099-01-01T00:00:00Z" });

    await store.setJson(`sub:${uid}`, { status: "canceled", endsAt: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal((await open("f")).status, 200);
    await store.setJson(`sub:${uid}`, { status: "canceled", endsAt: new Date(Date.now() - 1000).toISOString() });
    const res = await open("g");
    assert.equal(res.status, 402);
    assert.equal((await res.json()).loggedIn, true);

    assert.equal(isSubscribed({ status: "trialing" }), true);
    assert.equal(isSubscribed({ status: "past_due" }), true);
    assert.equal(isSubscribed({ status: "paused" }), false);
    assert.equal(isSubscribed({ status: "canceled", endsAt: null }), false);
    assert.equal(isSubscribed(null), false);
  });

  test("a store outage allows access (paying users are never locked out)", async () => {
    billingEnv();
    setStoreForTests({ kind: "redis", pipeline: async () => { throw new StoreError("down"); }, exec: async () => { throw new StoreError("down"); } });
    const res = await access(req("/api/access", { method: "POST", body: { id: "x" } }));
    assert.equal(res.status, 200);
  });

  test("login merges the anon quota (union) and never adds free books", async () => {
    billingEnv({ AUTH_DEV_LINKS: "1" });
    const v = visitor();
    await v.call(access, "/api/access", { method: "POST", body: { id: "anon-a" } });
    await v.call(access, "/api/access", { method: "POST", body: { id: "anon-b" } });
    // the user already opened one book elsewhere
    const uid = uidFor("merge@example.com");
    await store.sadd(`quota:u:${uid}`, "user-x");

    const start = await v.call(authStart, "/api/auth/start", { method: "POST", body: { email: "Merge@Example.com", lang: "en", next: "/book/anon-a" } });
    assert.equal(start.status, 200);
    const { ok, devLink } = await start.json();
    assert.equal(ok, true);
    assert.ok(devLink.startsWith("https://booktrip.test/api/auth/verify?t="));
    const verify = await v.call(authVerify, new URL(devLink).pathname + new URL(devLink).search);
    assert.equal(verify.status, 302);
    assert.equal(verify.headers.get("location"), "/book/anon-a?login=ok");
    assert.ok(v.jar[SESSION_COOKIE]);

    const meBody = await (await v.call(me, "/api/me")).json();
    assert.equal(meBody.user.email, "merge@example.com");
    assert.equal(meBody.user.subscribed, false);
    assert.deepEqual(meBody.opened, ["anon-a", "anon-b", "user-x"]);
    assert.equal(meBody.freeLeft, 0);
    assert.equal((await v.call(access, "/api/access", { method: "POST", body: { id: "new-one" } })).status, 402);
    assert.deepEqual(JSON.parse(await store.get(`user:${uid}`)).email, "merge@example.com");
    assert.equal(await store.sismember("users", uid), true);

    // logout clears only the session
    const out = await v.call(authLogout, "/api/auth/logout", { method: "POST" });
    assert.deepEqual(await out.json(), { ok: true });
    assert.match(out.headers.get("set-cookie"), /^bt_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.ok(!v.jar[SESSION_COOKIE]);
    assert.equal((await (await v.call(me, "/api/me")).json()).user, null);
  });

  test("gated AI parts: 402 when used up, private caching, cached results served", async () => {
    billingEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const calls = useClaude(() => message({ known: true, summary: ["P1"], themes: [], terms: [], similar: [] }));
    const v = visitor();
    const params = (id) => `/api/overview?id=${id}&title=T&lang=en`;
    const r1 = await v.call(overview, params("one"));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("cache-control"), PRIVATE);
    await v.call(overview, params("two"));
    const r3 = await v.call(overview, params("three"));
    assert.equal(r3.status, 402);
    assert.equal((await r3.json()).error, "paywall");
    assert.equal(calls.length, 2, "no AI call for a paywalled book");
    assert.equal((await v.call(overview, params("one"))).status, 200);

    // live portraits are gated as well (demo portraits are not)
    process.env.GEMINI_API_KEY = "g";
    const prompt = "A fox.";
    const p = await v.call(portrait, `/api/portrait?book=three&char=fox&prompt=${encodeURIComponent(prompt)}&token=${portraitToken("three", "fox", prompt)}`);
    assert.equal(p.status, 402);
  });
});

// ---------------------------------------------------------------------------------------------
describe("server cache", () => {
  const FOUND = { found: true, id: "the-hobbit-tolkien", title: "The Hobbit", originalTitle: "The Hobbit", author: "J. R. R. Tolkien", year: 1937, genre: "Fantasy", tagline: "There and back again.", cover: {}, suggestions: [] };

  test("resolve: normalised query hits the cache, not-found answers expire after a day", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const calls = useClaude(() => message(FOUND));
    assert.equal((await resolve(req("/api/resolve?q=The%20Hobbit&lang=en"))).status, 200);
    const again = await resolve(req("/api/resolve?q=%20%20the%20%20HOBBIT%20&lang=en"));
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("cache-control"), CACHE_PUBLIC);
    assert.equal((await again.json()).id, "the-hobbit-tolkien");
    assert.equal(calls.length, 1);
    assert.equal(normalizeQuery("  The   HOBBIT "), "the hobbit");

    // a cached answer is served even after the key is removed
    delete process.env.ANTHROPIC_API_KEY;
    setClientForTests(null);
    assert.equal((await resolve(req("/api/resolve?q=the%20hobbit&lang=en"))).status, 200);
    assert.equal((await resolve(req("/api/resolve?q=other&lang=en"))).status, 503);

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    useClaude(() => message({ found: false, suggestions: [] }));
    await resolve(req("/api/resolve?q=zzzz&lang=en"));
    const ttl = await store.exec("TTL", "cache:resolve:en:zzzz");
    assert.ok(ttl > 86000 && ttl <= 86400, `ttl ${ttl}`);
    assert.equal(await store.exec("TTL", "cache:resolve:en:the hobbit"), -1);
  });

  test("overview / characters are cached only for canonical ids, with the canonical title", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    let calls = useClaude(() => message(FOUND));
    await resolve(req("/api/resolve?q=hobbit&lang=en"));

    calls = useClaude(() => message({ known: true, summary: ["Bilbo goes."], themes: [], terms: [], similar: [] }));
    const r1 = await overview(req("/api/overview?id=the-hobbit-tolkien&title=EVIL%20TITLE&lang=ru"));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("cache-control"), CACHE_PUBLIC, "no paywall → CDN-cacheable as in v1");
    assert.ok(calls[0].messages[0].content.includes('"The Hobbit"'), "canonical title sent to the model");
    assert.ok(!calls[0].messages[0].content.includes("EVIL"));
    await overview(req("/api/overview?id=the-hobbit-tolkien&title=x&lang=ru"));
    assert.equal(calls.length, 1, "second request served from the store");
    assert.equal(await store.sismember("books", "the-hobbit-tolkien"), true);

    // an id nobody resolved is generated but never shared
    await overview(req("/api/overview?id=made-up-id&title=Anything&lang=en"));
    await overview(req("/api/overview?id=made-up-id&title=Anything&lang=en"));
    assert.equal(calls.length, 3);
    assert.equal(await store.get("cache:overview:en:made-up-id"), null);

    // characters: tokens are added on every answer, never stored
    const APPEARANCE = { creature: "hobbit" };
    calls = useClaude(() => message({ known: true, characters: [{ id: "bilbo", name: "Bilbo", role: "protagonist", traits: [], description: "d", appearance: APPEARANCE, portraitPrompt: "A hobbit." }] }));
    const c1 = await (await characters(req("/api/characters?id=the-hobbit-tolkien&title=x&lang=en"))).json();
    const stored = await store.getJson("cache:characters:en:the-hobbit-tolkien");
    assert.ok(stored && !("portraitToken" in stored.characters[0]));
    process.env.SIGNING_SECRET = "rotated";
    const c2 = await (await characters(req("/api/characters?id=the-hobbit-tolkien&title=x&lang=en"))).json();
    assert.equal(calls.length, 1);
    assert.notEqual(c1.characters[0].portraitToken, c2.characters[0].portraitToken);
    assert.equal(c2.characters[0].portraitToken, portraitToken("the-hobbit-tolkien", "bilbo", "A hobbit."));
  });
});

// ---------------------------------------------------------------------------------------------
describe("billing", () => {
  test("webhook signature: valid, wrong, stale, malformed, rotated secrets", () => {
    const raw = '{"a":1}';
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const h = paddleSignature(WEBHOOK_SECRET, ts, raw);
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw, WEBHOOK_SECRET, now), true);
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${"0".repeat(64)};h1=${h}`, raw, WEBHOOK_SECRET, now), true, "any h1 may match");
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw + " ", WEBHOOK_SECRET, now), false);
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw, "other", now), false);
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw, WEBHOOK_SECRET, now + 301_000), false, "stale");
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw, WEBHOOK_SECRET, now - 301_000), false, "future");
    assert.equal(verifyPaddleSignature(`ts=${ts};h1=${h}`, raw, WEBHOOK_SECRET, now + 299_000), true);
    for (const bad of [null, "", "ts=abc;h1=" + h, `h1=${h}`, `ts=${ts}`, `ts=${ts};h1=zz`]) {
      assert.equal(verifyPaddleSignature(bad, raw, WEBHOOK_SECRET, now), false, String(bad));
    }
    assert.deepEqual(parseSignatureHeader(`ts=1;h1=${h}`), { ts: 1, h1: [h] });
  });

  test("webhook endpoint: 401 bad signature, subscription events write sub:<uid>, others ignored", async () => {
    billingEnv();
    const uid = uidFor("payer@example.com");
    const bad = await webhook(req("/api/billing/webhook", { method: "POST", body: "{}", headers: { "paddle-signature": "ts=1;h1=" + "a".repeat(64) } }));
    assert.equal(bad.status, 401);
    const stale = await webhook(signedWebhook(subEvent("subscription.created", uid), { ts: Math.floor(Date.now() / 1000) - 600 }));
    assert.equal(stale.status, 401);
    assert.equal(await store.get(`sub:${uid}`), null);

    const res = await webhook(signedWebhook(subEvent("subscription.created", uid)));
    assert.equal(res.status, 200);
    assert.deepEqual(await store.getJson(`sub:${uid}`), { status: "active", id: "sub_01", customerId: "ctm_01", priceId: "pri_month", endsAt: "2099-11-01T00:00:00Z" });
    assert.equal(await store.sismember("subs", uid), true);

    // cancel at period end → still subscribed until the scheduled date
    await webhook(signedWebhook(subEvent("subscription.updated", uid, { status: "active", scheduled_change: { action: "cancel", effective_at: "2099-12-01T00:00:00Z" } })));
    await webhook(signedWebhook(subEvent("subscription.canceled", uid, { status: "canceled", current_billing_period: null, scheduled_change: null })));
    const sub = await store.getJson(`sub:${uid}`);
    assert.equal(sub.status, "canceled");
    assert.equal(sub.endsAt, null);
    assert.equal(isSubscribed(sub), false);

    for (const payload of [
      { event_type: "transaction.completed", data: { id: "txn_1" } },
      subEvent("subscription.created", "not-a-uid"),
      subEvent("subscription.created", undefined),
    ]) {
      const r = await webhook(signedWebhook(payload));
      assert.equal(r.status, 200);
      assert.equal((await r.json()).ignored, true);
    }
    delete process.env.PADDLE_WEBHOOK_SECRET;
    assert.equal((await webhook(signedWebhook(subEvent("subscription.created", uid)))).status, 503);
  });

  test("status mapping", () => {
    const rec = subscriptionRecord({ status: "past_due", id: "sub_9", customer_id: "ctm_9", items: [{ price: { id: "pri_year" } }], current_billing_period: null, scheduled_change: { effective_at: "2030-01-01T00:00:00Z" } });
    assert.deepEqual(rec, { status: "past_due", id: "sub_9", customerId: "ctm_9", priceId: "pri_year", endsAt: "2030-01-01T00:00:00Z" });
    assert.deepEqual(subscriptionRecord({}), { status: "unknown", id: null, customerId: null, priceId: null, endsAt: null });
  });

  test("checkout: 503 without billing, 401 without session, then Paddle.js parameters", async () => {
    assert.equal((await checkout(req("/api/billing/checkout", { method: "POST", body: { period: "month" } }))).status, 503);
    billingEnv({ PADDLE_ENV: "production" });
    const anon = await checkout(req("/api/billing/checkout", { method: "POST", body: { period: "month" } }));
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error, "login_required");
    const session = sessionCookie(req("/"), "buyer@example.com").split(";")[0].split("=")[1];
    const res = await checkout(req("/api/billing/checkout", { method: "POST", body: { period: "year" }, cookies: { [SESSION_COOKIE]: session } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { priceId: "pri_year", customData: { uid: uidFor("buyer@example.com") }, email: "buyer@example.com", env: "production", clientToken: "test_client_token" });
    const bad = await checkout(req("/api/billing/checkout", { method: "POST", body: { period: "week" }, cookies: { [SESSION_COOKIE]: session } }));
    assert.equal(bad.status, 400);
  });

  test("portal: 401 / 404 / Paddle portal session URL", async () => {
    billingEnv();
    assert.equal((await portal(req("/api/billing/portal", { method: "POST" }))).status, 401);
    const email = "p@example.com";
    const session = sessionCookie(req("/"), email).split(";")[0].split("=")[1];
    const call = () => portal(req("/api/billing/portal", { method: "POST", cookies: { [SESSION_COOKIE]: session } }));
    assert.equal((await call()).status, 404);
    await store.setJson(`sub:${uidFor(email)}`, { status: "active", id: "sub_1", customerId: "ctm_abc", priceId: "pri_month", endsAt: null });
    const calls = useFetch(() => Response.json({ data: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1" } } } }));
    const res = await call();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: "https://customer-portal.paddle.com/cpl_1" });
    assert.equal(calls[0].url, "https://sandbox-api.paddle.com/customers/ctm_abc/portal-sessions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.authorization, "Bearer pdl_test_apikey");
    useFetch(() => Response.json({ error: { code: "forbidden" } }, { status: 403 }));
    assert.equal((await call()).status, 502);
  });

  test("health reports billing, account, telegram — never secrets", async () => {
    billingEnv({ PUBLIC_TELEGRAM: "@booktrip_ua", RESEND_API_KEY: "re_secret", PRICE_LABEL_MONTH: "₴199" });
    const text = await (await health(req("/api/health"))).text();
    const body = JSON.parse(text);
    assert.equal(body.account, true);
    assert.deepEqual(body.billing, {
      enabled: true, env: "sandbox", clientToken: "test_client_token",
      prices: [{ id: "pri_month", period: "month", label: "₴199" }, { id: "pri_year", period: "year", label: "$29" }],
    });
    assert.equal(body.telegram, "booktrip_ua");
    assert.equal(body.freeBooks, 2);
    for (const secret of [WEBHOOK_SECRET, "pdl_test_apikey", "re_secret", "v2-test-secret"]) assert.ok(!text.includes(secret));
  });
});

// ---------------------------------------------------------------------------------------------
describe("auth/start and verify", () => {
  test("503 when no mail and no dev links; validation; per-address limit", async () => {
    assert.equal((await authStart(req("/api/auth/start", { method: "POST", body: { email: "a@b.co" } }))).status, 503);
    process.env.AUTH_DEV_LINKS = "1";
    assert.equal((await authStart(req("/api/auth/start", { method: "POST", body: { email: "nope" } }))).status, 400);
    for (let i = 0; i < 5; i++) {
      assert.equal((await authStart(req("/api/auth/start", { method: "POST", body: { email: "limit@example.com" } }))).status, 200);
    }
    const sixth = await authStart(req("/api/auth/start", { method: "POST", body: { email: "LIMIT@example.com" } }));
    assert.equal(sixth.status, 429);
    assert.ok(Number(sixth.headers.get("retry-after")) > 0);
  });

  test("Resend request in the user's language, link built from SITE_URL, unsafe next dropped", async () => {
    Object.assign(process.env, { RESEND_API_KEY: "re_key", MAIL_FROM: "BookTrip <hi@booktrip.ua>", SITE_URL: "https://booktrip.ua/" });
    const calls = useFetch(() => Response.json({ id: "email_1" }));
    const res = await authStart(req("/api/auth/start", { method: "POST", body: { email: "Reader@Example.com", lang: "ru", next: "//evil.com" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const { url, init } = calls[0];
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.headers.authorization, "Bearer re_key");
    const mail = JSON.parse(init.body);
    assert.deepEqual(mail.to, ["reader@example.com"]);
    assert.equal(mail.from, "BookTrip <hi@booktrip.ua>");
    assert.equal(mail.subject, "Вход в BookTrip");
    const link = /https:\/\/booktrip\.ua\/api\/auth\/verify\?t=[A-Za-z0-9_-]+/.exec(mail.text)[0];
    assert.ok(mail.html.includes(link));
    const verify = await authVerify(req(new URL(link).pathname + new URL(link).search));
    assert.equal(verify.headers.get("location"), "/?login=ok");

    useFetch(() => Response.json({ message: "boom" }, { status: 500 }));
    assert.equal((await authStart(req("/api/auth/start", { method: "POST", body: { email: "x@example.com" } }))).status, 502);
    assert.equal(loginMail("https://x/?a=1&b=<2>", "en").html.includes("&b=<2>"), false, "link is escaped in HTML");
    assert.equal(loginMail("https://x", "de").subject, "Вхід у BookTrip", "unknown language → uk");
  });

  test("verify: forged / expired / wrong-purpose tokens → /?login=expired", async () => {
    const expired = seal("login", { email: "a@example.com", next: "/" }, -10);
    for (const t of ["", "garbage", expired, seal("session", { email: "a@example.com", next: "/" }, 60)]) {
      const res = await authVerify(req(`/api/auth/verify?t=${t}`));
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/?login=expired");
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("waitlist, events, admin", () => {
  test("waitlist validation and storage", async () => {
    assert.equal(normalizeContact("@reader_42"), "@reader_42");
    assert.equal(normalizeContact("reader_42"), "@reader_42");
    assert.equal(normalizeContact(" Reader@Example.com "), "reader@example.com");
    for (const bad of ["@abc", "@" + "a".repeat(33), "bad handle", "x@y", "", 5, "a".repeat(121) + "@example.com"]) {
      assert.equal(normalizeContact(bad), null, String(bad));
    }
    for (const body of [{ q: "", contact: "@reader" }, { q: "x".repeat(201), contact: "@reader" }, { q: "Dune", contact: "nope" }, { q: "Dune" }]) {
      assert.equal((await waitlist(req("/api/waitlist", { method: "POST", body }))).status, 400, JSON.stringify(body));
    }
    const ok = await waitlist(req("/api/waitlist", { method: "POST", body: { q: "  Dune  ", contact: "@reader_42", lang: "en" } }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    await waitlist(req("/api/waitlist", { method: "POST", body: { q: "dune", contact: "r@example.com", lang: "xx" } }));
    const [latest] = await store.lrange("waitlist", 0, 0);
    const entry = JSON.parse(latest);
    assert.equal(entry.q, "dune");
    assert.equal(entry.lang, "uk");
    assert.ok(Date.parse(entry.at));
    assert.deepEqual(await store.zrevrangeWithScores("waitlist:count", 0, 5), [{ member: "dune", score: 2 }]);
  });

  test("waitlist is rate-limited per IP", async () => {
    let last;
    for (let i = 0; i < 7; i++) last = await waitlist(req("/api/waitlist", { method: "POST", ip: "5.5.5.5", body: { q: "Dune", contact: "@reader_42" } }));
    assert.equal(last.status, 429);
  });

  test("events: whitelist, 204, counted per day; over the limit silently dropped", async () => {
    const res = await event(req("/api/event", { method: "POST", body: { name: "book_open", id: "the-hobbit" } }));
    assert.equal(res.status, 204);
    await event(req("/api/event", { method: "POST", body: { name: "book_open" } }));
    await event(req("/api/event", { method: "POST", body: { name: "install" } }));
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await store.hgetall(`ev:${day}`), { book_open: "2", install: "1" });
    for (const body of [{ name: "hack" }, { name: "search", id: "Bad Id" }, {}, { name: ["search"] }]) {
      assert.equal((await event(req("/api/event", { method: "POST", body }))).status, 400, JSON.stringify(body));
    }
    for (let i = 0; i < 125; i++) assert.equal((await event(req("/api/event", { method: "POST", ip: "6.6.6.6", body: { name: "search" } }))).status, 204);
    assert.equal((await store.hgetall(`ev:${day}`)).search, "120");
    setStoreForTests({ kind: "redis", pipeline: async () => { throw new StoreError("down"); }, exec: async () => { throw new StoreError("down"); } });
    assert.equal((await event(req("/api/event", { method: "POST", body: { name: "search" } }))).status, 204);
  });

  test("admin: 404 unset, 403 wrong token (brute-force limited), 200 report", async () => {
    assert.equal((await admin(req("/api/admin"))).status, 404);
    process.env.ADMIN_TOKEN = "adm-secret";
    assert.equal((await admin(req("/api/admin", { headers: { "x-admin-token": "nope" } }))).status, 403);
    billingEnv();
    await waitlist(req("/api/waitlist", { method: "POST", body: { q: "Dune", contact: "@reader_42" } }));
    await event(req("/api/event", { method: "POST", body: { name: "search" } }));
    await store.sadd("users", "u1", "u2");
    await store.sadd("subs", "u1", "u2");
    await store.setJson("sub:u1", { status: "active" });
    await store.setJson("sub:u2", { status: "canceled", endsAt: "2001-01-01T00:00:00Z" });
    const res = await admin(req("/api/admin", { headers: { "x-admin-token": "adm-secret" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.deepEqual(body.waitlist.top, [{ q: "dune", count: 1 }]);
    assert.equal(body.waitlist.recent[0].contact, "@reader_42");
    assert.deepEqual(body.events[new Date().toISOString().slice(0, 10)], { search: 1 });
    assert.equal(body.users, 2);
    assert.equal(body.subscribers, 1);

    for (let i = 0; i < 10; i++) await admin(req("/api/admin", { ip: "8.8.8.8", headers: { "x-admin-token": "x" } }));
    assert.equal((await admin(req("/api/admin", { ip: "8.8.8.8", headers: { "x-admin-token": "adm-secret" } }))).status, 429);
  });
});

// ---------------------------------------------------------------------------------------------
describe("SEO: /book/<id> and sitemap", () => {
  let root;
  const SHELL = `<!doctype html>
<html lang="ru" class="x">
<head>
<meta charset="utf-8">
<title>BookTrip — путешествие</title>
<meta name="description" content="Общее описание">
<meta property="og:title" content="BookTrip">
<meta property="og:description" content="Общее">
<meta property="og:type" content="website">
<meta property="og:image" content="/old.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://old/">
<link rel="stylesheet" href="/css/base.css">
</head>
<body>
<main id="main" class="m">
  <section class="view view-home"></section>
</main>
</body>
</html>`;
  const EVIL = `Evil <script>alert("x")</script> "quoted" & 'single'`;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "bt-site-"));
    await writeFile(join(root, "index.html"), SHELL);
    const books = join(root, "books");
    await import("node:fs/promises").then((fs) => fs.mkdir(books));
    const lang = (title, author) => ({ title, author, tagline: `Tag ${EVIL}`, genre: "G", summary: ["First </section> paragraph.", "Second."], terms: [{ term: "T<1>", definition: "D & d" }] });
    await writeFile(join(books, "evil-book.json"), JSON.stringify({ id: "evil-book", year: 1900, i18n: { ru: lang(`${EVIL} ру`, "Автор"), uk: lang(EVIL, "Автор \"Укр\""), en: lang(`${EVIL} en`, "Author") } }));
    await writeFile(join(root, "data-catalog.json"), "");
    await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "data")));
    await writeFile(join(root, "data", "catalog.json"), JSON.stringify([{ id: "evil-book" }, { id: "Bad Id" }, { id: "little-prince" }]));
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  const setup = () => { setProjectRootForTests(root); setDemoDirForTests(join(root, "books")); };

  test("demo book: meta replaced (not duplicated), everything escaped, SSR section after <main>", async () => {
    setup();
    const res = await bookPage(req("/api/book?id=evil-book", { headers: { "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=300, s-maxage=86400");
    assert.equal(res.headers.get("vary"), "Accept-Language");
    const html = await res.text();

    assert.match(html, /^<!doctype html>\n<html lang="ru" class="x">/);
    const count = (re) => (html.match(re) || []).length;
    assert.equal(count(/<title>/g), 1);
    assert.equal(count(/<meta name="description"/g), 1);
    assert.equal(count(/property="og:title"/g), 1);
    assert.equal(count(/property="og:image"/g), 1);
    assert.equal(count(/name="twitter:card"/g), 1);
    assert.equal(count(/rel="canonical"/g), 1);
    assert.equal(count(/hreflang=/g), 4);
    assert.ok(html.includes('<link rel="stylesheet" href="/css/base.css">'), "other tags kept");

    // nothing from the book data can open a tag or break out of an attribute
    assert.equal(count(/<script>alert/g), 0);
    assert.equal(count(/<\/section>/g), 2, "only the real section closings");
    assert.ok(html.includes("Evil &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39; ру — Автор: пересказ, персонажи, мини-фильм | BookTrip</title>"));
    assert.ok(html.includes('<link rel="canonical" href="https://booktrip.test/book/evil-book">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="en" href="https://booktrip.test/book/evil-book?lang=en">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="x-default" href="https://booktrip.test/book/evil-book">'));
    assert.ok(html.includes('<meta property="og:url" content="https://booktrip.test/book/evil-book">'));
    assert.ok(html.includes('<meta property="og:image" content="https://booktrip.test/icon.svg">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary">'));

    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
    assert.ok(ld, "JSON-LD present and contains no raw <");
    const data = JSON.parse(ld[1]);
    assert.equal(data["@type"], "Book");
    assert.equal(data.name, `${EVIL} ру`);
    assert.deepEqual(data.author, { "@type": "Person", name: "Автор" });
    assert.equal(data.inLanguage, "ru");
    assert.ok(data.description.startsWith("Tag Evil"));

    const main = html.indexOf('<main id="main" class="m">');
    const ssr = html.indexOf('<section id="ssr-book"');
    assert.ok(main > 0 && ssr > main && ssr < html.indexOf('<section class="view view-home">'));
    assert.ok(html.includes('<section id="ssr-book" class="ssr-book" lang="ru" data-id="evil-book" data-source="demo">'));
    assert.ok(html.includes("<p>First &lt;/section&gt; paragraph.</p>"));
    assert.ok(html.includes("<dt>T&lt;1&gt;</dt><dd>D &amp; d</dd>"));
    assert.ok(html.includes("<h2>Пересказ</h2>"));
  });

  test("?lang= wins and is canonical; uk default; og.png used when present", async () => {
    setup();
    await writeFile(join(root, "og.png"), "png");
    try {
      const html = await (await bookPage(req("/api/book?id=evil-book&lang=en", { headers: { "accept-language": "ru" } }))).text();
      assert.match(html, /<html lang="en"/);
      assert.ok(html.includes('<link rel="canonical" href="https://booktrip.test/book/evil-book?lang=en">'));
      assert.ok(html.includes("summary, characters, mini-film | BookTrip"));
      assert.ok(html.includes('content="https://booktrip.test/og.png"'));
      assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
      assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
      const uk = await bookPage(req("/api/book?id=evil-book"));
      assert.match(await uk.text(), /<html lang="uk"[\s\S]*переказ, персонажі, мініфільм/);
    } finally {
      await rm(join(root, "og.png"));
    }
    assert.deepEqual(pickLang(req("/x", { headers: { "accept-language": "de-DE, en;q=0.5, ru;q=0.7" } })), { lang: "ru", explicit: false });
    assert.deepEqual(pickLang(req("/x", { headers: { "accept-language": "fr" } })), { lang: "uk", explicit: false });
    assert.deepEqual(pickLang(req("/x?lang=xx", { headers: { "accept-language": "en-US" } })), { lang: "en", explicit: false });
    assert.equal(scriptJson({ a: "</script><!--\u2028" }), '{"a":"\\u003c/script\\u003e\\u003c!--\\u2028"}');
  });

  test("unknown id → plain index.html (200, noindex, short cache); live book from the store", async () => {
    setup();
    const res = await bookPage(req("/api/book?id=never-heard"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=0, s-maxage=60");
    const html = await res.text();
    assert.ok(html.includes("<title>BookTrip — путешествие</title>"));
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(!html.includes("ssr-book"));
    assert.equal((await bookPage(req("/api/book?id=../../etc"))).status, 200);

    await store.setJson("cache:book:en:dune-herbert", { id: "dune-herbert", title: "Dune", author: "Frank Herbert", tagline: "Spice.", year: 1965 });
    await store.setJson("cache:overview:en:dune-herbert", { summary: ["Paul goes to Arrakis."], themes: [], terms: [{ term: "Spice", definition: "Melange." }], similar: [] });
    const live = await (await bookPage(req("/api/book?id=dune-herbert&lang=ru"))).text();
    assert.ok(live.includes("<title>Dune — Frank Herbert: пересказ, персонажи, мини-фильм | BookTrip</title>"));
    assert.ok(live.includes('data-source="live"'));
    assert.ok(live.includes('lang="en" data-id="dune-herbert"'), "section marked with the data language");
    assert.ok(live.includes("<p>Paul goes to Arrakis.</p>"));
  });

  test("sitemap: home, demo and cached live books with hreflang; robots points to it", async () => {
    setup();
    process.env.SITE_URL = "https://booktrip.ua";
    await store.sadd("books", "dune-herbert", "evil-book", "BAD");
    const res = await sitemap(req("/api/sitemap"));
    assert.equal(res.headers.get("content-type"), "application/xml; charset=utf-8");
    const xml = await res.text();
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes("<url><loc>https://booktrip.ua/</loc></url>"));
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, ["https://booktrip.ua/", "https://booktrip.ua/book/evil-book", "https://booktrip.ua/book/little-prince", "https://booktrip.ua/book/dune-herbert"]);
    assert.ok(xml.includes('<xhtml:link rel="alternate" hreflang="uk" href="https://booktrip.ua/book/dune-herbert?lang=uk"/>'));
    const robots = await (await sitemap(req("/api/sitemap?format=robots"))).text();
    assert.match(robots, /^User-agent: \*/);
    assert.ok(robots.includes("Sitemap: https://booktrip.ua/sitemap.xml"));
  });
});
