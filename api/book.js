// GET /book/<id> (vercel rewrite → /api/book?id=<id>[&lang=]) → index.html with per-book SEO:
// <title>, description, canonical, hreflang alternates, Open Graph / Twitter tags, <html lang>,
// JSON-LD Book, and a server-rendered <section id="ssr-book"> (the client removes it on boot).
// Book data: data/books/<id>.json (demo), else the cached resolve + overview in the store.
// Unknown ids get the plain index.html (200, noindex) — the client handles them.
import { canonicalBook, readCache } from "./_lib/cache.js";
import { loadDemoBook } from "./_lib/demo.js";
import { LANGS } from "./_lib/enums.js";
import { projectFileExists, readProjectFile } from "./_lib/files.js";
import { HttpError, ID_RE, cleanText, route, searchParams, siteOrigin } from "./_lib/http.js";

const CACHE_BOOK = "public, max-age=300, s-maxage=86400";
const CACHE_UNKNOWN = "public, max-age=0, s-maxage=60";

const SUFFIX = { uk: "переказ, персонажі, мініфільм", ru: "пересказ, персонажи, мини-фильм", en: "summary, characters, mini-film" };
const HEADINGS = {
  uk: { summary: "Переказ", terms: "Важливі терміни" },
  ru: { summary: "Пересказ", terms: "Важные термины" },
  en: { summary: "Summary", terms: "Key terms" },
};
const LOCALE = { uk: "uk_UA", ru: "ru_RU", en: "en_US" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** JSON safe inside <script>: no "<", ">", "&" or line separators can end the element. */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&  ]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** ?lang= wins; else the first of uk/ru/en in Accept-Language (by q); else uk. */
export function pickLang(request) {
  const param = searchParams(request).get("lang");
  if (LANGS.includes(param)) return { lang: param, explicit: true };
  const header = String(request.headers.get("accept-language") || "").slice(0, 500);
  const tags = header.split(",").map((part, i) => {
    const [tag, ...rest] = part.trim().toLowerCase().split(";");
    const q = rest.map((r) => /^\s*q=([\d.]+)/.exec(r)).find(Boolean);
    return { tag, q: q ? Number(q[1]) : 1, i };
  }).filter((t) => t.tag && t.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) {
    const base = tag.split("-")[0];
    if (LANGS.includes(base)) return { lang: base, explicit: false };
  }
  return { lang: "uk", explicit: false };
}

const strings = (list, max) => (Array.isArray(list) ? list : []).filter((s) => typeof s === "string").map((s) => cleanText(s).slice(0, max)).filter(Boolean);
const termList = (list) => (Array.isArray(list) ? list : [])
  .filter((t) => t && typeof t.term === "string" && typeof t.definition === "string")
  .map((t) => ({ term: cleanText(t.term).slice(0, 80), definition: cleanText(t.definition).slice(0, 420) }))
  .slice(0, 14);

/** { source, lang, title, author, tagline, genre, year, summary[], terms[] } or null. */
export async function findBook(id, lang) {
  if (!ID_RE.test(id)) return null;
  const demo = await loadDemoBook(id);
  if (demo && demo.i18n && typeof demo.i18n === "object") {
    const dataLang = [lang, "uk", "en", "ru"].find((l) => demo.i18n[l] && typeof demo.i18n[l].title === "string");
    if (dataLang) {
      const t = demo.i18n[dataLang];
      return {
        source: "demo", lang: dataLang, title: cleanText(t.title), author: cleanText(t.author), tagline: cleanText(t.tagline),
        genre: cleanText(t.genre), year: Number.isInteger(demo.year) ? demo.year : null,
        summary: strings(t.summary, 1400).slice(0, 7), terms: termList(t.terms),
      };
    }
  }
  const canonical = await canonicalBook(id, lang);
  if (!canonical) return null;
  // Prefer the overview in the requested language, else the one the book was resolved in.
  let dataLang = lang;
  let overview = await readCache("overview", lang, id);
  if (!overview && canonical.lang !== lang) {
    overview = await readCache("overview", canonical.lang, id);
    if (overview) dataLang = canonical.lang;
  }
  // canonical.meta is in the requested language whenever the book was resolved in it.
  const meta = canonical.meta;
  return {
    source: "live", lang: overview ? dataLang : canonical.lang, title: cleanText(meta.title), author: cleanText(meta.author),
    tagline: cleanText(meta.tagline), genre: cleanText(meta.genre), year: Number.isInteger(meta.year) ? meta.year : null,
    summary: overview ? strings(overview.summary, 1400).slice(0, 7) : [], terms: overview ? termList(overview.terms) : [],
  };
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "") + "…";
}

export function bookDescription(book) {
  const parts = [book.tagline, ...book.summary].filter(Boolean);
  return truncate(cleanText(parts.join(" ")) || `${book.title} — ${book.author}`, 160);
}

export function bookTitle(book, lang) {
  const head = book.author ? `${book.title} — ${book.author}` : book.title;
  return `${head}: ${SUFFIX[lang] || SUFFIX.uk} | BookTrip`;
}

