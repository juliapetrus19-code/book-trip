// Premium AI video (Veo), three 8-second clips per book:
//   POST /api/video  body { id, title, prompts:[3], token }, header x-premium-code → { jobs: [opId, …] }
//   GET  /api/video?op=<opId>    → { done: false } | { done: true, url: "/api/video?file=<signed>" }
//   GET  /api/video?file=<signed> → streams video/mp4
// opIds and file references are sealed (encrypted + authenticated + expiring): clients never see
// Google operation names, file URIs or the API key.
import { OP_NAME_RE, VIDEO_SAFETY, VIDEO_STYLE, downloadFile, getOperation, isConfigured, isGoogleApiUrl, startVideo } from "./_lib/gemini.js";
import { HttpError, NO_STORE, clientIp, cleanText, json, route, searchParams, ID_RE } from "./_lib/http.js";
import { enforce, hit, isLimited, tooManyError } from "./_lib/ratelimit.js";
import { safeEqual, seal, unseal, verify } from "./_lib/sign.js";

const OP_TTL = 6 * 3600;    // a job can be polled for 6 hours
const FILE_TTL = 47 * 3600; // Google keeps generated files for 48 hours
const MAX_BODY = 20_000;
const MAX_PROMPT = 1500;

function requireVideo() {
  if (!isConfigured()) throw new HttpError("not_configured", "Video is not configured (GEMINI_API_KEY is missing)");
}

export const POST = route(async (request) => {
  const code = process.env.PREMIUM_CODE;
  if (!code) throw new HttpError("forbidden", "premium disabled");
  requireVideo();

  // Brute-force guard: too many wrong codes from one IP blocks further attempts for a while.
  const ip = clientIp(request);
  const blocked = isLimited("premium_fail", ip);
  if (blocked) throw tooManyError(blocked);
  if (!safeEqual((request.headers.get("x-premium-code") || "").trim(), code.trim())) {
    hit("premium_fail", ip);
    throw new HttpError("forbidden", "Invalid premium code");
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError("payload_too_large", "Request body is too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError("bad_request", "Body must be JSON: { id, title, prompts, token }");
  }
  const id = body && body.id;
  const prompts = body && body.prompts;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError("bad_request", 'Field "id" must match [a-z0-9-]{1,100}');
  if (!Array.isArray(prompts) || prompts.length !== 3 || !prompts.every((p) => typeof p === "string" && p.trim() && p.length <= MAX_PROMPT)) {
    throw new HttpError("bad_request", 'Field "prompts" must be exactly 3 non-empty strings');
  }
  if (!verify("video", [id, ...prompts], body.token)) throw new HttpError("forbidden", "Invalid video token");

  enforce(request, "video");
  const title = cleanText(body.title).slice(0, 120);
  console.log(`[video] starting 3 clips for ${id}${title ? ` (${title})` : ""}`);

  const started = await Promise.allSettled(
    prompts.map((p) => startVideo(`${VIDEO_STYLE} ${cleanText(p)} ${VIDEO_SAFETY}`)),
  );
  const jobs = started.filter((r) => r.status === "fulfilled").map((r) => seal("video-op", { n: r.value, b: id }, OP_TTL));
  if (!jobs.length) throw started[0].reason;
  return json({ jobs }, { cache: NO_STORE });
});

export const GET = route(async (request) => {
  const params = searchParams(request);

  if (params.has("op")) {
    const job = unseal("video-op", params.get("op"));
    if (!job || typeof job.n !== "string" || !OP_NAME_RE.test(job.n)) throw new HttpError("bad_request", "Invalid or expired video job");
    requireVideo();
    enforce(request, "poll");
    const op = await getOperation(job.n);
    if (!op.done) return json({ done: false }, { cache: NO_STORE });
    return json({ done: true, url: `/api/video?file=${seal("video-file", { u: op.uri }, FILE_TTL)}` }, { cache: NO_STORE });
  }

  if (params.has("file")) {
    const file = unseal("video-file", params.get("file"));
    if (!file || typeof file.u !== "string" || !isGoogleApiUrl(file.u)) throw new HttpError("not_found", "This video link is invalid or has expired");
    requireVideo();
    enforce(request, "file");
    const upstream = await downloadFile(file.u, { range: request.headers.get("range") });
    const headers = {
      "content-type": "video/mp4",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
    };
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
  }

  throw new HttpError("bad_request", 'Use ?op=<job> or ?file=<file>, or POST to start a video');
});
