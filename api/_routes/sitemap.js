// GET /sitemap.xml (rewrite → /api/sitemap): home + every demo book + live books with a cached
// overview, each book with hreflang alternates (?lang=uk|ru|en).
// GET /robots.txt (rewrite → /api/sitemap?format=robots): robots rules with the absolute sitemap URL
// (robots.txt needs a full URL, which a static file cannot know before the domain is chosen).
import { liveBooks } from "../_lib/cache.js";
import { LANGS } from "../_lib/enums.js";
import { readProjectFile } from "../_lib/files.js";
import { ID_RE, route, searchParams, siteOrigin } from "../_lib/http.js";

const CACHE = "public, max-age=3600, s-maxage=3600";
const MAX_URLS = 45_000; // the sitemap protocol allows 50 000

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

export async function demoIds() {
  const raw = await readProjectFile("data/catalog.json");
  try {
    const list = JSON.parse(raw || "[]");
    return (Array.isArray(list) ? list : []).map((b) => b && b.id).filter((id) => typeof id === "string" && ID_RE.test(id));
  } catch {
    console.error("[sitemap] data/catalog.json is not valid JSON");
    return [];
  }
}

export function renderSitemap(origin, ids) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    `<url><loc>${xml(origin + "/")}</loc></url>`,
  ];
  for (const id of ids) {
    const base = `${origin}/book/${id}`;
    out.push(`<url><loc>${xml(base)}</loc>`);
    for (const l of LANGS) out.push(`  <xhtml:link rel="alternate" hreflang="${l}" href="${xml(`${base}?lang=${l}`)}"/>`);
    out.push(`  <xhtml:link rel="alternate" hreflang="x-default" href="${xml(base)}"/>`, "</url>");
  }
  out.push("</urlset>");
  return out.join("\n") + "\n";
}

export function renderRobots(origin) {
  // /api/ stays crawlable: rendering a live book page needs /api/overview etc.
  return `User-agent: *\nAllow: /\nDisallow: /api/admin\nDisallow: /api/auth/\nDisallow: /api/billing/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export const GET = route(async (request) => {
  const origin = siteOrigin(request);
  if (searchParams(request).get("format") === "robots") {
    return new Response(renderRobots(origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": CACHE } });
  }
  const demo = await demoIds();
  const seen = new Set(demo);
  const live = (await liveBooks()).filter((id) => ID_RE.test(id) && !seen.has(id)).sort();
  const ids = [...demo, ...live].slice(0, MAX_URLS);
  return new Response(renderSitemap(origin, ids), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": CACHE, "x-content-type-options": "nosniff" },
  });
});
