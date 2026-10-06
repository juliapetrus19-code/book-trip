// Google Gemini API (images + Veo video) over REST. The API key never leaves the server:
// clients only ever see sealed operation/file references (see sign.js).
import { HttpError } from "./http.js";

const API = "https://generativelanguage.googleapis.com/v1beta/";
const API_HOST = "generativelanguage.googleapis.com";
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,80}$/;
/** Long-running operation names, e.g. "models/veo-3.1-fast-generate-preview/operations/abc123". */
export const OP_NAME_RE = /^models\/[a-z0-9][a-z0-9.-]{0,80}\/operations\/[a-zA-Z0-9_-]{1,128}$/;

/** Fixed style preamble for portraits; the signed per-character look description follows it. */
export const PORTRAIT_STYLE = "Cute chunky 3D voxel diorama character figurine, soft studio lighting, warm grey backdrop, small grass tile base, full body, centered, no text";
/** Fixed style frame for video clips; the signed scene prompt goes in the middle. */
export const VIDEO_STYLE = "Cute chunky 3D voxel diorama animation: a miniature toy-like world built from small cubes, soft warm lighting, gentle depth of field.";
export const VIDEO_SAFETY = "No text, letters, subtitles or logos on screen; no real people.";

let fetchImpl = null;

/** Tests inject a fake `fetch(url, init)`; pass null to restore the global fetch. */
export function setFetchForTests(fn) {
  fetchImpl = fn || null;
}

const doFetch = (url, init) => (fetchImpl || globalThis.fetch)(url, init);

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError("not_configured", "Images and video are not configured (GEMINI_API_KEY is missing)");
  return key;
}

function modelName(envValue, fallback) {
  return envValue && MODEL_RE.test(envValue) ? envValue : fallback;
}

export const imageModel = () => modelName(process.env.GEMINI_IMAGE_MODEL, "gemini-2.5-flash-image");
export const videoModel = () => modelName(process.env.GEMINI_VIDEO_MODEL, "veo-3.1-fast-generate-preview");

/** Only Google's own API host may be contacted with our key (SSRF guard). */
export function isGoogleApiUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === API_HOST && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

async function errorFrom(res, label) {
  let message = "";
  try {
    const body = await res.json();
    message = String(body?.error?.message || body?.error?.status || "").slice(0, 300);
  } catch { /* not JSON */ }
  console.error(`[gemini] ${label}: HTTP ${res.status} ${message}`);
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(message))) {
    return new HttpError("not_configured", "The Gemini API key is invalid or lacks access");
  }
  if (res.status === 429) {
    return new HttpError("rate_limited", "The image/video service is busy, please try again shortly", { headers: { "retry-after": "60" } });
  }
  if (res.status === 400 && /safety|blocked|prohibited|responsible ai|sensitive/i.test(message)) {
    return new HttpError("refused", "The image/video model declined this request");
  }
  return new HttpError("upstream", "The image/video service failed, please try again");
}

/** fetch() with our key, a timeout and network errors mapped to HttpError. */
async function call(url, { method = "GET", body, headers = {}, timeoutMs = 60_000, label }) {
  const init = {
    method,
    headers: { "x-goog-api-key": apiKey(), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  };
  let res;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    console.error(`[gemini] ${label}: network error: ${err && err.name} ${err && err.message}`);
    throw new HttpError("upstream", "Could not reach the image/video service");
  }
  if (!res.ok) throw await errorFrom(res, label);
  return res;
}

async function readJson(res, label) {
  try {
    return await res.json();
  } catch {
    console.error(`[gemini] ${label}: response is not JSON`);
    throw new HttpError("upstream", "The image/video service returned an unreadable answer");
  }
}

// ---------------------------------------------------------------------------------------------
// Images

