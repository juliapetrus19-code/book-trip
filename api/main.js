// The one Vercel Function behind every /api/* route (plus /book/<id>, /sitemap.xml and /robots.txt).
// Vercel's Hobby plan allows at most 12 functions per deployment, so the handlers live in api/_routes/
// (folders starting with "_" are not deployed as functions) and vercel.json rewrites requests here:
//   /api/<route>…  → /api/main?route=<route>
// The route comes from ?route= (set by the rewrite) or, failing that, from the path after /api/.
// Each loader is a literal import() so the bundler traces and ships every handler file.
import { HttpError, toErrorResponse } from "./_lib/http.js";

const ROUTES = {
  health: () => import("./_routes/health.js"),
  me: () => import("./_routes/me.js"),
  access: () => import("./_routes/access.js"),
  waitlist: () => import("./_routes/waitlist.js"),
  event: () => import("./_routes/event.js"),
  admin: () => import("./_routes/admin.js"),
  book: () => import("./_routes/book.js"),
  sitemap: () => import("./_routes/sitemap.js"),
  resolve: () => import("./_routes/resolve.js"),
  overview: () => import("./_routes/overview.js"),
  characters: () => import("./_routes/characters.js"),
  film: () => import("./_routes/film.js"),
  portrait: () => import("./_routes/portrait.js"),
  video: () => import("./_routes/video.js"),
  anime: () => import("./_routes/anime.js"),
  "auth/start": () => import("./_routes/auth/start.js"),
  "auth/verify": () => import("./_routes/auth/verify.js"),
  "auth/logout": () => import("./_routes/auth/logout.js"),
  "billing/checkout": () => import("./_routes/billing/checkout.js"),
  "billing/portal": () => import("./_routes/billing/portal.js"),
  "billing/webhook": () => import("./_routes/billing/webhook.js"),
};

/** Route name of a request: ?route= wins, else the path after /api/ (trailing slashes ignored). */
export function routeOf(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("route");
  const name = (fromQuery || url.pathname.replace(/^\/api\//, "")).replace(/^\/+|\/+$/g, "");
  return Object.hasOwn(ROUTES, name) ? name : null;
}

async function dispatch(request) {
  try {
    const name = routeOf(request);
    if (!name) throw new HttpError("not_found", "Unknown API route");
    const mod = await ROUTES[name]();
    const method = request.method === "HEAD" && !mod.HEAD ? "GET" : request.method;
    const handler = mod[method];
    if (typeof handler !== "function") {
      const allow = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function").join(", ");
      throw new HttpError("method_not_allowed", "Method not allowed", { headers: { allow } });
    }
    return await handler(request);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const HEAD = dispatch;
export const OPTIONS = dispatch;
