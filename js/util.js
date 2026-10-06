// BookTrip — small shared helpers (owned by core).

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape any value. Use for every string that came from AI output or data files. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Tiny DOM builder. Attributes: `class`, `text` (textContent), `html` (trusted markup only!),
 * `on<Event>` handlers, `dataset` object, anything else via setAttribute (null/false skipped).
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Deterministic 32-bit FNV-1a hash of a string. */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). seeded(42)() → float in [0, 1). */
export function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "ye", ж: "zh", з: "z", и: "i", і: "i", ї: "yi",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Lowercase ASCII slug, Cyrillic transliterated. */
export function slugify(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/[а-яёіїєґ]/g, (c) => TRANSLIT[c] ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Normalise text for fuzzy search: lowercase, no accents/quotes/punctuation, ё→е, і/ї→и. */
export function normalizeQuery(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/ё/g, "е").replace(/[іїи]/g, "и").replace(/є/g, "е").replace(/ґ/g, "г")
    .replace(/[«»"'“”„`’.,:;!?()\[\]—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function debounce(fn, ms = 200) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** Safe localStorage wrapper (private mode / disabled storage never throws). */
export const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
  keys() { try { return Object.keys(window.localStorage); } catch { return []; } },
};

/** Clamp helper. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Accept "#rgb"/"#rrggbb", return "#rrggbb" or the fallback. */
export function safeColor(value, fallback = "#888888") {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return ("#" + v.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  return fallback;
}

/** Pick `value` if it is in `allowed`, else `fallback`. */
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
