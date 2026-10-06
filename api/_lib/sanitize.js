// Never trust model output: every field is coerced, clamped and cleaned here before it is returned.
// Strings stay plain strings (the client inserts them with textContent / esc()).
import * as E from "./enums.js";
import { CONTROL, HttpError, ID_RE } from "./http.js";

// ---------------------------------------------------------------------------------------------
// Primitives

/** Trimmed single-line string, at most `max` characters (cut at a word boundary with "…"). */
export function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let s = String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  s = s.slice(0, max - 1);
  const space = s.lastIndexOf(" ");
  if (space > max * 0.6) s = s.slice(0, space);
  return s.replace(/[\s,;:.\-–—]+$/, "") + "…";
}

/** `#rgb` / `#rrggbb` → lowercase `#rrggbb`, anything else → fallback. */
export function color(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v.slice(1).split("").map((c) => c + c).join("");
  return fallback;
}

/** Enum coercion tolerant to case, spaces and dashes ("Wizard Hat" → "wizard_hat"). */
export function oneOf(value, allowed, fallback) {
  if (typeof value !== "string") return fallback;
  if (allowed.includes(value)) return value;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.includes(v) ? v : fallback;
}

export function list(value) {
  return Array.isArray(value) ? value : [];
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "ye", ж: "zh", з: "z", и: "i", і: "i", ї: "yi",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l",
};

