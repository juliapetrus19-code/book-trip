// BookTrip — generative book covers (SVG strings). Owned by home.
//
//   coverSVG(cover, { title, author, w = 260, h = 390, idPrefix?, decorative?, texture? }) → "<svg …>"
//   miniCoverSVG(cover, { title, w = 40, h = 60 })                                       → "<svg …>"
//   coverFromString(str)                                                                   → Cover
//
// Everything is drawn in a fixed 260×390 user space (viewBox) and scaled by w/h, so covers look
// identical at every size. Output is deterministic for the same input. All text is escaped.
// ids inside the SVG are prefixed (default: a hash of the input) so several covers can live
// in one document; pass `idPrefix` to force a unique prefix per inline copy.

import { esc, hashStr, seeded, safeColor } from "./util.js";
import { COVER_MOTIFS } from "./enums.js";

const VW = 260;
const VH = 390;

/* ------------------------------------------------------------------------------------------------
   Glyph width tables (em) measured in Chromium for the exact weights used on covers.
   Lets us wrap and auto-size titles without touching the DOM (works in workers / node too). */
const CH_UP = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЇЄҐ0123456789 .,:;!?'\"«»—–-()&№"];
const CH_LOW = [..."abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ"];
const W_UNBOUNDED_800 = "98,90,94,94,80,78,97,95,36,82,88,77,126,98,97,83,97,86,86,83,88,95,138,90,94,82,98,85,90,67,109,80,80,141,86,100,100,88,101,126,95,97,94,83,94,83,92,128,90,103,90,137,146,102,116,83,95,131,87,36,36,95,67,94,54,85,85,88,82,87,77,91,87,24,31,32,34,34,34,72,29,53,77,77,122,67,38,41,41,96,155";
const W_PLAYFAIR_600 = "66,66,70,76,63,59,72,79,36,35,70,60,91,72,78,62,78,68,57,65,69,66,95,67,61,60,66,63,66,56,65,63,63,101,58,81,81,71,71,91,79,78,79,62,70,65,66,90,67,80,73,108,108,77,97,62,70,106,68,36,36,70,54,63,38,51,48,52,45,55,44,55,54,24,26,27,28,29,28,49,20,35,55,55,88,59,49,31,31,88,101,51,58,49,59,51,35,55,60,31,29,57,30,90,61,56,59,58,46,46,35,60,50,78,53,51,47,51,57,56,47,54,51,51,87,48,65,65,60,59,73,63,56,63,59,49,57,51,83,53,64,59,90,90,69,81,55,51,81,57,31,31,50,46";
const W_INTER_600 = "73,66,74,72,61,59,75,75,28,58,70,57,92,76,77,65,77,65,65,66,74,73,102,72,71,65,73,65,66,58,85,61,61,103,64,76,76,70,75,92,75,77,75,65,74,66,67,83,72,75,71,98,100,83,91,66,74,103,65,28,28,74,58,66,42,62,64,67,61,64,58,64,64,25,32,32,32,33,32,54,33,52,63,63,100,50,47,37,37,66,110,57,62,58,62,59,39,63,61,26,26,57,26,90,61,61,62,62,40,55,35,61,59,84,57,59,57,57,60,57,45,65,59,59,85,51,61,61,57,59,80,61,61,61,62,58,50,59,75,57,64,59,85,87,67,78,58,58,86,57,26,26,58,45";

function widthTable(csv, fallback) {
  const chars = CH_UP.concat(CH_LOW);
  const map = new Map();
  csv.split(",").forEach((w, i) => map.set(chars[i], Number(w) / 100));
  return { map, fallback };
}
const T_DISPLAY = widthTable(W_UNBOUNDED_800, 0.86);
const T_SERIF = widthTable(W_PLAYFAIR_600, 0.6);
const T_UI = widthTable(W_INTER_600, 0.62);

const FONT_DISPLAY = "Unbounded, Inter, system-ui, sans-serif";
const FONT_SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const FONT_UI = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

function charWidth(ch, table) {
  const m = table.map;
  if (m.has(ch)) return m.get(ch);
  const up = ch.toUpperCase();
  if (m.has(up)) return m.get(up);
  const base = ch.normalize("NFD")[0];
  if (m.has(base)) return m.get(base);
  const code = ch.codePointAt(0);
  if (code >= 0x2e80) return 1; // CJK & friends are full-width
  return table.fallback;
}

/** Width of `str` in px at font `size`, with letter-spacing `ls` in em. */
function measure(str, table, size, ls = 0) {
  let w = 0;
  let n = 0;
  for (const ch of str) { w += charWidth(ch, table); n++; }
  return (w + ls * Math.max(0, n - 1)) * size;
}

function wrapGreedy(words, maxW, m) {
  const lines = [];
  let cur = "";
  for (const word of words) {
    const cand = cur ? cur + " " + word : word;
    if (!cur || m(cand) <= maxW) cur = cand;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Same number of lines, but as even as possible (like CSS text-wrap: balance). */
function balance(words, count, maxW, m) {
  let lo = maxW * 0.45;
  let hi = maxW;
  let best = wrapGreedy(words, maxW, m);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrapGreedy(words, mid, m);
    if (lines.length <= count && lines.every((l) => m(l) <= maxW)) { best = lines; hi = mid; } else lo = mid;
  }
  return best;
}

/** Split words that are wider than maxW into pieces that fit (last resort for huge words). */
function breakLongWords(words, maxW, m) {
  const out = [];
  for (const word of words) {
    if (m(word) <= maxW) { out.push(word); continue; }
    let piece = "";
    for (const ch of word) {
      if (piece && m(piece + ch + "-") > maxW) { out.push(piece + "-"); piece = ch; } else piece += ch;
    }
    if (piece) out.push(piece);
  }
  return out;
}

/**
 * Fit text into a box: wraps to ≤ maxLines and picks the largest font size in [min, max].
 * Returns { lines, size }. Falls back to breaking words and an ellipsis if nothing fits.
 */
function fitText(text, { table, maxW, maxLines, max, min, ls = 0, upper = false }) {
  const t = (upper ? text.toUpperCase() : text).replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (!words.length) return { lines: [], size: max };
  for (let size = max; size >= min; size -= 0.5) {
    const m = (s) => measure(s, table, size, ls);
    const lines = wrapGreedy(words, maxW, m);
    if (lines.length <= maxLines && lines.every((l) => m(l) <= maxW)) {
      return { lines: lines.length > 1 ? balance(words, lines.length, maxW, m) : lines, size };
    }
  }
  const size = min;
  const m = (s) => measure(s, table, size, ls);
  let lines = wrapGreedy(breakLongWords(words, maxW, m), maxW, m);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 1 && m(last + "…") > maxW) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = last + "…";
  }
  return { lines, size };
}

/** One line, shrinking from max to min, then truncating with an ellipsis. */
function fitLine(text, { table, maxW, max, min, ls = 0, upper = false }) {
  const t = (upper ? text.toUpperCase() : text).replace(/\s+/g, " ").trim();
  for (let size = max; size >= min; size -= 0.25) {
    if (measure(t, table, size, ls) <= maxW) return { text: t, size };
  }
  let s = t;
  while (s.length > 1 && measure(s + "…", table, min, ls) > maxW) s = s.slice(0, -1).trimEnd();
  return { text: s === t ? s : s + "…", size: min };
}