/** Generate one portrait. Returns { mimeType, bytes: Buffer }. */
export async function generateImage(prompt, { aspectRatio = "3:4" } = {}) {
  const label = "image";
  const res = await call(`${API}models/${imageModel()}:generateContent`, {
    method: "POST",
    label,
    timeoutMs: 100_000,
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
    },
  });
  const data = await readJson(res, label);
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const part = parts.find((p) => p && (p.inlineData || p.inline_data));
  if (!part) {
    const reason = data?.promptFeedback?.blockReason || candidate?.finishReason || "none";
    console.warn(`[gemini] ${label}: no image (reason=${reason})`);
    if (/SAFETY|BLOCK|PROHIBITED|RECITATION|IMAGE_OTHER/i.test(String(reason))) {
      throw new HttpError("refused", "The image model declined this portrait");
    }
    throw new HttpError("upstream", "The image model returned no image, please try again");
  }
  const inline = part.inlineData || part.inline_data;
  const mimeType = String(inline.mimeType || inline.mime_type || "image/png").toLowerCase();
  if (!/^image\/(png|jpeg|webp)$/.test(mimeType)) throw new HttpError("upstream", "The image model returned an unsupported format");
  const bytes = Buffer.from(String(inline.data || ""), "base64");
  if (bytes.length < 100) throw new HttpError("upstream", "The image model returned an empty image");
  return { mimeType, bytes };
}

// ---------------------------------------------------------------------------------------------
// Video (Veo long-running operations)

/** Start one 8-second clip. Returns the operation name (validated). */
export async function startVideo(prompt) {
  const label = "video:start";
  const res = await call(`${API}models/${videoModel()}:predictLongRunning`, {
    method: "POST",
    label,
    timeoutMs: 60_000,
    body: {
      instances: [{ prompt }],
      parameters: { aspectRatio: "16:9", durationSeconds: 8, resolution: "720p" },
    },
  });
  const data = await readJson(res, label);
  const name = typeof data?.name === "string" ? data.name : "";
  if (!OP_NAME_RE.test(name)) {
    console.error(`[gemini] ${label}: unexpected operation name`);
    throw new HttpError("upstream", "The video service returned an unexpected answer");
  }
  return name;
}

/** Poll an operation: { done: false } | { done: true, uri }. Throws HttpError when it failed. */
export async function getOperation(name) {
  if (!OP_NAME_RE.test(name)) throw new HttpError("bad_request", "Invalid video job");
  const label = "video:poll";
  const res = await call(`${API}${name}`, { label, timeoutMs: 30_000 });
  const data = await readJson(res, label);
  if (!data?.done) return { done: false };
  if (data.error) {
    const message = String(data.error.message || "");
    console.error(`[gemini] ${label}: operation failed: ${data.error.code} ${message.slice(0, 300)}`);
    if (/safety|blocked|responsible ai|filtered|sensitive|celebrity|prohibited/i.test(message)) {
      throw new HttpError("refused", "The video model declined this clip");
    }
    throw new HttpError("upstream", "The video could not be generated, please try again");
  }
  const result = data.response?.generateVideoResponse || data.response?.generate_video_response || {};
  const samples = result.generatedSamples || result.generated_samples || [];
  const uri = samples[0]?.video?.uri;
  if (typeof uri !== "string" || !isGoogleApiUrl(uri)) {
    const filtered = result.raiMediaFilteredCount || result.rai_media_filtered_count;
    console.error(`[gemini] ${label}: no usable video (filtered=${filtered || 0})`);
    if (filtered) throw new HttpError("refused", "The video model declined this clip");
    throw new HttpError("upstream", "The video service returned no video");
  }
  return { done: true, uri };
}

/** Download a generated file (follows Google's redirect). Returns the upstream Response to stream. */
export async function downloadFile(uri, { range } = {}) {
  if (!isGoogleApiUrl(uri)) throw new HttpError("bad_request", "Invalid video file");
  const headers = range && /^bytes=\d*-\d*$/.test(range) ? { range } : {};
  return call(uri, { label: "video:download", timeoutMs: 280_000, headers });
}
