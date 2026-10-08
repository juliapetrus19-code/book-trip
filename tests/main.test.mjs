// api/main.js — the single Vercel Function that routes every /api/* request (Hobby plan: ≤ 12 functions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { GET, POST, routeOf } from "../api/main.js";

const req = (path, init) => new Request(`http://localhost${path}`, init);

test("only api/main.js is a deployable function", async () => {
  const top = (await readdir(new URL("../api/", import.meta.url), { withFileTypes: true }))
    .filter((e) => !e.name.startsWith("_"))
    .map((e) => e.name);
  assert.deepEqual(top, ["main.js"]);
});

test("route from ?route= (Vercel rewrite) or from the path", () => {
  assert.equal(routeOf(req("/api/main?route=health")), "health");
  assert.equal(routeOf(req("/api/health")), "health");
  assert.equal(routeOf(req("/api/auth/start/")), "auth/start");
  assert.equal(routeOf(req("/book/the-hobbit?route=book&id=the-hobbit")), "book");
  assert.equal(routeOf(req("/api/_lib/http")), null);
  assert.equal(routeOf(req("/api/main?route=../etc")), null);
  assert.equal(routeOf(req("/api/main?route=constructor")), null);
});

test("dispatches to the handler, 404 for unknown routes, 405 for wrong methods", async () => {
  const health = await GET(req("/api/main?route=health"));
  assert.equal(health.status, 200);
  assert.equal(typeof (await health.json()).live, "boolean");
  const missing = await GET(req("/api/nope"));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not_found");
  const wrong = await POST(req("/api/health", { method: "POST" }));
  assert.equal(wrong.status, 405);
  const book = await GET(req("/book/the-hobbit?route=book&id=the-hobbit"));
  assert.equal(book.status, 200);
  assert.match(await book.text(), /<title>[^<]*Hobbit|<title>[^<]*Гобіт|<title>[^<]*Хоббит/);
});