/** Remove the tags we are about to write (whatever index.html currently carries). */
function stripHeadTags(html) {
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, "")
    .replace(/<meta\b(?=[^>]*\bname\s*=\s*["']?(?:description|robots|twitter:[^"'\s>]*)["'\s>])[^>]*>\s*/gi, "")
    .replace(/<meta\b(?=[^>]*\bproperty\s*=\s*["']?(?:og|book):[^"'\s>]*["'\s>])[^>]*>\s*/gi, "")
    .replace(/<link\b(?=[^>]*\brel\s*=\s*["']?canonical["'\s>])[^>]*>\s*/gi, "")
    .replace(/<link\b(?=[^>]*\bhreflang\s*=)[^>]*>\s*/gi, "");
}

function setHtmlLang(html, lang) {
  return html.replace(/<html\b([^>]*)>/i, (m, attrs) => {
    const rest = attrs.replace(/\s+lang\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i, "");
    return `<html lang="${lang}"${rest}>`;
  });
}

function insertBeforeHeadEnd(html, block) {
  const i = html.search(/<\/head>/i);
  return i < 0 ? block + html : html.slice(0, i) + block + html.slice(i);
}

function insertAfterMain(html, block) {
  const m = /<main\b[^>]*\bid\s*=\s*["']?main["'\s>][^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + "\n" + block + html.slice(m.index + m[0].length);
  const body = /<body\b[^>]*>/i.exec(html);
  return body ? html.slice(0, body.index + body[0].length) + "\n" + block + html.slice(body.index + body[0].length) : html + block;
}

export function ssrSection(id, book) {
  const h = HEADINGS[book.lang] || HEADINGS.uk;
  const out = [`<section id="ssr-book" class="ssr-book" lang="${escapeHtml(book.lang)}" data-id="${escapeHtml(id)}" data-source="${escapeHtml(book.source)}">`];
  out.push(`<h1>${escapeHtml(book.title)}</h1>`);
  if (book.author) out.push(`<p class="ssr-author">${escapeHtml(book.author)}${book.year ? `, ${book.year}` : ""}</p>`);
  if (book.tagline) out.push(`<p class="ssr-tagline">${escapeHtml(book.tagline)}</p>`);
  if (book.summary.length) {
    out.push(`<h2>${escapeHtml(h.summary)}</h2>`);
    for (const p of book.summary) out.push(`<p>${escapeHtml(p)}</p>`);
  }
  if (book.terms.length) {
    out.push(`<h2>${escapeHtml(h.terms)}</h2>`, "<dl>");
    for (const t of book.terms) out.push(`<dt>${escapeHtml(t.term)}</dt><dd>${escapeHtml(t.definition)}</dd>`);
    out.push("</dl>");
  }
  out.push("</section>");
  return out.join("\n");
}

/** index.html → the page for `book` (pure; exported for tests). */
export function renderBookPage(shell, { id, book, lang, explicit, origin, image }) {
  const path = `/book/${id}`;
  const canonical = origin + path + (explicit ? `?lang=${lang}` : "");
  const title = bookTitle(book, lang);
  const ogTitle = book.author ? `${book.title} — ${book.author}` : book.title;
  const description = bookDescription(book);
  const imageUrl = origin + image;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: book.title,
    ...(book.author ? { author: { "@type": "Person", name: book.author } } : {}),
    inLanguage: book.lang,
    description,
    url: canonical,
    ...(book.genre ? { genre: book.genre } : {}),
    ...(book.year ? { datePublished: String(book.year) } : {}),
  };
  const e = escapeHtml;
  const head = [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}">`,
    `<link rel="canonical" href="${e(canonical)}">`,
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${e(`${origin}${path}?lang=${l}`)}">`),
    `<link rel="alternate" hreflang="x-default" href="${e(origin + path)}">`,
    `<meta property="og:type" content="book">`,
    `<meta property="og:site_name" content="BookTrip">`,
    `<meta property="og:title" content="${e(ogTitle)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:url" content="${e(canonical)}">`,
    `<meta property="og:image" content="${e(imageUrl)}">`,
    `<meta property="og:locale" content="${LOCALE[lang] || LOCALE.uk}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${e(ogTitle)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(imageUrl)}">`,
    `<script type="application/ld+json">${scriptJson(ld)}</script>`,
  ].join("\n") + "\n";
  let html = setHtmlLang(stripHeadTags(shell), lang);
  html = insertBeforeHeadEnd(html, head);
  return insertAfterMain(html, ssrSection(id, book));
}

/** The plain shell for unknown books: not indexed (the client decides what to show). */
export function renderUnknownPage(shell) {
  return insertBeforeHeadEnd(shell.replace(/<meta\b(?=[^>]*\bname\s*=\s*["']?robots["'\s>])[^>]*>\s*/gi, ""), `<meta name="robots" content="noindex">\n`);
}

function htmlResponse(html, cache, vary) {
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff" };
  if (vary) headers.vary = "Accept-Language";
  return new Response(html, { status: 200, headers });
}

export const GET = route(async (request) => {
  const shell = await readProjectFile("index.html");
  if (!shell) throw new HttpError("server", "index.html is missing");
  // The rewrite passes ?id=; fall back to the original /book/<id> path should a platform keep it.
  const fromPath = /^\/book\/([^/?#]+)/.exec(new URL(request.url).pathname);
  const id = String(searchParams(request).get("id") || (fromPath ? decodeURIComponent(fromPath[1]) : "")).toLowerCase();
  const { lang, explicit } = pickLang(request);
  const book = await findBook(id, lang);
  if (!book || !book.title) return htmlResponse(renderUnknownPage(shell), CACHE_UNKNOWN, false);
  const image = (await projectFileExists("og.png")) ? "/og.png" : "/icon.svg";
  const html = renderBookPage(shell, { id, book, lang, explicit, origin: siteOrigin(request), image });
  return htmlResponse(html, CACHE_BOOK, !explicit);
});
