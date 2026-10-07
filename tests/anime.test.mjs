// Anime look: shared prompt builder + /api/anime (Cloudflare Workers AI is mocked; no network).
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ANIME_AVOID, ANIME_STYLE, portraitPromptFor, scenePromptFor, seedFor } from "../js/anime-prompts.js";
import { setFetchForTests } from "../api/_lib/fetch.js";
import { createMemoryStore, setStoreForTests } from "../api/_lib/store.js";
import { resetRateLimits } from "../api/_lib/ratelimit.js";
import { GET as anime, demoAnimeJob } from "../api/anime.js";

const hobbit = JSON.parse(await readFile(new URL("../data/books/the-hobbit.json", import.meta.url), "utf8"));
const req = (qs) => new Request(`http://localhost/api/anime?${qs}`, { headers: { "x-forwarded-for": "1.2.3.4" } });
const ENV = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "ANIME_DAILY_CAP"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  setStoreForTests(createMemoryStore());
  resetRateLimits();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setFetchForTests(null);
  setStoreForTests(null);
});

describe("anime prompts", () => {
  const cast = new Map(hobbit.characters.map((c) => [c.id, c]));
  const meta = { title: hobbit.i18n.en.title };

  test("portrait prompt: style, character description, no-text guard", () => {
    const p = portraitPromptFor(meta, hobbit.characters[0]);
    assert.ok(p.startsWith(ANIME_STYLE));
    assert.ok(p.includes("hobbit"));
    assert.ok(p.endsWith(`${ANIME_AVOID}.`));
    assert.ok(p.length < 1200);
  });

  test("scene prompt: place, cast, third-person moment only", () => {
    const sc = hobbit.film.scenes[1];
    const p = scenePromptFor(meta, sc, cast, { frame: 0, narrationEn: "You stand by a lake. A hobbit plays riddles with Gollum." });
    assert.ok(p.includes("a dark cave"));
    assert.ok(!/\byou\b/i.test(p.replace(ANIME_STYLE, "")), "second-person sentences are dropped");
    assert.ok(p.includes("riddles"));
    assert.ok(p.length < 2048);
    const close = scenePromptFor(meta, sc, cast, { frame: 1 });
    assert.notEqual(close, p);
  });

  test("seeds are stable and differ per key", () => {
    assert.equal(seedFor("a/b"), seedFor("a/b"));
    assert.notEqual(seedFor("a/b"), seedFor("a/c"));
    assert.ok(seedFor("x") >= 0 && seedFor("x") < 2147483647);
  });

  test("every demo book builds prompts for every character and frame", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL("../data/books/", import.meta.url))).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      for (const c of JSON.parse(await readFile(new URL(`../data/books/${f}`, import.meta.url), "utf8")).characters) {
        const job = await demoAnimeJob(new URLSearchParams({ demo: id, char: c.id }));
        assert.ok(job.prompt.length > 100 && job.prompt.length <= 2048, `${id}/${c.id}`);
      }
      const job = await demoAnimeJob(new URLSearchParams({ demo: id, scene: "0", frame: "1" }));
      assert.ok(job.prompt.length <= 2048, `${id} scene`);
    }
  });
});

describe("/api/anime", () => {
  const configure = () => { process.env.CLOUDFLARE_ACCOUNT_ID = "acc"; process.env.CLOUDFLARE_API_TOKEN = "tok"; };
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  test("503 when Cloudflare is not configured", async () => {
    const res = await anime(req("demo=the-hobbit&char=bilbo"));
    assert.equal(res.status, 503);
  });

  test("draws a portrait: prompt from the data file, JPEG out, CDN-cacheable", async () => {
    configure();
    let call = null;
    setFetchForTests(async (url, init) => {
      call = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return Response.json({ success: true, result: { image: JPEG.toString("base64") } });
    });
    const res = await anime(req("demo=the-hobbit&char=bilbo"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.match(res.headers.get("cache-control"), /s-maxage=/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
    assert.match(call.url, /\/accounts\/acc\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
    assert.equal(call.auth, "Bearer tok");
    assert.ok(call.body.prompt.includes("hobbit"));
    assert.equal(call.body.seed, seedFor("the-hobbit/bilbo"));
  });

  test("scene frames, unknown ids and bad params", async () => {
    configure();
    setFetchForTests(async () => Response.json({ success: true, result: { image: JPEG.toString("base64") } }));
    assert.equal((await anime(req("demo=the-hobbit&scene=0&frame=1"))).status, 200);
    assert.equal((await anime(req("demo=the-hobbit&scene=99&frame=0"))).status, 404);
    assert.equal((await anime(req("demo=no-such-book&char=x"))).status, 404);
    assert.equal((await anime(req("demo=the-hobbit&char=nobody"))).status, 404);
    assert.equal((await anime(req("demo=../etc&char=x"))).status, 400);
    assert.equal((await anime(req("char=bilbo"))).status, 400);
  });

  test("upstream failure → 502, daily cap → 429", async () => {
    configure();
    setFetchForTests(async () => Response.json({ success: false, errors: [{ message: "boom" }] }, { status: 500 }));
    assert.equal((await anime(req("demo=the-hobbit&char=bilbo"))).status, 502);
    process.env.ANIME_DAILY_CAP = "1";
    setFetchForTests(async () => Response.json({ success: true, result: { image: JPEG.toString("base64") } }));
    assert.equal((await anime(req("demo=the-hobbit&char=gandalf"))).status, 429, "cap counts the failed call too");
  });
});
