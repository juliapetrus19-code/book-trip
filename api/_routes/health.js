// GET /api/health → which live features are configured. Never exposes secrets
// (the Paddle client-side token is public by design: Paddle.js runs in the browser with it).
import { freeBooks } from "../_lib/access.js";
import { publicBilling } from "../_lib/billing.js";
import { model } from "../_lib/claude.js";
import { json, telegramHandle } from "../_lib/http.js";
import { mailConfigured } from "../_lib/mail.js";
import { animeConfigured } from "./anime.js";
import { canSign } from "../_lib/sign.js";
import { storeKind } from "../_lib/store.js";

export async function GET() {
  const env = process.env;
  return json(
    {
      live: Boolean(env.ANTHROPIC_API_KEY),
      portraits: Boolean(env.GEMINI_API_KEY),
      video: Boolean(env.GEMINI_API_KEY && env.PREMIUM_CODE),
      premiumCodeRequired: true,
      model: model(),
      account: Boolean(canSign() && mailConfigured()),
      billing: publicBilling(),
      freeBooks: freeBooks(),
      telegram: telegramHandle(),
      store: storeKind(),
      // Anime look: "cloudflare" (our server draws catalogue books), "pollinations" (browser draws, free, no key)
      // or "off" (ANIME_PROVIDER=off → 3D only).
      anime: { provider: animeProvider() },
    },
    // Short cache: a redeploy with new env vars must show up quickly.
    { cache: "public, max-age=60, s-maxage=300" },
  );
}

function animeProvider() {
  if (String(process.env.ANIME_PROVIDER || "").toLowerCase() === "off") return "off";
  return animeConfigured() ? "cloudflare" : "pollinations";
}
