// Shared HTTP helpers for the API: JSON responses, cache headers, typed errors, query validation.
import { LANGS } from "./enums.js";

/** SPEC §3: GET responses that depend only on the query are CDN-cacheable. */
export const CACHE_PUBLIC = "public, max-age=3600, s-maxage=31536000, stale-while-revalidate=86400";
/** Negative answers (e.g. "book not found") are cached for a shorter time. */
export const CACHE_SHORT = "public, max-age=600, s-maxage=86400, stale-while-revalidate=3600";
/** Generated images never change for the same signed URL. */
export const CACHE_IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
export const NO_STORE = "no-store";

const STATUS = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  refused: 422,
  rate_limited: 429,
  server: 500,
  upstream: 502,
  not_configured: 503,
};

/** An error that maps 1:1 onto an API error response `{ error, message }`. */
export class HttpError extends Error {
  constructor(code, message, { status, headers } = {}) {
    super(message || code);
    this.code = code;
    this.status = status || STATUS[code] || 500;
    this.headers = headers || {};
  }
}

export function json(data, { status = 200, cache = NO_STORE, headers = {} } = {}) {
  return Response.json(data, {
    status,
    headers: { "cache-control": cache, "x-content-type-options": "nosniff", ...headers },
  });
}

/** Error responses are never cached. */
export function errorResponse(code, message, { status, headers = {} } = {}) {
  return json({ error: code, message: message || code }, { status: status || STATUS[code] || 500, cache: NO_STORE, headers });
}

export function toErrorResponse(err) {
  if (err instanceof HttpError) return errorResponse(err.code, err.message, { status: err.status, headers: err.headers });
  console.error("[api] unexpected error:", err && err.stack ? err.stack : err);
  return errorResponse("server", "Internal server error");
}

/** Wrap a handler so thrown HttpErrors (and bugs) become proper JSON error responses. */
export function route(handler) {
  return async function (request) {
    try {
      return await handler(request);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/** Best-effort client IP (Vercel overwrites x-forwarded-for with the real client address). */
export function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return (request.headers.get("x-real-ip") || "anon").slice(0, 64);
}

// ---------------------------------------------------------------------------------------------
// Query parameter validation. Every helper throws HttpError("bad_request") on invalid input.

// C0/C1 controls, zero-width characters, line/paragraph separators, bidi overrides/isolates, BOM.
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Single-line text: control/invisible characters removed, whitespace collapsed, trimmed. */
export function cleanText(value) {
  return String(value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

export function searchParams(request) {
  return new URL(request.url).searchParams;
}

export function textParam(params, name, { required = true, max = 200 } = {}) {
  const value = cleanText(params.get(name));
  if (!value) {
    if (required) throw new HttpError("bad_request", `Missing parameter "${name}"`);
    return "";
  }
  if (value.length > max) throw new HttpError("bad_request", `Parameter "${name}" is too long (max ${max} characters)`);
  return value;
}

export function queryParam(params) {
  return textParam(params, "q", { max: 200 });
}

/** lang ∈ ru|uk|en; missing → "en". */
export function langParam(params) {
  const raw = params.get("lang");
  if (raw == null || raw === "") return "en";
  if (!LANGS.includes(raw)) throw new HttpError("bad_request", `Parameter "lang" must be one of ${LANGS.join(", ")}`);
  return raw;
}

export const ID_RE = /^[a-z0-9-]{1,100}$/;

export function idParam(params, name = "id") {
  const raw = params.get(name);
  if (!raw) throw new HttpError("bad_request", `Missing parameter "${name}"`);
  if (!ID_RE.test(raw)) throw new HttpError("bad_request", `Parameter "${name}" must match [a-z0-9-]{1,100}`);
  return raw;
}

/** The common book identity used by overview / characters / film. */
export function bookParams(params) {
  return {
    id: idParam(params, "id"),
    title: textParam(params, "title", { max: 200 }),
    author: textParam(params, "author", { required: false, max: 200 }),
    lang: langParam(params),
  };
}

/**
 * Parse `cast=id:Name,id:Name…`. A token without a valid `id:` prefix is treated as the continuation
 * of the previous name (so a name containing a comma survives). Returns [{ id, name }], 1–14 items.
 */
export function castParam(params) {
  const raw = params.get("cast");
  if (!raw) throw new HttpError("bad_request", 'Missing parameter "cast" (id:Name,id:Name…)');
  if (raw.length > 2000) throw new HttpError("bad_request", 'Parameter "cast" is too long');
  const cast = [];
  for (const token of raw.split(",")) {
    const m = /^\s*([a-z0-9-]{1,60})\s*:(.*)$/.exec(token);
    if (m) cast.push({ id: m[1], name: cleanText(m[2]).slice(0, 80) });
    else if (cast.length && cleanText(token)) cast[cast.length - 1].name = `${cast[cast.length - 1].name}, ${cleanText(token)}`.slice(0, 80);
  }
  const seen = new Set();
  const unique = cast.filter((c) => c.name && !seen.has(c.id) && seen.add(c.id));
  if (!unique.length) throw new HttpError("bad_request", 'Parameter "cast" has no valid "id:Name" entries');
  return unique.slice(0, 14);
}