/* ------------------------------------------------------------------------------------------------
   Colour helpers */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function mix(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  return hex(A.map((v, i) => v + (B[i] - v) * t));
}
function lum(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ------------------------------------------------------------------------------------------------
   Palettes for coverFromString() — rich, print-like combinations (two light covers for variety). */
const PALETTES = [
  { bg: "#1b2a4a", bg2: "#0b1226", fg: "#f3e3b0", accent: "#ffb35c" },
  { bg: "#6b1d2a", bg2: "#2a0a12", fg: "#f6e6d0", accent: "#e8b04a" },
  { bg: "#1f4a3a", bg2: "#0b1f19", fg: "#eadfb8", accent: "#f0a04b" },
  { bg: "#0f5560", bg2: "#062a33", fg: "#f2efe6", accent: "#ff7a5c" },
  { bg: "#4a2358", bg2: "#1c0b26", fg: "#f7dff0", accent: "#ff8fb1" },
  { bg: "#26303d", bg2: "#0d1218", fg: "#e6f4ff", accent: "#5fe1ff" },
  { bg: "#d4963a", bg2: "#7a4514", fg: "#1d140b", accent: "#fff2d6" },
  { bg: "#3b5ba5", bg2: "#141b3d", fg: "#fde9c9", accent: "#ffcf7a" },
  { bg: "#8a3b1e", bg2: "#33130a", fg: "#f5e2c4", accent: "#ffd27a" },
  { bg: "#6f8f6c", bg2: "#263a2b", fg: "#f6f3e8", accent: "#ff8a5b" },
  { bg: "#efe6d2", bg2: "#c9b994", fg: "#2a2118", accent: "#a3282c" },
  { bg: "#0f3d68", bg2: "#071a33", fg: "#dff3ff", accent: "#7fd3ff" },
  { bg: "#2a0f1a", bg2: "#0e0509", fg: "#ffd9e4", accent: "#ff5d8f" },
  { bg: "#0d5b45", bg2: "#032419", fg: "#f1e9c6", accent: "#d9b45a" },
  { bg: "#6a5aa8", bg2: "#2b2152", fg: "#fff6e0", accent: "#ffd166" },
  { bg: "#b3222e", bg2: "#3d070d", fg: "#fff1e6", accent: "#ffcf7a" },
];

/** Keyword → motif hints (ru / uk / en word stems, matched at word starts) so generated covers
    feel related to the title. First match wins, so specific stems come before generic ones. */
const KEYWORDS = [
  ["hat", "шляп|капелюх|hat|цилиндр|алис|аліс|alice|wonderland|зазеркал|задзеркал"],
  ["ring", "кольц|кільц|ring|властелин|володар|lord|хоббит|гобіт|hobbit"],
  ["wand", "волшеб|чарів|magic|маг|wizard|колдун|witch|ведьм|відьм|поттер|potter|чароді"],
  ["crown", "принц|prince|princess|корол|king|queen|царь|цар|crown|корон|трон|throne"],
  ["star", "звезд|зір|зорі|star|галакт|galax|космос|cosmos|space|марс|mars|солярис|solaris"],
  ["rose", "роз[аы]|rose|гордост|гордість|pride|предубежд|упередж"],
  ["sword", "меч|sword|войн|війн|war|битв|battle|мушкет|musket|рыцар|лицар|knight|солдат|soldier"],
  ["wave", "мор[ея]|sea|океан|ocean|волн|хвил|wave|кит|whale|moby|вод|water|под водой|рыб|риб|fish"],
  ["ship", "корабл|ship|фрегат|капитан|captain|пират|pirat|моряк|sailor|паруса|sail"],
  ["anchor", "якор|anchor|остров|острів|island|гавань|harbo|сокровищ|скарб|treasure"],
  ["key", "ключ|key|тайн|таємн|secret|двер|door"],
  ["eye", "глаз|око|очі|eye|1984|watch|наблюд"],
  ["tree", "лес|ліс|forest|дерев|tree|сад|garden|вишн|cherry|дуб|oak"],
  ["moon", "лун|місяц|moon|ноч|ніч|night|сон|dream|сумерк|twilight"],
  ["sun", "солнц|сонц|sun|лето|літо|summer|ден|day|рассвет|світан|dawn"],
  ["castle", "замок|замк|castle|двор|palace|тауэр|tower|башн|вежа|королевств|kingdom"],
  ["mask", "маск|mask|театр|theat|призрак|примар|phantom|опер|opera|карнавал"],
  ["feather", "пер[оь]|feather|поэм|поем|poem|стих|вірш|письм|letter|дневник|щоденник|diary"],
  ["heart", "любов|кохан|love|сердц|серц|heart|ромео|romeo|джульет|juliet|анна|anna|страст"],
  ["skull", "смерт|death|мертв|dead|череп|skull|гамлет|hamlet|франкенш|frankenst|дракул|dracula|вампир|vampir"],
  ["dagger", "кинжал|dagger|нож|knife|преступ|злочин|crime|убий|вбив|kill|murder|детектив|detective|холмс|holmes|пуаро|poirot"],
  ["compass", "путешеств|подорож|journey|travel|компас|compass|вокруг|навколо|around|дорог|road|странств"],
  ["mountain", "гор[аы]|гір|mountain|вершин|peak|скал|rock|альп"],
  ["bird", "птиц|птах|bird|ворон|raven|чайк|gull|соловей|соловь|nightingale|пересмешн|mockingbird|ласточ|swallow|сокол|falcon|орел|eagle"],
  ["book", "книг|book|библиотек|бібліотек|library|сказк|казк|tale|истори|історі|story|повест|повіст"],
  ["flame", "огн|огон|вогн|fire|flame|плам|полум|дракон|dragon|451|hell|пожар"],
  ["clock", "час[ыи]|годинник|clock|time|врем|машина времени"],
  ["leaf", "лист|leaf|leaves|осен|осін|autumn|весн|spring|трав|grass|зелен|green"],
  ["lantern", "фонар|lantern|свет|світл|light|ламп|lamp|свеч|свіч|candle"],
  ["fox", "лис|fox|зверь|звір|beast|животн|animal|собак|собач|dog|кот|кіт|cat|волк|вовк|wolf"],
].map(([motif, stems]) => [new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${stems})`, "u"), motif]);

/** Deterministic Cover (palette + motif) from any string — for books without cover data. */
export function coverFromString(str) {
  const s = String(str ?? "").toLowerCase();
  const h = hashStr(s || "booktrip");
  const pal = PALETTES[h % PALETTES.length];
  let motif = null;
  for (const [re, m] of KEYWORDS) if (re.test(s)) { motif = m; break; }
  if (!motif) motif = COVER_MOTIFS[(h >>> 8) % COVER_MOTIFS.length];
  return { ...pal, motif };
}

/* ------------------------------------------------------------------------------------------------
   Motif illustrations. Each draws into a 100×100 box using the palette:
   F = fg, A = accent, K = knock-out (contrasts with F), B2 = bg2, P = prefix for ids. */
const ROUND = 'stroke-linecap="round" stroke-linejoin="round"';

function sparkle(cx, cy, r, fill, extra = "") {
  const k = r * 0.16;
  return `<path d="M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z" fill="${fill}"${extra}/>`;
}

function radial(n, cx, cy, fn) {
  let out = "";
  for (let i = 0; i < n; i++) out += fn((i / n) * Math.PI * 2, i, cx, cy);
  return out;
}
const r1 = (v) => Math.round(v * 10) / 10;

function bone(x1, y1, x2, y2, w, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const px = (-dy / len) * w * 0.42;
  const py = (dx / len) * w * 0.42;
  const knobs = [[x1, y1], [x2, y2]].map(([x, y]) =>
    `<circle cx="${r1(x + px)}" cy="${r1(y + py)}" r="${r1(w * 0.55)}" fill="${color}"/><circle cx="${r1(x - px)}" cy="${r1(y - py)}" r="${r1(w * 0.55)}" fill="${color}"/>`).join("");
  return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>${knobs}`;
}

const MOTIFS = {
  star: ({ F, A }) => `
    <circle cx="50" cy="50" r="35" fill="none" stroke="${A}" stroke-width="1.1" stroke-dasharray="1.5 4" stroke-linecap="round" opacity=".7"/>
    <path d="M50 4C53 36 64 47 96 50C64 53 53 64 50 96C47 64 36 53 4 50C36 47 47 36 50 4Z" fill="${F}"/>
    <path d="M50 28C51.6 44 56 48.4 72 50C56 51.6 51.6 56 50 72C48.4 56 44 51.6 28 50C44 48.4 48.4 44 50 28Z" fill="${A}"/>
    ${sparkle(82, 16, 8, A)}${sparkle(18, 80, 5, F)}
    <circle cx="86" cy="78" r="1.6" fill="${F}"/><circle cx="14" cy="22" r="1.4" fill="${A}"/><circle cx="74" cy="90" r="1.1" fill="${F}"/>`,

  rose: ({ F, A, K }) => `
    <path d="M50 56C50 70 48 80 50 96" fill="none" stroke="${F}" stroke-width="2.6" ${ROUND}/>
    <path d="M49 74C40 64 29 66 24 71C33 78 42 78 49 74Z" fill="${F}"/>
    <path d="M51 84C59 75 70 76 75 79C68 87 58 88 51 84Z" fill="${F}"/>
    <path d="M37 69C33 69 30 70 27 71M63 80C67 79.5 70 79.5 72 79.5" stroke="${K}" stroke-width="1" opacity=".5" fill="none"/>
    <path d="M47 64l-3-2M53 69l3-2M48 90l-3-1.5" stroke="${F}" stroke-width="1.6" ${ROUND}/>
    <path d="M50 14C64 14 72 24 70 37C68 50 58 56 50 56C41 56 31 50 30 37C29 24 37 14 50 14Z" fill="${A}"/>
    <path d="M50 22C58 22 62 29 59 35C56 41 47 41 45.5 34C44.5 29.5 48 27 51.5 29" fill="none" stroke="${K}" stroke-width="1.7" opacity=".45" ${ROUND}/>
    <path d="M35 30C36 45 45 51 55 50M66 26C69 38 64 47 57 51M40 18C34 22 32 28 33 34" fill="none" stroke="${K}" stroke-width="1.5" opacity=".38" ${ROUND}/>
    <path d="M38 22C42 18 46 17 50 17" fill="none" stroke="#fff" stroke-width="1.4" opacity=".35" ${ROUND}/>
    <path d="M50 55L41 61L47 59.5L50 66L53 59.5L59 61Z" fill="${F}"/>`,

  crown: ({ F, A, K }) => `
    <path d="M16 72L11 30L32 50L50 18L68 50L89 30L84 72Z" fill="${F}" ${ROUND}/>
    <path d="M50 32L58 50L50 62L42 50Z" fill="${K}" opacity=".3"/>
    <path d="M24 60Q50 50 76 60" fill="none" stroke="${K}" stroke-width="1.4" opacity=".35"/>
    <rect x="13" y="70" width="74" height="13" rx="3" fill="${F}"/>
    <path d="M17 76.5H83" stroke="${K}" stroke-width="1" opacity=".35"/>
    <circle cx="11" cy="28" r="5" fill="${A}"/><circle cx="50" cy="15" r="6" fill="${A}"/><circle cx="89" cy="28" r="5" fill="${A}"/>
    <circle cx="31" cy="76.5" r="3.2" fill="${A}"/><path d="M50 71l4.5 5.5L50 82l-4.5-5.5Z" fill="${A}"/><circle cx="69" cy="76.5" r="3.2" fill="${A}"/>
    <circle cx="48" cy="13" r="1.6" fill="#fff" opacity=".6"/>`,

  sword: ({ F, A, K }) => `
    <path d="M50 3L57.5 15V64H42.5V15Z" fill="${F}"/>
    <path d="M50 3L57.5 15V64H50Z" fill="${K}" opacity=".16"/>
    <path d="M50 13V59" stroke="${K}" stroke-width="1.8" opacity=".3"/>
    <path d="M24 64Q37 59.5 50 61.5Q63 59.5 76 64Q63 70 50 67.5Q37 70 24 64Z" fill="${A}"/>
    <circle cx="23" cy="64" r="3.6" fill="${A}"/><circle cx="77" cy="64" r="3.6" fill="${A}"/>
    <rect x="45.5" y="67" width="9" height="21" rx="2" fill="${F}"/>
    <path d="M45.5 71.5L54.5 74.5M45.5 76.5L54.5 79.5M45.5 81.5L54.5 84.5" stroke="${K}" stroke-width="1.2" opacity=".45"/>
    <circle cx="50" cy="92" r="5.5" fill="${A}"/><circle cx="48.5" cy="90.5" r="1.4" fill="#fff" opacity=".6"/>`,

  ship: ({ F, A, K }) => `
    <path d="M8 86Q16 80 24 86T40 86T56 86T72 86T88 86" fill="none" stroke="${A}" stroke-width="2.6" ${ROUND}/>
    <path d="M14 94Q22 89 30 94T46 94T62 94T78 94T94 94" fill="none" stroke="${A}" stroke-width="2" opacity=".55" ${ROUND}/>
    <path d="M38 64V9M62 64V19M84 64L97 55" stroke="${F}" stroke-width="2.2" ${ROUND}/>
    <path d="M27 15Q38 19 49 15L50 32Q38 36 26 32Z" fill="${F}"/>
    <path d="M24 36Q38 41 52 36L53 58Q38 62 23 58Z" fill="${F}"/>
    <path d="M53 23Q62 26 71 23L72 38Q62 41 52 38Z" fill="${F}" opacity=".9"/>
    <path d="M51 42Q62 46 73 42L74 59Q62 62 50 59Z" fill="${F}" opacity=".9"/>
    <path d="M38 17V32M38 39V59M62 25V38M62 45V60" stroke="${K}" stroke-width="1" opacity=".22"/>
    <path d="M38 6L50 9.5L38 13Z" fill="${A}"/>
    <path d="M10 64H90L79 80H23Z" fill="${F}"/>
    <path d="M17 70H83" stroke="${K}" stroke-width="1.2" opacity=".35"/>
    <circle cx="32" cy="75" r="1.7" fill="${K}" opacity=".6"/><circle cx="44" cy="75" r="1.7" fill="${K}" opacity=".6"/><circle cx="56" cy="75" r="1.7" fill="${K}" opacity=".6"/><circle cx="68" cy="75" r="1.7" fill="${K}" opacity=".6"/>`,

  key: ({ F, A }) => `
    <g transform="rotate(-38 50 50)">
      <circle cx="50" cy="22" r="15" fill="none" stroke="${F}" stroke-width="6.5"/>
      <circle cx="50" cy="22" r="6.5" fill="${A}"/>
      ${sparkle(50, 22, 4, "#fff", ' opacity=".55"')}
      <rect x="46.5" y="36" width="7" height="55" rx="2" fill="${F}"/>
      <rect x="42.5" y="39" width="15" height="5.5" rx="2.75" fill="${A}"/>
      <path d="M53.5 68H66V74.5H60.5V79.5H66V88H53.5Z" fill="${F}"/>
    </g>
    ${sparkle(80, 76, 5, A)}<circle cx="18" cy="80" r="1.6" fill="${F}"/>`,

  eye: ({ F, A, K }) => `
    ${radial(13, 50, 52, (a, i, cx, cy) => {
      const t = -Math.PI * 0.92 + (i / 12) * Math.PI * 0.84;
      const long = i % 2 === 0;
      return `<path d="M${r1(cx + Math.cos(t) * 37)} ${r1(cy + Math.sin(t) * 37)}L${r1(cx + Math.cos(t) * (long ? 48 : 43))} ${r1(cy + Math.sin(t) * (long ? 48 : 43))}" stroke="${F}" stroke-width="${long ? 2 : 1.4}" opacity="${long ? 0.85 : 0.55}" stroke-linecap="round"/>`;
    })}
    <path d="M5 52C24 23 76 23 95 52C76 81 24 81 5 52Z" fill="${K}" fill-opacity=".35" stroke="${F}" stroke-width="3" ${ROUND}/>
    <circle cx="50" cy="52" r="18" fill="${A}"/>
    ${radial(18, 50, 52, (a, i, cx, cy) => `<path d="M${r1(cx + Math.cos(a) * 9)} ${r1(cy + Math.sin(a) * 9)}L${r1(cx + Math.cos(a) * 16.5)} ${r1(cy + Math.sin(a) * 16.5)}" stroke="#000" stroke-width=".8" opacity=".18"/>`)}
    <circle cx="50" cy="52" r="18" fill="none" stroke="${F}" stroke-width="1.2" opacity=".5"/>
    <circle cx="50" cy="52" r="8" fill="#0a0a10"/>
    <circle cx="56" cy="46" r="3.2" fill="#fff" opacity=".92"/><circle cx="45" cy="57" r="1.4" fill="#fff" opacity=".5"/>`,

  tree: ({ F, A, K }) => `
    <path d="M8 90H92" stroke="${F}" stroke-width="2" opacity=".55" stroke-linecap="round"/>
    <path d="M46 89C47 76 47 66 44.5 55H55.5C53 66 53 76 54 89Z" fill="${F}"/>
    <path d="M46 88C40 90 34 90 28 92M54 88C60 90 66 90 72 92" stroke="${F}" stroke-width="2.2" fill="none" ${ROUND}/>
    <path d="M48 60L37 47M52 62L65 45M50 56V38" stroke="${F}" stroke-width="3" ${ROUND}/>
    <circle cx="50" cy="31" r="22" fill="${F}"/><circle cx="29" cy="42" r="15" fill="${F}"/><circle cx="71" cy="42" r="15" fill="${F}"/>
    <circle cx="35" cy="23" r="13" fill="${F}"/><circle cx="65" cy="23" r="13" fill="${F}"/><circle cx="50" cy="47" r="14" fill="${F}"/>
    <path d="M24 46C30 52 40 54 48 52M56 54C64 54 72 50 76 44" stroke="${K}" stroke-width="1.4" opacity=".25" fill="none" ${ROUND}/>
    <circle cx="37" cy="33" r="3.2" fill="${A}"/><circle cx="61" cy="27" r="3.2" fill="${A}"/><circle cx="67" cy="45" r="3" fill="${A}"/>
    <circle cx="44" cy="47" r="2.6" fill="${A}"/><circle cx="53" cy="17" r="2.6" fill="${A}"/><circle cx="27" cy="46" r="2.6" fill="${A}"/><circle cx="76" cy="34" r="2.4" fill="${A}"/>`,

  moon: ({ F, A, K }, P) => `
    <mask id="${P}-mn" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><circle cx="63" cy="40" r="31" fill="#000"/></mask>
    <g mask="url(#${P}-mn)">
      <circle cx="47" cy="51" r="37" fill="${F}"/>
      <circle cx="25" cy="57" r="4.2" fill="${K}" opacity=".2"/><circle cx="33" cy="76" r="3.2" fill="${K}" opacity=".18"/><circle cx="20" cy="41" r="2.6" fill="${K}" opacity=".18"/><circle cx="46" cy="83" r="2.2" fill="${K}" opacity=".16"/>
    </g>
    ${sparkle(72, 66, 7, A)}${sparkle(86, 26, 4.5, A)}${sparkle(60, 86, 3.5, F)}
    <circle cx="78" cy="48" r="1.4" fill="${F}"/><circle cx="90" cy="76" r="1.2" fill="${A}"/>`,

  sun: ({ F, A, K }) => `
    ${radial(16, 50, 50, (a, i, cx, cy) => {
      const ro = i % 2 ? 41 : 48;
      const w = 0.12;
      return `<path d="M${r1(cx + Math.cos(a - w) * 28)} ${r1(cy + Math.sin(a - w) * 28)}L${r1(cx + Math.cos(a) * ro)} ${r1(cy + Math.sin(a) * ro)}L${r1(cx + Math.cos(a + w) * 28)} ${r1(cy + Math.sin(a + w) * 28)}Z" fill="${F}"${i % 2 ? ' opacity=".7"' : ""}/>`;
    })}
    <circle cx="50" cy="50" r="27" fill="${A}"/>
    <circle cx="50" cy="50" r="21" fill="none" stroke="${F}" stroke-width="1.3" opacity=".55"/>
    <circle cx="50" cy="50" r="12" fill="${F}" opacity=".28"/>
    <path d="M36 42C39 36 44 33 50 32.5" fill="none" stroke="#fff" stroke-width="2" opacity=".4" stroke-linecap="round"/>`,

  castle: ({ F, A, K }) => `
    <path d="M6 90H94" stroke="${F}" stroke-width="2" opacity=".5" stroke-linecap="round"/>
    <rect x="13" y="40" width="19" height="50" fill="${F}"/><rect x="68" y="40" width="19" height="50" fill="${F}"/>
    <path d="M10 41.5L22.5 13L35 41.5Z" fill="${A}"/><path d="M65 41.5L77.5 13L90 41.5Z" fill="${A}"/>
    <path d="M22.5 13V5M77.5 13V5" stroke="${F}" stroke-width="1.4"/>
    <path d="M22.5 5L30 7.5L22.5 10ZM77.5 5L85 7.5L77.5 10Z" fill="${A}"/>
    <path d="M32 90V50H38V56H43V50H49V56H51V50H57V56H62V50H68V90Z" fill="${F}"/>
    <path d="M40 56V24H45V29H47.5V24H52.5V29H55V24H60V56Z" fill="${F}"/>
    <path d="M50 24V10" stroke="${F}" stroke-width="1.4"/><path d="M50 10L61 13L50 16Z" fill="${A}"/>
    <path d="M43 90V77A7 7 0 0 1 57 77V90Z" fill="${K}" opacity=".85"/>
    <rect x="20.5" y="52" width="4" height="9" rx="2" fill="${K}" opacity=".75"/><rect x="75.5" y="52" width="4" height="9" rx="2" fill="${K}" opacity=".75"/>
    <rect x="20.5" y="68" width="4" height="9" rx="2" fill="${K}" opacity=".75"/><rect x="75.5" y="68" width="4" height="9" rx="2" fill="${K}" opacity=".75"/>
    <rect x="48" y="35" width="4" height="9" rx="2" fill="${A}"/>`,

  mask: ({ F, A }) => `
    <path d="M80 34C82 20 90 10 99 5C95 16 90 26 84 34Z" fill="${A}"/>
    <path d="M73 31C71 17 75 7 82 1C82 13 80 23 77 31Z" fill="${A}" opacity=".7"/>
    <path d="M50 40C62 30 82 28 92 38C94 54 82 66 66 62C58 60 54 54 50 54C46 54 42 60 34 62C18 66 6 54 8 38C18 28 38 30 50 40Z" fill="${F}"/>
    <path d="M21 46C25 39.5 36 39.5 40 46C36 51 25 51 21 46Z" fill="#0a0a10"/>
    <path d="M60 46C64 39.5 75 39.5 79 46C75 51 64 51 60 46Z" fill="#0a0a10"/>
    <path d="M13 37C23 33 34 33 42 39M87 37C77 33 66 33 58 39" stroke="${A}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <path d="M18 54C24 58 30 58 36 56M82 54C76 58 70 58 64 56" stroke="${A}" stroke-width="1.2" fill="none" opacity=".7" stroke-linecap="round"/>
    <path d="M50 32.5l4 5-4 5-4-5Z" fill="${A}"/>
    <path d="M30 62L17 97" stroke="${A}" stroke-width="3" stroke-linecap="round"/>`,

  feather: ({ F, A, K }) => `
    <path d="M78 5C95 30 83 62 42 86C33 66 41 33 78 5Z" fill="${F}"/>
    <path d="M71 22C75 22 80 20 85 18M67 32C73 32 80 32 86 30M62 42C69 44 76 44 83 44M57 52C63 54 70 56 76 56M51 62C56 64 61 66 66 66M70 24C66 22 64 20 62 20M64 36C58 34 54 34 49 36M58 48C52 48 48 50 43 52M52 60C48 62 44 64 41 68"
      stroke="${K}" stroke-width="1.2" opacity=".28" fill="none" stroke-linecap="round"/>
    <path d="M80 5C70 36 54 64 22 97" stroke="${A}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M14 75C16 80 19 83 19 86A5 5 0 0 1 9 86C9 83 12 80 14 75Z" fill="${A}"/>`,

  heart: ({ F, A }) => `
    <path d="M8 79L92 21" stroke="${F}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M50 87C22 67 12 51 15 36C18 22 37 16 50 32C63 16 82 22 85 36C88 51 78 67 50 87Z" fill="${A}"/>
    <path d="M50 87C22 67 12 51 15 36C18 22 37 16 50 32C63 16 82 22 85 36C88 51 78 67 50 87Z" fill="none" stroke="${F}" stroke-width="1.2" opacity=".45" transform="translate(10 10.6) scale(.8)"/>
    <path d="M25 35C27 29 33 26 38 28" stroke="#fff" stroke-width="2.4" opacity=".5" fill="none" stroke-linecap="round"/>
    <path d="M70 35L92 20" stroke="${F}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M96 18L81 21L88 31Z" fill="${F}"/>
    <path d="M12 76L3 75L7 70L16 73ZM12 76L13 85L18 81L16 73Z" fill="${F}"/>`,

  skull: ({ F, A }) => `
    ${bone(19, 66, 81, 95, 6, A)}${bone(81, 66, 19, 95, 6, A)}
    <path d="M50 11C28 11 17 26 17 43C17 54 22 61 30 65V76Q30 82 36 82H64Q70 82 70 76V65C78 61 83 54 83 43C83 26 72 11 50 11Z" fill="${F}"/>
    <path d="M28 45C28 37 46 37 44 47.5C43 55 30 56 28 45Z" fill="#0a0a10"/>
    <path d="M72 45C72 37 54 37 56 47.5C57 55 70 56 72 45Z" fill="#0a0a10"/>
    <path d="M50 53L45 63Q50 65.5 55 63Z" fill="#0a0a10"/>
    <path d="M40 71V82M46 72V82M52 72V82M58 71V82" stroke="#0a0a10" stroke-width="1.6" opacity=".8"/>
    <path d="M34 71Q50 75.5 66 71" stroke="#0a0a10" stroke-width="1.4" fill="none" opacity=".8"/>
    <path d="M61 13L57 21L61 25" stroke="#0a0a10" stroke-width="1.2" opacity=".35" fill="none"/>
    <path d="M26 30C30 22 36 18 42 17" stroke="#fff" stroke-width="2" opacity=".3" fill="none" stroke-linecap="round"/>`,

  compass: ({ F, A, K }) => `
    <circle cx="50" cy="50" r="43" fill="none" stroke="${F}" stroke-width="1.6" opacity=".75"/>
    <circle cx="50" cy="50" r="37" fill="none" stroke="${F}" stroke-width=".8" opacity=".5"/>
    ${radial(32, 50, 50, (a, i, cx, cy) => {
      const r0 = i % 4 === 0 ? 36 : 39;
      return `<path d="M${r1(cx + Math.cos(a) * r0)} ${r1(cy + Math.sin(a) * r0)}L${r1(cx + Math.cos(a) * 43)} ${r1(cy + Math.sin(a) * 43)}" stroke="${F}" stroke-width="${i % 4 === 0 ? 1.6 : 0.9}" opacity=".8"/>`;
    })}
    ${radial(4, 50, 50, (a, i, cx, cy) => {
      const t = a + Math.PI / 4;
      const tip = [cx + Math.cos(t) * 30, cy + Math.sin(t) * 30];
      const l = [cx + Math.cos(t - Math.PI / 2) * 6, cy + Math.sin(t - Math.PI / 2) * 6];
      const r = [cx + Math.cos(t + Math.PI / 2) * 6, cy + Math.sin(t + Math.PI / 2) * 6];
      return `<path d="M${r1(l[0])} ${r1(l[1])}L${r1(tip[0])} ${r1(tip[1])}L${r1(r[0])} ${r1(r[1])}Z" fill="${A}"/>`;
    })}
    ${radial(4, 50, 50, (a, i, cx, cy) => {
      const t = a - Math.PI / 2;
      const tip = [cx + Math.cos(t) * 46, cy + Math.sin(t) * 46];
      const l = [cx + Math.cos(t - Math.PI / 2) * 8, cy + Math.sin(t - Math.PI / 2) * 8];
      const r = [cx + Math.cos(t + Math.PI / 2) * 8, cy + Math.sin(t + Math.PI / 2) * 8];
      return `<path d="M${r1(l[0])} ${r1(l[1])}L${r1(tip[0])} ${r1(tip[1])}L${cx} ${cy}Z" fill="${F}"/><path d="M${cx} ${cy}L${r1(tip[0])} ${r1(tip[1])}L${r1(r[0])} ${r1(r[1])}Z" fill="${F}" opacity=".62"/>`;
    })}
    <circle cx="50" cy="50" r="5.5" fill="${A}"/><circle cx="50" cy="50" r="2" fill="${K}"/>
    <path d="M50 0L53.5 6H46.5Z" fill="${A}"/>`,

  wave: ({ F, A, B2 }, P) => {
    let scales = "";
    for (let row = 0; row < 7; row++) {
      const y = 50 + row * 8;
      const off = row % 2 ? 14 : 0;
      for (let x = -14 + off; x <= 114; x += 28) {
        scales += `<circle cx="${x}" cy="${y}" r="14" fill="${B2}" stroke="${F}" stroke-width="1.6"/><circle cx="${x}" cy="${y}" r="9.5" fill="none" stroke="${F}" stroke-width="1.3"/><circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${F}" stroke-width="1.1"/>`;
      }
    }
    return `
    <clipPath id="${P}-wv"><circle cx="50" cy="50" r="44"/></clipPath>
    <g clip-path="url(#${P}-wv)">
      <circle cx="66" cy="30" r="13" fill="${A}"/>
      <path d="M8 40C20 36 30 38 40 42M58 46C70 43 82 44 94 48" stroke="${F}" stroke-width="1.2" opacity=".5" fill="none" stroke-linecap="round"/>
      ${scales}
    </g>
    <circle cx="50" cy="50" r="44" fill="none" stroke="${F}" stroke-width="2"/>
    <circle cx="50" cy="50" r="48" fill="none" stroke="${A}" stroke-width=".9" stroke-dasharray="1 3.2" stroke-linecap="round"/>`;
  },

  mountain: ({ F, A, K }) => `
    <circle cx="69" cy="30" r="13" fill="${A}"/>
    <path d="M18 30q3-3 6 0q3-3 6 0M30 21q2.2-2.2 4.4 0q2.2-2.2 4.4 0" stroke="${F}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <path d="M0 88L25 52L37 64L59 34L100 88Z" fill="${F}" opacity=".45"/>
    <path d="M9 88L44 27L80 88Z" fill="${F}"/>
    <path d="M44 27L80 88H53L50 64L56 51Z" fill="${K}" opacity=".26"/>
    <path d="M44 27L35 43L40.5 40.5L44 46L48.5 40L53.5 44Z" fill="#fff" opacity=".9"/>
    <path d="M14 79H38M60 75H86" stroke="${K}" stroke-width="2" opacity=".3" stroke-linecap="round"/>
    <path d="M3 88H97" stroke="${F}" stroke-width="2" stroke-linecap="round"/>`,

  bird: ({ F, A, K }) => `
    <circle cx="33" cy="33" r="17" fill="${A}"/>
    <path d="M50 58C44 44 30 30 5 25C17 35 27 48 33 60Z" fill="${F}"/>
    <path d="M52 56C58 40 72 24 97 17C87 31 77 45 67 57Z" fill="${F}"/>
    <path d="M44 52C36 44 26 37 14 31M58 50C66 40 76 31 88 24" stroke="${K}" stroke-width="1.2" opacity=".3" fill="none" stroke-linecap="round"/>
    <path d="M29 62C39 56 56 54 69 56C75 57 78 54 82 51C83 57 80 62 72 64.5C60 68 45 68 29 62Z" fill="${F}"/>
    <circle cx="78" cy="54" r="6" fill="${F}"/>
    <path d="M83 52L93 54.5L83 57Z" fill="${A}"/>
    <circle cx="79.5" cy="53" r="1.3" fill="#0a0a10"/>
    <path d="M31 62L10 71L21 64.5L8 61L29 60Z" fill="${F}"/>
    <path d="M70 80q2.4-2.4 4.8 0q2.4-2.4 4.8 0" stroke="${F}" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".7"/>`,

  book: ({ F, A, K }) => `
    ${sparkle(50, 13, 7, A)}${sparkle(32, 24, 3.6, A)}${sparkle(69, 22, 4.4, F)}
    <circle cx="40" cy="10" r="1.3" fill="${F}"/><circle cx="60" cy="33" r="1.2" fill="${A}"/><circle cx="25" cy="35" r="1.1" fill="${F}"/>
    <path d="M28 41Q50 22 72 41" stroke="${A}" stroke-width="1.2" opacity=".55" fill="none" stroke-dasharray="1 3" stroke-linecap="round"/>
    <path d="M5 82C26 80 40 84 50 92C60 84 74 80 95 82V89C74 87 60 91 50 97C40 91 26 87 5 89Z" fill="${A}"/>
    <path d="M8 44V84C26 82 40 84 50 90C60 84 74 82 92 84V44" fill="none" stroke="${F}" stroke-width="2" opacity=".55"/>
    <path d="M50 46C40 40 26 38 10 40V80C26 78 40 80 50 86Z" fill="${F}"/>
    <path d="M50 46C60 40 74 38 90 40V80C74 78 60 80 50 86Z" fill="${F}" opacity=".86"/>
    <path d="M16 50C26 48 36 49 44 53M16 57C26 55 36 56 44 60M16 64C26 62 36 63 44 67M16 71C26 69 36 70 44 74M84 50C74 48 64 49 56 53M84 57C74 55 64 56 56 60M84 64C74 62 64 63 56 67M84 71C74 69 64 70 56 74"
      stroke="${K}" stroke-width="1.3" opacity=".28" fill="none" stroke-linecap="round"/>
    <path d="M50 46V86" stroke="${K}" stroke-width="1.2" opacity=".35"/>`,

  ring: ({ F, A, K }) => `
    <ellipse cx="50" cy="66" rx="31" ry="23" fill="none" stroke="${F}" stroke-width="6.5"/>
    <ellipse cx="50" cy="66" rx="31" ry="23" fill="none" stroke="${K}" stroke-width="1" opacity=".3" transform="translate(0 -1.5)"/>
    <path d="M26 74C34 84 66 84 74 74" stroke="#fff" stroke-width="1.6" opacity=".3" fill="none" stroke-linecap="round"/>
    <path d="M39 41L61 41L57 47.5H43Z" fill="${F}"/>
    <path d="M36 29L43.5 19H56.5L64 29L50 45Z" fill="${A}"/>
    <path d="M36 29H64M43.5 19L46.5 29L50 45L53.5 29L56.5 19" stroke="#fff" stroke-width="1" opacity=".55" fill="none" ${ROUND}/>
    ${sparkle(68, 15, 6, "#fff", ' opacity=".85"')}${sparkle(28, 18, 3.5, A)}`,

  flame: ({ F, A }) => `
    <path d="M50 93C27 93 17 77 21 60C25 46 35 40 37 25C45 33 48 41 46 50C52 44 56 30 52 8C71 21 83 44 81 64C79 82 67 93 50 93Z" fill="${A}"/>
    <path d="M50 89C40 89 33 81 35 70C37 62 43 58 45.5 50C52 56 56 62 54 70C58 66 60 62 60 57C67 65 67 76 63 82C59 87 55 89 50 89Z" fill="${F}"/>
    <path d="M50 87C45 87 42 83 43 78C44 74 47 72 48 68C51 71 53 74 52.5 78C55 76 56 74 56 72C58 76 58 80 56 83C54.5 85.5 52.5 87 50 87Z" fill="#fff" opacity=".7"/>
    <circle cx="24" cy="30" r="1.8" fill="${A}"/><circle cx="78" cy="20" r="1.5" fill="${A}"/><circle cx="84" cy="40" r="1.2" fill="${F}"/><circle cx="18" cy="48" r="1.2" fill="${F}"/>`,

  clock: ({ F, A, B2 }) => `
    <path d="M50 8C36 0 19 4 10 17" stroke="${A}" stroke-width="2" stroke-dasharray="3 2.6" fill="none" stroke-linecap="round"/>
    <circle cx="50" cy="12" r="5" fill="none" stroke="${F}" stroke-width="2.4"/>
    <rect x="45.5" y="16" width="9" height="7" rx="2" fill="${F}"/>
    <circle cx="50" cy="59" r="37" fill="${F}"/>
    <circle cx="50" cy="59" r="31" fill="${B2}"/>
    ${radial(60, 50, 59, (a, i, cx, cy) => {
      const big = i % 5 === 0;
      const r0 = big ? (i % 15 === 0 ? 23 : 25) : 28;
      return `<path d="M${r1(cx + Math.cos(a) * r0)} ${r1(cy + Math.sin(a) * r0)}L${r1(cx + Math.cos(a) * 29.5)} ${r1(cy + Math.sin(a) * 29.5)}" stroke="${F}" stroke-width="${big ? (i % 15 === 0 ? 2.4 : 1.6) : 0.6}" opacity="${big ? 1 : 0.6}"/>`;
    })}
    <path d="M50 59L50 39" stroke="${F}" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M50 59L65 68" stroke="${A}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="50" cy="59" r="3.2" fill="${A}"/>
    <path d="M27 44C31 36 38 31 46 29.5" stroke="#fff" stroke-width="1.6" opacity=".25" fill="none" stroke-linecap="round"/>`,

  leaf: ({ F, A, K }) => `
    <path d="M16 86C12 52 36 20 87 13C89 56 62 86 16 86Z" fill="${F}"/>
    <path d="M16 86C38 64 58 42 83 17" stroke="${K}" stroke-width="2" opacity=".4" fill="none" stroke-linecap="round"/>
    <path d="M30 72C30 62 32 54 36 48M40 62C42 52 46 44 50 38M50 52C54 44 58 36 62 30M62 40C65 34 68 28 70 24M28 74C38 74 48 72 56 68M40 62C50 62 60 60 68 54M52 50C60 50 68 46 76 38"
      stroke="${K}" stroke-width="1.3" opacity=".28" fill="none" stroke-linecap="round"/>
    <path d="M16 86L7 95" stroke="${F}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M58 90C60 75 71 66 90 63C90 78 79 90 58 90Z" fill="${A}"/>
    <path d="M58 90C67 81 76 72 88 65" stroke="${K}" stroke-width="1.2" opacity=".35" fill="none" stroke-linecap="round"/>`,

  lantern: ({ F, A }, P) => `
    <circle cx="50" cy="52" r="46" fill="url(#${P}-glow)"/>
    <path d="M50 1V8" stroke="${F}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="50" cy="12" r="4.5" fill="none" stroke="${F}" stroke-width="2.2"/>
    <path d="M34 26H66L58 16H42Z" fill="${F}"/>
    <rect x="31" y="25" width="38" height="4.5" rx="2" fill="${F}"/>
    <rect x="36" y="29" width="28" height="42" rx="2" fill="${A}"/>
    <ellipse cx="50" cy="52" rx="10" ry="14" fill="#fff" opacity=".45"/>
    <path d="M50 39C56 46 57 52 54 57.5C52 60.5 48 60.5 46 57.5C43 52 44 46 50 39Z" fill="#fff"/>
    <path d="M43 29V71M57 29V71" stroke="${F}" stroke-width="2"/>
    <rect x="36" y="29" width="28" height="42" rx="2" fill="none" stroke="${F}" stroke-width="3"/>
    <path d="M31 71H69L62 80H38Z" fill="${F}"/>
    <rect x="43" y="80" width="14" height="4.5" rx="2" fill="${F}"/>`,

  wand: ({ F, A }) => `
    <path d="M24 76C14 62 20 42 38 33C50 27 62 30 68 34" stroke="${A}" stroke-width="1.5" opacity=".6" stroke-dasharray="1 4" fill="none" stroke-linecap="round"/>
    ${sparkle(30, 28, 5, A)}${sparkle(50, 12, 3.2, F)}${sparkle(18, 50, 3.4, A)}${sparkle(86, 58, 4, F)}
    <circle cx="40" cy="20" r="1.3" fill="${F}"/><circle cx="62" cy="14" r="1.1" fill="${A}"/><circle cx="90" cy="40" r="1.2" fill="${A}"/>
    <path d="M17 89L62 44" stroke="${F}" stroke-width="6" stroke-linecap="round"/>
    <path d="M17 89L29 77" stroke="${A}" stroke-width="7.5" stroke-linecap="round"/>
    <path d="M57 49L62 44" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    ${sparkle(73, 33, 16, A)}${sparkle(73, 33, 7, "#fff", ' opacity=".9"')}`,

  fox: ({ F, A }) => `
    <path d="M50 88L20 54L16 13L38 32L50 28L62 32L84 13L80 54Z" fill="${A}"/>
    <path d="M22 21L35 33.5L23.5 44Z" fill="#0a0a10" opacity=".4"/><path d="M78 21L65 33.5L76.5 44Z" fill="#0a0a10" opacity=".4"/>
    <path d="M50 28V60M38 32L50 60L62 32M20 54L38 32M80 54L62 32" stroke="#000" stroke-width="1" opacity=".14" fill="none"/>
    <path d="M50 28L45.5 40L50 47L54.5 40Z" fill="#fff" opacity=".22"/>
    <path d="M50 88L20 54L36 58L50 74L64 58L80 54Z" fill="${F}"/>
    <path d="M32 47.5L42 45.5L38.5 52Z" fill="#0a0a10"/><path d="M68 47.5L58 45.5L61.5 52Z" fill="#0a0a10"/>
    <path d="M44.5 81.5H55.5L50 89Z" fill="#0a0a10"/>`,

  anchor: ({ F, A }) => `
    <path d="M50 21C67 28 67 43 50 49C33 55 33 70 50 77" stroke="${A}" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".9"/>
    <circle cx="50" cy="13" r="7" fill="none" stroke="${F}" stroke-width="4"/>
    <rect x="46.5" y="19" width="7" height="68" rx="2" fill="${F}"/>
    <rect x="29" y="28" width="42" height="6" rx="3" fill="${F}"/>
    <circle cx="29" cy="31" r="4" fill="${F}"/><circle cx="71" cy="31" r="4" fill="${F}"/>
    <path d="M16 58C18 78 32 90 50 90C68 90 82 78 84 58" stroke="${F}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M9 65L16 49L25 63Z" fill="${F}"/><path d="M91 65L84 49L75 63Z" fill="${F}"/>
    <path d="M50 49C40 52.5 37 58 39 64" stroke="${A}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,

  dagger: ({ F, A, K }) => `
    <g transform="rotate(35 50 50)">
      <path d="M50 4C54 18 56 34 54.5 60H45.5C44 34 46 18 50 4Z" fill="${F}"/>
      <path d="M50 4C54 18 56 34 54.5 60H50Z" fill="${K}" opacity=".2"/>
      <path d="M50 12V56" stroke="${K}" stroke-width="1" opacity=".3"/>
      <path d="M30 60C36 55.5 64 55.5 70 60C64 66 36 66 30 60Z" fill="${A}"/>
      <circle cx="29" cy="57.5" r="3.2" fill="${A}"/><circle cx="71" cy="57.5" r="3.2" fill="${A}"/>
      <rect x="46" y="64" width="8" height="20" rx="3" fill="${F}"/>
      <path d="M46 68.5L54 71.5M46 73.5L54 76.5M46 78.5L54 81.5" stroke="${K}" stroke-width="1.1" opacity=".45"/>
      <path d="M50 84l6 6-6 6-6-6Z" fill="${A}"/>
    </g>
    <path d="M84 28C86 33 88 35 88 38A4 4 0 0 1 80 38C80 35 82 33 84 28Z" fill="${A}"/>
    <path d="M89 45C90.4 48.5 91.8 50 91.8 52A2.8 2.8 0 0 1 86.2 52C86.2 50 87.6 48.5 89 45Z" fill="${A}" opacity=".75"/>`,

  hat: ({ F, A, K }) => `
    <ellipse cx="50" cy="88" rx="36" ry="5" fill="#000" opacity=".3"/>
    <path d="M30 74L33.5 20C33.5 15 66.5 15 66.5 20L70 74Z" fill="${F}"/>
    <ellipse cx="50" cy="19.5" rx="16.5" ry="3.8" fill="${K}" opacity=".22"/>
    <path d="M31.4 57H68.6L69.4 70H30.6Z" fill="${A}"/>
    <path d="M39 24L37 66" stroke="#fff" stroke-width="3" opacity=".16" stroke-linecap="round"/>
    <path d="M13 77C13 70.5 30 68.5 50 68.5C70 68.5 87 70.5 87 77C87 83 70 85 50 85C30 85 13 83 13 77Z" fill="${F}"/>
    <path d="M21 75C33 71.5 67 71.5 79 75" stroke="#fff" stroke-width="1.4" opacity=".22" fill="none" stroke-linecap="round"/>
    <g transform="rotate(-14 62 52)">
      <rect x="56" y="40" width="13" height="18" rx="1.6" fill="#fbf7ee"/>
      <path d="M62.5 53C59 50.5 58 48.6 58.6 47.2C59.2 45.8 61.2 45.6 62.5 47.4C63.8 45.6 65.8 45.8 66.4 47.2C67 48.6 66 50.5 62.5 53Z" fill="#c8202f"/>
    </g>`,
};

/* ------------------------------------------------------------------------------------------------
   Cover composition */
const f1 = (v) => Math.round(v * 10) / 10;
const f3 = (v) => Math.round(v * 1000) / 1000;

function normalizeCover(cover, title) {
  const base = coverFromString(title || "");
  const c = cover && typeof cover === "object" ? cover : {};
  const out = {
    bg: safeColor(c.bg, base.bg),
    bg2: safeColor(c.bg2, base.bg2),
    fg: safeColor(c.fg, base.fg),
    accent: safeColor(c.accent, base.accent),
    motif: COVER_MOTIFS.includes(c.motif) ? c.motif : base.motif,
  };
  // Keep the illustration/typography readable whatever colours the data brings.
  const mid = mix(out.bg, out.bg2, 0.5);
  if (contrast(out.fg, mid) < 2.6) out.fg = lum(mid) > 0.3 ? "#16110c" : "#f8f2e4";
  if (contrast(out.accent, mid) < 1.6) out.accent = mix(out.accent, lum(mid) > 0.3 ? "#000000" : "#ffffff", 0.45);
  return out;
}

function palette(c) {
  const light = lum(c.fg) > 0.35; // light ink on a dark cover (the usual case)
  return {
    F: c.fg,
    A: c.accent,
    B2: c.bg2,
    K: light ? mix(c.bg2, "#000000", 0.45) : mix(c.bg, "#ffffff", 0.4),
  };
}

function emblem(motif, cx, cy, size, pal, P) {
  const draw = MOTIFS[motif] || MOTIFS.star;
  return `<g transform="translate(${f1(cx - size / 2)} ${f1(cy - size / 2)}) scale(${f3(size / 100)})">${draw(pal, P)}</g>`;
}

function textBlock(lines, { x, y, size, lh, anchor = "start", family, weight, fill, ls = 0, italic = false, opacity = 1 }) {
  const attrs = `font-family="${family}" font-weight="${weight}" font-size="${f1(size)}"${italic ? ' font-style="italic"' : ""}${ls ? ` letter-spacing="${f3(ls * size)}"` : ""} text-anchor="${anchor}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}`;
  const spans = lines.map((line, i) => `<tspan x="${f1(x)}" y="${f1(y + i * size * lh)}">${esc(line)}</tspan>`).join("");
  return `<text ${attrs}>${spans}</text>`;
}

/** Background decoration behind the emblem (4 variants). */
function decoration(kind, cx, cy, c, rnd) {
  const F = c.fg;
  if (kind === 0) {
    let rays = "";
    const n = 28;
    for (let i = 0; i < n; i += 2) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      rays += `M${f1(cx)} ${f1(cy)}L${f1(cx + Math.cos(a0) * 420)} ${f1(cy + Math.sin(a0) * 420)}L${f1(cx + Math.cos(a1) * 420)} ${f1(cy + Math.sin(a1) * 420)}Z`;
    }
    return `<path d="${rays}" fill="${F}" opacity=".045"/>`;
  }
  if (kind === 1) {
    let rings = "";
    for (let r = 58; r < 330; r += 21) rings += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${r}" fill="none" stroke="${F}" stroke-width="${r % 2 ? 0.7 : 1.1}" opacity="${f3(0.13 - r / 3300)}"/>`;
    return rings;
  }
  if (kind === 2) {
    let dots = "";
    for (let i = 0; i < 46; i++) {
      const x = rnd() * VW;
      const y = rnd() * VH;
      const r = 0.4 + rnd() * rnd() * 1.6;
      dots += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${i % 7 === 0 ? c.accent : F}" opacity="${f3(0.18 + rnd() * 0.5)}"/>`;
    }
    for (let i = 0; i < 4; i++) dots += sparkle(f1(rnd() * VW), f1(rnd() * VH), f1(2.5 + rnd() * 3), F, ' opacity=".5"');
    return dots;
  }
  // kind 3: an arched portal behind the emblem
  const w = 150;
  const top = cy - 105;
  const x0 = cx - w / 2;
  return `<path d="M${f1(x0)} ${f1(cy + 130)}V${f1(top + w / 2)}A${w / 2} ${w / 2} 0 0 1 ${f1(x0 + w)} ${f1(top + w / 2)}V${f1(cy + 130)}Z" fill="${c.bg2}" opacity=".5" stroke="${F}" stroke-opacity=".28" stroke-width="1.2"/>
    <path d="M${f1(x0 + 8)} ${f1(cy + 130)}V${f1(top + w / 2)}A${w / 2 - 8} ${w / 2 - 8} 0 0 1 ${f1(x0 + w - 8)} ${f1(top + w / 2)}V${f1(cy + 130)}" fill="none" stroke="${F}" stroke-opacity=".14" stroke-width=".8"/>`;
}

