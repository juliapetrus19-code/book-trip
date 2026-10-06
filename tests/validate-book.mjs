// Validate demo book files against SPEC.md §2.7.
// Usage: node tests/validate-book.mjs [data/books/<id>.json ...]   (no args = all books)
// Exit code 1 if any error. Warnings do not fail.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as E from "../js/enums.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9-]+$/;

function check(book, file) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  const isStr = (v) => typeof v === "string" && v.trim().length > 0;
  const words = (s) => String(s).trim().split(/\s+/).length;
  const inEnum = (v, list, path) => { if (!list.includes(v)) err(`${path}: "${v}" not in enum`); };

  if (!ID.test(book.id || "")) err("id must be [a-z0-9-]");
  if (!file.endsWith(`${book.id}.json`)) err(`file name must be <id>.json (id=${book.id})`);
  if (!(Number.isInteger(book.year) || book.year === null)) err("year must be integer or null");

  const c = book.cover || {};
  for (const k of ["bg", "bg2", "fg", "accent"]) if (!HEX.test(c[k] || "")) err(`cover.${k} must be #rrggbb`);
  inEnum(c.motif, E.COVER_MOTIFS, "cover.motif");

  const chars = Array.isArray(book.characters) ? book.characters : (err("characters must be an array"), []);
  if (chars.length < 4 || chars.length > 14) err(`characters: need 4–14, got ${chars.length}`);
  const charIds = new Set();
  chars.forEach((ch, i) => {
    const p = `characters[${i}]`;
    if (!ID.test(ch.id || "")) err(`${p}.id invalid`);
    if (charIds.has(ch.id)) err(`${p}.id duplicate "${ch.id}"`);
    charIds.add(ch.id);
    inEnum(ch.role, E.ROLES, `${p}.role`);
    if (!isStr(ch.portraitPrompt)) err(`${p}.portraitPrompt required (English)`);
    else if (/[а-яёіїєґ]/i.test(ch.portraitPrompt)) err(`${p}.portraitPrompt must be English`);
    const a = ch.appearance || {};
    inEnum(a.creature, E.CREATURES, `${p}.appearance.creature`);
    inEnum(a.gender, E.GENDERS, `${p}.appearance.gender`);
    inEnum(a.age, E.AGES, `${p}.appearance.age`);
    inEnum(a.build, E.BUILDS, `${p}.appearance.build`);
    if (!HEX.test(a.skin || "")) err(`${p}.appearance.skin hex`);
    if (!HEX.test(a.eyes || "")) err(`${p}.appearance.eyes hex`);
    if (!HEX.test(a.shoes || "")) err(`${p}.appearance.shoes hex`);
    inEnum(a.hair?.style, E.HAIR_STYLES, `${p}.appearance.hair.style`);
    if (!HEX.test(a.hair?.color || "")) err(`${p}.appearance.hair.color hex`);
    inEnum(a.facialHair, E.FACIAL_HAIR, `${p}.appearance.facialHair`);
    inEnum(a.top?.kind, E.TOP_KINDS, `${p}.appearance.top.kind`);
    inEnum(a.top?.pattern, E.PATTERNS, `${p}.appearance.top.pattern`);
    if (!HEX.test(a.top?.color || "") || !HEX.test(a.top?.accent || "")) err(`${p}.appearance.top colors hex`);
    inEnum(a.bottom?.kind, E.BOTTOM_KINDS, `${p}.appearance.bottom.kind`);
    if (!HEX.test(a.bottom?.color || "")) err(`${p}.appearance.bottom.color hex`);
    inEnum(a.headwear, E.HEADWEAR, `${p}.appearance.headwear`);
    if (!HEX.test(a.headwearColor || "")) err(`${p}.appearance.headwearColor hex`);
    inEnum(a.accessory, E.ACCESSORIES, `${p}.appearance.accessory`);
    if (!HEX.test(a.accessoryColor || "")) err(`${p}.appearance.accessoryColor hex`);
    inEnum(a.holding, E.HOLDING, `${p}.appearance.holding`);
  });
  if (!chars.some((ch) => ch.role === "protagonist")) err("at least one protagonist");

  const film = book.film || {};
  const scenes = Array.isArray(film.scenes) ? film.scenes : (err("film.scenes must be an array"), []);
  if (scenes.length < 5 || scenes.length > 7) err(`film.scenes: need 5–7, got ${scenes.length}`);
  scenes.forEach((s, i) => {
    const p = `film.scenes[${i}]`;
    inEnum(s.setting, E.SETTINGS, `${p}.setting`);
    inEnum(s.time, E.TIMES, `${p}.time`);
    inEnum(s.weather, E.WEATHER, `${p}.weather`);
    inEnum(s.action, E.ACTIONS, `${p}.action`);
    inEnum(s.camera, E.CAMERAS, `${p}.camera`);
    inEnum(s.mood, E.MOODS, `${p}.mood`);
    if (!Array.isArray(s.cast) || s.cast.length < 1 || s.cast.length > 4) err(`${p}.cast: 1–4 ids`);
    (s.cast || []).forEach((id) => { if (!charIds.has(id)) err(`${p}.cast: unknown character "${id}"`); });
    if (!Array.isArray(s.props) || s.props.length > 5) err(`${p}.props: 0–5`);
    (s.props || []).forEach((pr) => inEnum(pr, E.SCENE_PROPS, `${p}.props`));
    if (s.line !== null && s.line !== undefined) {
      if (!charIds.has(s.line.speaker)) err(`${p}.line.speaker unknown "${s.line?.speaker}"`);
    }
  });
  if (!Array.isArray(film.videoPrompts) || film.videoPrompts.length !== 3) err("film.videoPrompts: exactly 3");
  (film.videoPrompts || []).forEach((v, i) => { if (!isStr(v) || /[а-яёіїєґ]/i.test(v)) err(`film.videoPrompts[${i}] must be English text`); });

  for (const lang of E.LANGS) {
    const L = book.i18n?.[lang];
    const p = `i18n.${lang}`;
    if (!L) { err(`${p} missing`); continue; }
    for (const k of ["title", "author", "genre", "tagline"]) if (!isStr(L[k])) err(`${p}.${k} required`);
    if (L.originalTitle !== undefined && typeof L.originalTitle !== "string") err(`${p}.originalTitle must be string`);
    if (isStr(L.tagline) && L.tagline.length > 140) warn(`${p}.tagline long (${L.tagline.length})`);
    if (!Array.isArray(L.summary) || L.summary.length < 4 || L.summary.length > 7) err(`${p}.summary: 4–7 paragraphs`);
    (L.summary || []).forEach((para, i) => { const n = words(para); if (n < 35 || n > 140) warn(`${p}.summary[${i}] ${n} words`); });
    if (!Array.isArray(L.themes) || L.themes.length < 3 || L.themes.length > 6) err(`${p}.themes: 3–6`);
    if (!Array.isArray(L.terms) || L.terms.length < 6 || L.terms.length > 14) err(`${p}.terms: 6–14`);
    (L.terms || []).forEach((t, i) => { if (!isStr(t.term) || !isStr(t.definition)) err(`${p}.terms[${i}] term+definition`); });
    if (!Array.isArray(L.similar) || L.similar.length < 4 || L.similar.length > 6) err(`${p}.similar: 4–6`);
    (L.similar || []).forEach((s, i) => { if (!isStr(s.title) || !isStr(s.author) || !isStr(s.why)) err(`${p}.similar[${i}] title/author/why`); });
    const F = L.film || {};
    for (const k of ["title", "intro", "outro"]) if (!isStr(F[k])) err(`${p}.film.${k} required`);
    if (!Array.isArray(F.scenes) || F.scenes.length !== scenes.length) err(`${p}.film.scenes must have ${scenes.length} items`);
    (F.scenes || []).forEach((s, i) => {
      if (!isStr(s.title) || !isStr(s.narration)) err(`${p}.film.scenes[${i}] title+narration`);
      const shared = scenes[i];
      if (shared && (shared.line == null) !== (s.line == null)) err(`${p}.film.scenes[${i}].line must be null iff shared line is null`);
      if (s.line && !isStr(s.line.text)) err(`${p}.film.scenes[${i}].line.text required`);
    });
    const C = L.characters || {};
    for (const id of charIds) {
      const x = C[id];
      if (!x) { err(`${p}.characters.${id} missing`); continue; }
      if (!isStr(x.name) || !isStr(x.description)) err(`${p}.characters.${id} name+description`);
      if (!Array.isArray(x.traits) || x.traits.length < 3 || x.traits.length > 5) err(`${p}.characters.${id}.traits: 3–5`);
    }
    for (const id of Object.keys(C)) if (!charIds.has(id)) err(`${p}.characters.${id} has no shared character`);
  }
  return { errors, warnings };
}

const args = process.argv.slice(2);
const files = args.length ? args : (await readdir(`${ROOT}data/books`)).filter((f) => f.endsWith(".json")).map((f) => `data/books/${f}`);
let failed = 0;
for (const f of files) {
  const path = f.startsWith("/") ? f : `${ROOT}${f}`;
  let book;
  try { book = JSON.parse(await readFile(path, "utf8")); } catch (e) { console.log(`✗ ${f}: invalid JSON — ${e.message}`); failed++; continue; }
  const { errors, warnings } = check(book, path);
  if (errors.length) { failed++; console.log(`✗ ${f}`); errors.forEach((m) => console.log("   error:", m)); }
  else console.log(`✓ ${f}`);
  warnings.forEach((m) => console.log("   warn: ", m));
}
process.exit(failed ? 1 : 0);