/** Lowercase ASCII kebab-case slug (Cyrillic transliterated, accents stripped), ≤ `max` chars. */
export function slug(value, max = 80) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[а-яёіїєґßæœøł]/g, (c) => TRANSLIT[c] ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Loose comparison key for de-duplication. */
function key(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const k = keyFn(item);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function year(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= -3000 && n <= 2100 && n !== 0 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Cover

function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function sanitizeCover(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const cover = {
    bg: color(c.bg, "#1b2a4a"),
    bg2: color(c.bg2, "#0e1630"),
    fg: color(c.fg, "#f6e7b0"),
    accent: color(c.accent, "#ff8a5b"),
    motif: oneOf(c.motif, E.COVER_MOTIFS, "book"),
  };
  // The title must stay readable on both gradient stops.
  if (Math.min(contrast(cover.fg, cover.bg), contrast(cover.fg, cover.bg2)) < 3) {
    const dark = luminance(cover.bg) + luminance(cover.bg2) < 0.6;
    cover.fg = dark ? "#f6efe0" : "#1a1820";
  }
  return cover;
}

// ---------------------------------------------------------------------------------------------
// /api/resolve

function bookRefs(value, max, exclude = "") {
  const refs = list(value)
    .filter((s) => s && typeof s === "object")
    .map((s) => ({ title: text(s.title, 160), author: text(s.author, 120) }))
    .filter((s) => s.title && key(s.title) !== key(exclude));
  return uniqueBy(refs, (s) => key(s.title) + "|" + key(s.author)).slice(0, max);
}

export function sanitizeResolve(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const title = text(r.title, 200);
  const author = text(r.author, 160);
  if (r.found !== true || !title) {
    return { found: false, suggestions: bookRefs(r.suggestions, 5) };
  }
  const originalTitle = text(r.originalTitle, 200) || title;
  const surname = author.split(/\s+/).pop() || "";
  let id = slug(r.id, 100);
  if (!ID_RE.test(id)) id = slug(`${originalTitle} ${surname}`, 100);
  if (!ID_RE.test(id)) id = slug(`${title} ${surname}`, 100);
  if (!ID_RE.test(id)) id = "book-" + Math.abs(hashCode(title + "|" + author)).toString(36);
  return {
    found: true,
    id,
    title,
    originalTitle,
    author,
    year: year(r.year),
    genre: text(r.genre, 60),
    tagline: text(r.tagline, 120),
    cover: sanitizeCover(r.cover),
    suggestions: bookRefs(r.suggestions, 4, title),
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------------------------
// /api/overview

/** A model that answered `known: false` (or produced nothing usable) means we do not know the book. */
function unknownBook() {
  return new HttpError("not_found", "This book is not known well enough to describe it");
}

export function sanitizeOverview(raw, { title = "" } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.known === false) throw unknownBook();

  // Tolerate one big string with blank-line separated paragraphs.
  let paragraphs = list(r.summary);
  if (typeof r.summary === "string") paragraphs = r.summary.split(/\n\s*\n/);
  const summary = paragraphs.map((p) => text(p, 1400)).filter(Boolean).slice(0, 7);
  if (!summary.length) throw unknownBook();

  const themes = uniqueBy(list(r.themes).map((t) => text(t, 48)).filter(Boolean), key).slice(0, 6);

  const terms = uniqueBy(
    list(r.terms)
      .filter((t) => t && typeof t === "object")
      .map((t) => ({ term: text(t.term, 80), definition: text(t.definition, 420) }))
      .filter((t) => t.term && t.definition),
    (t) => key(t.term),
  ).slice(0, 14);

  const similar = uniqueBy(
    list(r.similar)
      .filter((s) => s && typeof s === "object")
      .map((s) => ({ title: text(s.title, 160), author: text(s.author, 120), why: text(s.why, 300) }))
      .filter((s) => s.title && key(s.title) !== key(title)),
    (s) => key(s.title),
  ).slice(0, 6);

  return { summary, themes, terms, similar };
}

// ---------------------------------------------------------------------------------------------
// /api/characters

const D = E.DEFAULT_APPEARANCE;

export function sanitizeAppearance(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const hair = a.hair && typeof a.hair === "object" ? a.hair : {};
  const top = a.top && typeof a.top === "object" ? a.top : {};
  const bottom = a.bottom && typeof a.bottom === "object" ? a.bottom : {};
  return {
    creature: oneOf(a.creature, E.CREATURES, D.creature),
    gender: oneOf(a.gender, E.GENDERS, D.gender),
    age: oneOf(a.age, E.AGES, D.age),
    build: oneOf(a.build, E.BUILDS, D.build),
    skin: color(a.skin, D.skin),
    hair: { style: oneOf(hair.style, E.HAIR_STYLES, D.hair.style), color: color(hair.color, D.hair.color) },
    facialHair: oneOf(a.facialHair, E.FACIAL_HAIR, D.facialHair),
    eyes: color(a.eyes, D.eyes),
    top: {
      kind: oneOf(top.kind, E.TOP_KINDS, D.top.kind),
      color: color(top.color, D.top.color),
      accent: color(top.accent, D.top.accent),
      pattern: oneOf(top.pattern, E.PATTERNS, D.top.pattern),
    },
    bottom: { kind: oneOf(bottom.kind, E.BOTTOM_KINDS, D.bottom.kind), color: color(bottom.color, D.bottom.color) },
    shoes: color(a.shoes, D.shoes),
    headwear: oneOf(a.headwear, E.HEADWEAR, D.headwear),
    headwearColor: color(a.headwearColor, D.headwearColor),
    accessory: oneOf(a.accessory, E.ACCESSORIES, D.accessory),
    accessoryColor: color(a.accessoryColor, D.accessoryColor),
    holding: oneOf(a.holding, E.HOLDING, D.holding),
  };
}

/** A plain English look description, used when the model gave no usable portrait prompt. */
export function fallbackPortraitPrompt(a) {
  const who = a.creature === "human" ? `${a.age} ${a.gender === "neutral" ? "person" : a.gender === "male" ? "man" : "woman"}` : `${a.age} ${a.creature}`;
  const parts = [`A ${a.build} ${who}`];
  if (a.hair.style !== "none") parts.push(`with ${a.hair.style.replace(/_/g, " ")} hair`);
  parts.push(`wearing a ${a.top.kind} and ${a.bottom.kind === "none" ? "no trousers" : a.bottom.kind}`);
  if (a.headwear !== "none") parts.push(`and a ${a.headwear.replace(/_/g, " ")}`);
  let s = parts.join(" ");
  if (a.holding !== "none") s += `, holding a ${a.holding.replace(/_weapon$/, "").replace(/_/g, " ")}`;
  return s + ", friendly expression.";
}

export function sanitizeCharacters(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.known === false) throw unknownBook();

  const used = new Set();
  const characters = [];
  for (const c of list(r.characters)) {
    if (!c || typeof c !== "object") continue;
    const name = text(c.name, 80);
    if (!name) continue;
    let base = slug(c.id, 60) || slug(name, 60) || `character-${characters.length + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const appearance = sanitizeAppearance(c.appearance);
    characters.push({
      id,
      name,
      role: oneOf(c.role, E.ROLES, characters.length === 0 ? "protagonist" : "supporting"),
      traits: uniqueBy(list(c.traits).map((t) => text(t, 32)).filter(Boolean), key).slice(0, 5),
      description: text(c.description, 600),
      appearance,
      portraitPrompt: text(c.portraitPrompt, 500) || fallbackPortraitPrompt(appearance),
    });
    if (characters.length === 14) break;
  }
  if (!characters.length) throw unknownBook();
  if (!characters.some((c) => c.role === "protagonist")) characters[0].role = "protagonist";
  return { characters };
}

// ---------------------------------------------------------------------------------------------
// /api/film

const VIDEO_STYLE = "Cute chunky voxel diorama, miniature toy-like 3D world made of small cubes, soft warm studio lighting";

function fallbackVideoPrompt(scene) {
  const when = { dawn: "at dawn", day: "in daylight", dusk: "at golden dusk", night: "at night under a starry sky" }[scene.time] || "";
  return `${VIDEO_STYLE}. Blocky little figurines ${scene.action === "talk" ? "talking" : scene.action} in a ${scene.setting.replace(/_/g, " ")} ${when}, ${scene.mood} mood, gentle details moving in the breeze. Slow ${scene.camera.replace(/_/g, " ")} camera move. No text, no logos.`;
}

/**
 * `cast` is the list of known characters [{ id, name }] the film may use. Scene casts and line speakers
 * are filtered to these ids (names are mapped back to ids when the model used a name by mistake).
 */
export function sanitizeFilm(raw, cast) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.known === false) throw unknownBook();

  const ids = cast.map((c) => c.id);
  const lookup = new Map();
  for (const c of cast) {
    lookup.set(c.id, c.id);
    lookup.set(key(c.name), c.id);
    lookup.set(slug(c.name), c.id);
  }
  const resolveId = (value) => {
    if (typeof value !== "string") return null;
    return lookup.get(value) || lookup.get(slug(value)) || lookup.get(key(value)) || null;
  };

  const scenes = [];
  for (const s of list(r.scenes)) {
    if (!s || typeof s !== "object") continue;
    const narration = text(s.narration, 500);
    const title = text(s.title, 60);
    if (!narration && !title) continue;

    const sceneCast = [...new Set(list(s.cast).map(resolveId).filter(Boolean))].slice(0, 4);
    let line = null;
    if (s.line && typeof s.line === "object") {
      const speaker = resolveId(s.line.speaker);
      const lineText = text(s.line.text, 140);
      if (speaker && lineText) {
        if (!sceneCast.includes(speaker)) {
          if (sceneCast.length >= 4) sceneCast.pop();
          sceneCast.push(speaker);
        }
        line = { speaker, text: lineText };
      }
    }
    if (!sceneCast.length && ids.length) sceneCast.push(ids[0]);

    scenes.push({
      title,
      setting: oneOf(s.setting, E.SETTINGS, "meadow"),
      time: oneOf(s.time, E.TIMES, "day"),
      weather: oneOf(s.weather, E.WEATHER, "clear"),
      cast: sceneCast,
      props: [...new Set(list(s.props).map((p) => oneOf(p, E.SCENE_PROPS, null)).filter(Boolean))].slice(0, 5),
      action: oneOf(s.action, E.ACTIONS, "talk"),
      camera: oneOf(s.camera, E.CAMERAS, "orbit"),
      mood: oneOf(s.mood, E.MOODS, "calm"),
      narration,
      line,
    });
    if (scenes.length === 7) break;
  }
  if (!scenes.length) throw new HttpError("upstream", "The AI returned a film without scenes, please try again");

  // Exactly three video prompts: keep the model's, top up from the scenes if it gave fewer.
  const videoPrompts = list(r.videoPrompts).map((p) => text(p, 1200)).filter((p) => p.length >= 20).slice(0, 3);
  for (let i = 0; videoPrompts.length < 3; i++) {
    const scene = scenes[Math.min(scenes.length - 1, Math.round((i * (scenes.length - 1)) / 2))];
    videoPrompts.push(fallbackVideoPrompt(scene));
  }

  return {
    title: text(r.title, 90),
    intro: text(r.intro, 400),
    outro: text(r.outro, 400),
    scenes,
    videoPrompts,
  };
}