function ornament(cx, y, color) {
  return `<path d="M${cx - 34} ${y}H${cx - 9}M${cx + 9} ${y}H${cx + 34}" stroke="${color}" stroke-width="1" stroke-linecap="round"/><path d="M${cx} ${y - 4.5}l4.5 4.5-4.5 4.5-4.5-4.5Z" fill="${color}"/><circle cx="${cx - 38}" cy="${y}" r="1.4" fill="${color}"/><circle cx="${cx + 38}" cy="${y}" r="1.4" fill="${color}"/>`;
}

function authorLine(author, { x, y, anchor, fill, maxW, opacity = 0.82, size = 10.5 }) {
  if (!author) return "";
  const fit = fitLine(author, { table: T_UI, maxW, max: size, min: 7.5, ls: 0.2, upper: true });
  return textBlock([fit.text], { x, y, size: fit.size, lh: 1, anchor, family: FONT_UI, weight: 600, fill, ls: 0.2, opacity });
}

/* The four typographic layouts. Each returns the SVG for decoration + emblem + text. */
const LAYOUTS = [
  // 0 — modern: heavy title top-left, big emblem low right, author bottom-left
  (ctx) => {
    const { c, pal, P, title, author, rnd, deco } = ctx;
    const fit = fitText(title, { table: T_DISPLAY, maxW: 210, maxLines: 4, max: 30, min: 14, upper: true });
    const top = 36;
    const y0 = top + fit.size * 0.74;
    const bottom = y0 + (fit.lines.length - 1) * fit.size * 1.06;
    const ey = Math.max(250, bottom + 112);
    const es = Math.min(182, 2 * (346 - ey)); // keep clear of the author line
    return decoration(deco, 150, ey, c, rnd)
      + `<circle cx="150" cy="${f1(ey)}" r="120" fill="url(#${P}-glow)"/>`
      + emblem(c.motif, 150, ey, es, pal, P)
      + textBlock(fit.lines, { x: 24, y: y0, size: fit.size, lh: 1.06, family: FONT_DISPLAY, weight: 800, fill: c.fg })
      + `<rect x="24" y="${f1(bottom + 15)}" width="34" height="3" rx="1.5" fill="${c.accent}"/>`
      + authorLine(author, { x: 24, y: 364, anchor: "start", fill: c.fg, maxW: 200 });
  },
  // 1 — centered medallion with a serif title below
  (ctx) => {
    const { c, pal, P, title, author, rnd, deco } = ctx;
    const fit = fitText(title, { table: T_SERIF, maxW: 206, maxLines: 3, max: 32, min: 15 });
    const lh = 1.13;
    const blockH = (fit.lines.length - 1) * fit.size * lh;
    const y0 = 272 - blockH / 2 + fit.size * 0.34;
    const lastBase = y0 + blockH;
    return decoration(deco === 3 ? 1 : deco, 130, 142, c, rnd)
      + `<rect x="12" y="12" width="236" height="366" rx="4" fill="none" stroke="${c.fg}" stroke-opacity=".22"/>`
      + `<circle cx="130" cy="142" r="112" fill="url(#${P}-glow)"/>`
      + `<circle cx="130" cy="142" r="80" fill="${c.bg2}" fill-opacity=".5" stroke="${c.fg}" stroke-opacity=".5" stroke-width="1.2"/>`
      + `<circle cx="130" cy="142" r="72" fill="none" stroke="${c.accent}" stroke-opacity=".7" stroke-width=".9" stroke-dasharray="1 3.4" stroke-linecap="round"/>`
      + emblem(c.motif, 130, 142, 112, pal, P)
      + textBlock(fit.lines, { x: 130, y: y0, size: fit.size, lh, anchor: "middle", family: FONT_SERIF, weight: 600, fill: c.fg })
      + ornament(130, Math.min(336, lastBase + 20), c.accent)
      + authorLine(author, { x: 130, y: 360, anchor: "middle", fill: c.fg, maxW: 200, size: 10 });
  },
  // 2 — illustration on top, bold colour band with the title at the bottom
  (ctx) => {
    const { c, pal, P, title, author, rnd, deco, h } = ctx;
    const useAccent = (h >>> 5) & 1;
    const band = useAccent ? c.accent : c.fg;
    const ink = [c.bg2, "#0d0d12", "#fbf8f1"].sort((a, b) => contrast(b, band) - contrast(a, band))[0];
    const slant = (h >>> 7) & 1;
    const fit = fitText(title, { table: T_DISPLAY, maxW: 212, maxLines: 3, max: 25, min: 12.5, upper: true });
    // The band grows upward with the title block; the title is centred in the band above the author.
    const lh = 1.06;
    const capH = fit.size * 0.74;
    const blockH = capH + (fit.lines.length - 1) * fit.size * lh;
    const textBottom = author ? 344 : 364;
    const bandTop = Math.min(282, textBottom - blockH - 30);
    const y0 = (bandTop + 22 + textBottom - blockH) / 2 + capH;
    const ey = Math.max(118, bandTop / 2 + 6);
    const es = Math.min(172, bandTop - 46);
    return decoration(deco === 3 ? 0 : deco, 130, ey, c, rnd)
      + `<circle cx="130" cy="${f1(ey)}" r="130" fill="url(#${P}-glow)"/>`
      + emblem(c.motif, 130, ey, es, pal, P)
      + `<path d="${slant ? `M0 ${bandTop + 8}L260 ${bandTop - 10}V390H0Z` : `M0 ${bandTop}H260V390H0Z`}" fill="${band}"/>`
      + `<path d="${slant ? `M0 ${bandTop + 1}L260 ${bandTop - 17}` : `M0 ${bandTop - 6}H260`}" stroke="${band}" stroke-width="1.2" stroke-opacity=".6"/>`
      + textBlock(fit.lines, { x: 24, y: y0, size: fit.size, lh, family: FONT_DISPLAY, weight: 800, fill: ink })
      + authorLine(author, { x: 24, y: 368, anchor: "start", fill: ink, maxW: 212, opacity: 0.78 });
  },
  // 3 — framed classic: double frame, author on top, serif title, emblem below
  (ctx) => {
    const { c, pal, P, title, author } = ctx;
    const fit = fitText(title, { table: T_SERIF, maxW: 192, maxLines: 4, max: 30, min: 14 });
    const lh = 1.12;
    const y0 = 84 + fit.size * 0.72;
    const lastBase = y0 + (fit.lines.length - 1) * fit.size * lh;
    const ey = Math.max(266, lastBase + 84);
    const es = Math.min(132, 2 * (338 - ey)); // keep clear of the bottom ornament
    const corner = (x, y) => `<path d="M${x} ${y - 5}l5 5-5 5-5-5Z" fill="${c.accent}"/>`;
    return `<rect x="12" y="12" width="236" height="366" rx="3" fill="none" stroke="${c.fg}" stroke-opacity=".6" stroke-width="1.4"/>`
      + `<rect x="18.5" y="18.5" width="223" height="353" rx="2" fill="none" stroke="${c.fg}" stroke-opacity=".3" stroke-width=".7"/>`
      + corner(18.5, 18.5) + corner(241.5, 18.5) + corner(18.5, 371.5) + corner(241.5, 371.5)
      + authorLine(author, { x: 130, y: 52, anchor: "middle", fill: c.fg, maxW: 190, size: 10 })
      + `<path d="M108 64H152" stroke="${c.accent}" stroke-width="1"/>`
      + textBlock(fit.lines, { x: 130, y: y0, size: fit.size, lh, anchor: "middle", family: FONT_SERIF, weight: 600, fill: c.fg, italic: true })
      + `<circle cx="130" cy="${f1(ey)}" r="92" fill="url(#${P}-glow)"/>`
      + emblem(c.motif, 130, ey, es, pal, P)
      + `<circle cx="118" cy="352" r="1.6" fill="${c.accent}"/><circle cx="130" cy="352" r="2.2" fill="${c.accent}"/><circle cx="142" cy="352" r="1.6" fill="${c.accent}"/>`;
  },
];

