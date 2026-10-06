// Claude client + one structured-output call that returns parsed JSON or throws an HttpError.
import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./http.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

let testClient = null;
let cached = null; // { key, client }

/** Tests inject a fake `{ beta: { messages: { create } } }`; pass null to restore the real client. */
export function setClientForTests(fake) {
  testClient = fake || null;
}

export function model() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export function isConfigured() {
  return Boolean(testClient || process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (testClient) return testClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!cached || cached.key !== key) {
    // Stay inside the function's maxDuration (300 s in vercel.json).
    cached = { key, client: new Anthropic({ apiKey: key, timeout: 270_000, maxRetries: 2 }) };
  }
  return cached.client;
}

/** resolve → "low"; everything else → BOOK_EFFORT (if valid) or "medium". */
export function effortFor(kind) {
  if (kind === "resolve") return "low";
  const env = process.env.BOOK_EFFORT;
  return EFFORTS.includes(env) ? env : "medium";
}

function mapError(err, label) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error(`[claude] ${label}: auth error ${err.status}`);
    return new HttpError("not_configured", "The Anthropic API key is invalid or lacks access");
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retry = Number(err.headers?.get?.("retry-after")) || 30;
    return new HttpError("rate_limited", "The AI service is busy, please try again shortly", {
      headers: { "retry-after": String(Math.min(Math.max(1, Math.ceil(retry)), 600)) },
    });
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error(`[claude] ${label}: bad request: ${err.message}`);
    if (/credit balance/i.test(err.message || "")) {
      return new HttpError("not_configured", "The Anthropic account has no credits left");
    }
    return new HttpError("upstream", "The AI service rejected the request");
  }
  // APIConnectionError is a subclass of APIError in this SDK — check it first.
  if (err instanceof Anthropic.APIConnectionError) {
    console.error(`[claude] ${label}: connection error: ${err.message}`);
    return new HttpError("upstream", "Could not reach the AI service");
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`[claude] ${label}: API error ${err.status}: ${err.message}`);
    return new HttpError("upstream", "The AI service failed, please try again");
  }
  console.error(`[claude] ${label}: unexpected error:`, err);
  return new HttpError("upstream", "The AI service failed, please try again");
}

/**
 * One structured-output call. `system` is the large stable prompt (cached), `user` the per-request data.
 * Returns the parsed JSON object; throws HttpError (not_configured | refused | rate_limited | upstream).
 */
export async function callJson({ system, user, schema, effort = "medium", maxTokens = 16000, label = "call" }) {
  const client = getClient();
  if (!client) throw new HttpError("not_configured", "Live mode is not configured (ANTHROPIC_API_KEY is missing)");

  let msg;
  try {
    msg = await client.beta.messages.create({
      model: model(),
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Explicit breakpoint at the end of the stable system prompt: the per-request user text that
      // follows is never cached, so we do not pay cache-write premiums on it.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema } },
    });
  } catch (err) {
    throw mapError(err, label);
  }

  const u = msg.usage || {};
  console.log(`[claude] ${label} stop=${msg.stop_reason} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`);

  if (msg.stop_reason === "refusal") {
    console.warn(`[claude] ${label}: refused (category=${msg.stop_details?.category ?? "none"})`);
    throw new HttpError("refused", "The AI declined this request");
  }
  if (msg.stop_reason === "max_tokens") {
    throw new HttpError("upstream", "The AI answer was cut off, please try again");
  }
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch {
    console.error(`[claude] ${label}: invalid JSON: ${text.slice(0, 200)}`);
    throw new HttpError("upstream", "The AI returned an unreadable answer, please try again");
  }
}
