// Tiny key-value store: Upstash Redis over its REST API (global fetch, no SDK), or an in-memory
// fallback with the same command subset when no Redis is configured (dev, tests, demo deploys).
// Both backends speak raw Redis commands (["SET", key, value, "EX", 60]) and return REST-shaped
// results; the Store wrapper normalises them. Redis errors throw StoreError — callers decide whether
// a failure is a cache miss (reads), ignorable (counters) or fatal.
import { httpFetch } from "./fetch.js";

export class StoreError extends Error {}

const TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------------------------
// Upstash REST backend

function redisBackend(url, token) {
  const base = url.replace(/\/+$/, "");
  async function post(path, body) {
    let res;
    try {
      res = await httpFetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }, TIMEOUT_MS);
    } catch (err) {
      throw new StoreError(`redis unreachable: ${err && err.message}`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok && !Array.isArray(data)) throw new StoreError(`redis HTTP ${res.status}: ${(data && data.error) || "error"}`);
    return data;
  }
  return {
    kind: "redis",
    async exec(args) {
      const data = await post("", args.map(String));
      if (!data || data.error) throw new StoreError(`redis: ${(data && data.error) || "bad response"}`);
      return data.result;
    },
    async pipeline(commands) {
      if (!commands.length) return [];
      const data = await post("/pipeline", commands.map((c) => c.map(String)));
      if (!Array.isArray(data)) throw new StoreError("redis: bad pipeline response");
      return data.map((r) => {
        if (!r || r.error) throw new StoreError(`redis: ${(r && r.error) || "bad response"}`);
        return r.result;
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// In-memory backend (same command subset, same result shapes as Upstash REST)

const MAX_MEMORY_KEYS = 50_000;

function memoryBackend() {
  const data = new Map(); // key → { type, value, exp }

  const live = (key) => {
    const entry = data.get(key);
    if (entry && entry.exp && entry.exp <= Date.now()) { data.delete(key); return undefined; }
    return entry;
  };
  const typed = (key, type, create) => {
    const entry = live(key);
    if (entry) {
      if (entry.type !== type) throw new StoreError("WRONGTYPE Operation against a key holding the wrong kind of value");
      return entry;
    }
    if (!create) return undefined;
    if (data.size >= MAX_MEMORY_KEYS) data.delete(data.keys().next().value);
    const fresh = { type, value: create(), exp: 0 };
    data.set(key, fresh);
    return fresh;
  };
  const range = (len, start, stop) => {
    let s = Number(start), e = Number(stop);
    if (s < 0) s = Math.max(0, len + s);
    if (e < 0) e = len + e;
    return [s, Math.min(e, len - 1)];
  };
  const num = (n) => (Number.isInteger(n) ? n : Number(n));
  const fmt = (n) => String(n);

  const commands = {
    GET: (k) => { const e = typed(k, "string"); return e ? e.value : null; },
    MGET: (...keys) => keys.map((k) => { const e = live(k); return e && e.type === "string" ? e.value : null; }),
    SET: (k, v, ...opts) => {
      const upper = opts.map((o) => String(o).toUpperCase());
      if (upper.includes("NX") && live(k)) return null;
      const exIdx = upper.indexOf("EX");
      const exp = exIdx >= 0 ? Date.now() + Number(opts[exIdx + 1]) * 1000 : 0;
      data.set(k, { type: "string", value: String(v), exp });
      return "OK";
    },
    DEL: (...keys) => keys.reduce((n, k) => n + (live(k) && data.delete(k) ? 1 : 0), 0),
    INCR: (k) => {
      const e = typed(k, "string", () => "0");
      const n = Number(e.value);
      if (!Number.isInteger(n)) throw new StoreError("ERR value is not an integer");
      e.value = String(n + 1);
      return n + 1;
    },
    EXPIRE: (k, sec) => { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(sec) * 1000; return 1; },
    TTL: (k) => { const e = live(k); if (!e) return -2; return e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1; },
    SADD: (k, ...m) => { const s = typed(k, "set", () => new Set()).value; let n = 0; for (const x of m) if (!s.has(String(x))) { s.add(String(x)); n++; } return n; },
    SREM: (k, ...m) => { const e = typed(k, "set"); if (!e) return 0; let n = 0; for (const x of m) if (e.value.delete(String(x))) n++; if (!e.value.size) data.delete(k); return n; },
    SCARD: (k) => { const e = typed(k, "set"); return e ? e.value.size : 0; },
    SMEMBERS: (k) => { const e = typed(k, "set"); return e ? [...e.value] : []; },
    SISMEMBER: (k, m) => { const e = typed(k, "set"); return e && e.value.has(String(m)) ? 1 : 0; },
    SUNIONSTORE: (dest, ...keys) => {
      const union = new Set();
      for (const k of keys) { const e = typed(k, "set"); if (e) for (const x of e.value) union.add(x); }
      data.delete(dest);
      if (union.size) data.set(dest, { type: "set", value: union, exp: 0 });
      return union.size;
    },
    LPUSH: (k, ...v) => { const l = typed(k, "list", () => []).value; for (const x of v) l.unshift(String(x)); return l.length; },
    LTRIM: (k, start, stop) => {
      const e = typed(k, "list");
      if (!e) return "OK";
      const [s, t] = range(e.value.length, start, stop);
      e.value = s > t ? [] : e.value.slice(s, t + 1);
      return "OK";
    },
    LRANGE: (k, start, stop) => {
      const e = typed(k, "list");
      if (!e) return [];
      const [s, t] = range(e.value.length, start, stop);
      return s > t ? [] : e.value.slice(s, t + 1);
    },
    ZINCRBY: (k, inc, m) => { const z = typed(k, "zset", () => new Map()).value; const v = (z.get(String(m)) || 0) + Number(inc); z.set(String(m), v); return fmt(v); },
    ZREVRANGE: (k, start, stop, withScores) => {
      const e = typed(k, "zset");
      if (!e) return [];
      // Redis orders equal scores by member, descending, for ZREVRANGE.
      const sorted = [...e.value].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
      const [s, t] = range(sorted.length, start, stop);
      const slice = s > t ? [] : sorted.slice(s, t + 1);
      return String(withScores || "").toUpperCase() === "WITHSCORES" ? slice.flatMap(([m, v]) => [m, fmt(v)]) : slice.map(([m]) => m);
    },
    HINCRBY: (k, f, inc) => { const h = typed(k, "hash", () => new Map()).value; const v = num(h.get(String(f)) || 0) + Number(inc); h.set(String(f), String(v)); return v; },
    HGETALL: (k) => { const e = typed(k, "hash"); return e ? [...e.value].flat() : []; },
  };

  async function exec(args) {
    const [name, ...rest] = args;
    const fn = commands[String(name).toUpperCase()];
    if (!fn) throw new StoreError(`memory store: unsupported command ${name}`);
    return fn(...rest.map(String));
  }
  return {
    kind: "memory",
    exec,
    async pipeline(cmds) {
      const out = [];
      for (const c of cmds) out.push(await exec(c));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Typed wrapper

const pairs = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

class Store {
  constructor(backend) {
    this.backend = backend;
    this.kind = backend.kind;
  }
  exec(...args) { return this.backend.exec(args); }
  pipeline(commands) { return this.backend.pipeline(commands); }

  async get(key) { const v = await this.exec("GET", key); return v == null ? null : String(v); }
  async getJson(key) {
    const v = await this.get(key);
    if (v == null) return null;
    try { return JSON.parse(v); } catch { return null; }
  }
  async mget(keys) { return keys.length ? (await this.exec("MGET", ...keys)).map((v) => (v == null ? null : String(v))) : []; }
  async mgetJson(keys) {
    return (await this.mget(keys)).map((v) => { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } });
  }
  /** `ex` = seconds to live; `nx` = only when missing. Returns true when written. */
  async set(key, value, { ex, nx } = {}) {
    const args = ["SET", key, value];
    if (ex) args.push("EX", Math.max(1, Math.floor(ex)));
    if (nx) args.push("NX");
    return (await this.exec(...args)) === "OK";
  }
  setJson(key, value, opts) { return this.set(key, JSON.stringify(value), opts); }
  async del(key) { return Number(await this.exec("DEL", key)); }
  async incr(key) { return Number(await this.exec("INCR", key)); }
  async expire(key, seconds) { return Number(await this.exec("EXPIRE", key, Math.max(1, Math.floor(seconds)))); }
  async sadd(key, ...members) { return Number(await this.exec("SADD", key, ...members)); }
  async srem(key, ...members) { return Number(await this.exec("SREM", key, ...members)); }
  async scard(key) { return Number(await this.exec("SCARD", key)); }
  async smembers(key) { return ((await this.exec("SMEMBERS", key)) || []).map(String); }
  async sismember(key, member) { return Number(await this.exec("SISMEMBER", key, member)) === 1; }
  async sunionstore(dest, ...keys) { return Number(await this.exec("SUNIONSTORE", dest, ...keys)); }
  async lpush(key, ...values) { return Number(await this.exec("LPUSH", key, ...values)); }
  async ltrim(key, start, stop) { await this.exec("LTRIM", key, start, stop); }
  async lrange(key, start, stop) { return ((await this.exec("LRANGE", key, start, stop)) || []).map(String); }
  async zincrby(key, increment, member) { return Number(await this.exec("ZINCRBY", key, increment, member)); }
  /** Highest scores first → [{ member, score }]. */
  async zrevrangeWithScores(key, start, stop) {
    return pairs(await this.exec("ZREVRANGE", key, start, stop, "WITHSCORES")).map(([member, score]) => ({ member: String(member), score: Number(score) }));
  }
  async hincrby(key, field, increment = 1) { return Number(await this.exec("HINCRBY", key, field, increment)); }
  async hgetall(key) {
    const raw = await this.exec("HGETALL", key);
    // Upstash returns a flat [field, value, …] array; tolerate an object too.
    if (raw && !Array.isArray(raw) && typeof raw === "object") return { ...raw };
    return Object.fromEntries(pairs(raw).map(([f, v]) => [String(f), String(v)]));
  }
}

// ---------------------------------------------------------------------------------------------
// Selection

let testStore = null;
let current = null; // { id, store }
let memory = null;  // one memory store per process, so it survives env lookups

export function createMemoryStore() {
  return new Store(memoryBackend());
}

/** Exposed for tests of the REST wiring (with setFetchForTests). */
export function createRedisStore(url, token) {
  return new Store(redisBackend(url, token));
}

/** Tests inject a store (e.g. createMemoryStore()); pass null to restore env-based selection. */
export function setStoreForTests(store) {
  testStore = store || null;
}

function redisEnv() {
  const e = process.env;
  const url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  return url && token && /^https:\/\//.test(url) ? { url, token } : null;
}

export function getStore() {
  if (testStore) return testStore;
  const conf = redisEnv();
  if (!conf) {
    if (!memory) memory = createMemoryStore();
    return memory;
  }
  const id = `${conf.url}|${conf.token}`;
  if (!current || current.id !== id) current = { id, store: createRedisStore(conf.url, conf.token) };
  return current.store;
}

/** "redis" | "memory" — reported by /api/health. */
export function storeKind() {
  return getStore().kind;
}

/** Run `fn(store)`; on a store failure log it and return `fallback` instead of throwing. */
export async function soft(label, fn, fallback = null) {
  try {
    return await fn(getStore());
  } catch (err) {
    console.error(`[store] ${label}: ${err && err.message ? err.message : err}`);
    return fallback;
  }
}