const cache = new Map();
function remember(key, value) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/**
 * A complete, self-contained SVG string for a book cover.
 * @param {object} cover  { bg, bg2, fg, accent, motif } — partial/invalid values are tolerated.
 * @param {object} opts   { title, author, w=260, h=390, idPrefix?, decorative=false, texture=true, layout? }
 */
export function coverSVG(cover, { title = "", author = "", w = 260, h = 390, idPrefix, decorative = false, texture = true, layout } = {}) {
  title = String(title ?? "");
  author = String(author ?? "");
  const c = normalizeCover(cover, title);
  const key = JSON.stringify([c, title, author, w, h, idPrefix || "", decorative, texture, layout ?? -1]);
  if (cache.has(key)) return cache.get(key);

  const hh = hashStr(`${title}|${author}|${c.motif}|${c.bg}`);
  const P = idPrefix ? String(idPrefix).replace(/[^a-zA-Z0-9_-]/g, "") : "bc" + hashStr(key).toString(36);
  const rnd = seeded(hh);
  const L = Number.isInteger(layout) && layout >= 0 && layout < LAYOUTS.length ? layout : hh % LAYOUTS.length;
  const deco = (hh >>> 3) % 4;
  const pal = palette(c);
  const body = LAYOUTS[L]({ c, pal, P, title, author, rnd, deco, h: hh });

  const label = author ? `${title} — ${author}` : title;
  const a11y = decorative ? 'aria-hidden="true" focusable="false"' : `role="img" aria-label="${esc(label)}"`;
  const lightCover = lum(mix(c.bg, c.bg2, 0.5)) > 0.3;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${f1(w)}" height="${f1(h)}" preserveAspectRatio="xMidYMid slice" ${a11y}>`
    + `<defs>`
    + `<linearGradient id="${P}-bg" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${c.bg}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>`
    + `<radialGradient id="${P}-glow"><stop offset="0" stop-color="${c.accent}" stop-opacity=".42"/><stop offset=".45" stop-color="${c.accent}" stop-opacity=".12"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${P}-vig" cx=".55" cy=".42" r=".78"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${lightCover ? 0.22 : 0.42}"/></radialGradient>`
    + `<linearGradient id="${P}-spine" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset=".35" stop-color="#000" stop-opacity=".16"/><stop offset=".62" stop-color="#fff" stop-opacity=".1"/><stop offset=".78" stop-color="#000" stop-opacity=".14"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>`
    + `<linearGradient id="${P}-gloss" x1="0" y1="0" x2=".9" y2=".75"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".3" stop-color="#fff" stop-opacity=".06"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + (texture ? `<filter id="${P}-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="${hh % 97}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>` : "")
    + `<clipPath id="${P}-clip"><rect width="${VW}" height="${VH}" rx="7"/></clipPath>`
    + `</defs>`
    + `<g clip-path="url(#${P}-clip)">`
    + `<rect width="${VW}" height="${VH}" fill="url(#${P}-bg)"/>`
    + body
    + (texture ? `<rect width="${VW}" height="${VH}" filter="url(#${P}-grain)" opacity="${lightCover ? 0.16 : 0.12}" style="mix-blend-mode:overlay"/>` : "")
    + `<rect width="${VW}" height="${VH}" fill="url(#${P}-vig)"/>`
    + `<rect width="20" height="${VH}" fill="url(#${P}-spine)"/>`
    + `<path d="M0 0H${VW}V150C176 118 88 164 0 126Z" fill="url(#${P}-gloss)"/>`
    + `<rect x=".5" y=".5" width="${VW - 1}" height="${VH - 1}" rx="6.5" fill="none" stroke="#fff" stroke-opacity=".1"/>`
    + `</g></svg>`;
  return remember(key, svg);
}

/** Small thumbnail (for search suggestions): gradient, emblem, spine. No text. */
export function miniCoverSVG(cover, { title = "", w = 40, h = 60, idPrefix } = {}) {
  const c = normalizeCover(cover, String(title ?? ""));
  const key = JSON.stringify(["mini", c, w, h, idPrefix || ""]);
  if (cache.has(key)) return cache.get(key);
  const P = idPrefix ? String(idPrefix).replace(/[^a-zA-Z0-9_-]/g, "") : "mc" + hashStr(key).toString(36);
  const pal = palette(c);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 60" width="${f1(w)}" height="${f1(h)}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="${P}-bg" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${c.bg}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>`
    + `<radialGradient id="${P}-glow"><stop offset="0" stop-color="${c.accent}" stop-opacity=".45"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="${P}-sp" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>`
    + `<clipPath id="${P}-clip"><rect width="40" height="60" rx="3"/></clipPath></defs>`
    + `<g clip-path="url(#${P}-clip)"><rect width="40" height="60" fill="url(#${P}-bg)"/>`
    + `<circle cx="20" cy="29" r="19" fill="url(#${P}-glow)"/>`
    + emblem(c.motif, 20, 29, 29, pal, P)
    + `<rect x="7" y="50" width="26" height="1.6" rx=".8" fill="${c.fg}" opacity=".55"/>`
    + `<rect width="4" height="60" fill="url(#${P}-sp)"/>`
    + `<path d="M0 0H40V22C27 17 13 25 0 19Z" fill="#fff" opacity=".08"/>`
    + `<rect x=".35" y=".35" width="39.3" height="59.3" rx="2.7" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width=".7"/>`
    + `</g></svg>`;
  return remember(key, svg);
}

/** Exposed for tests / dev pages. */
export const COVER_LAYOUT_COUNT = LAYOUTS.length;
