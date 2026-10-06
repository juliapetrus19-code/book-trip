// GET /api/health → which live features are configured. Never exposes secrets.
import { model } from "./_lib/claude.js";
import { json } from "./_lib/http.js";

export async function GET() {
  const env = process.env;
  return json(
    {
      live: Boolean(env.ANTHROPIC_API_KEY),
      portraits: Boolean(env.GEMINI_API_KEY),
      video: Boolean(env.GEMINI_API_KEY && env.PREMIUM_CODE),
      premiumCodeRequired: true,
      model: model(),
    },
    // Short cache: a redeploy with new env vars must show up quickly.
    { cache: "public, max-age=60, s-maxage=300" },
  );
}
