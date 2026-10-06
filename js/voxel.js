// BookTrip — voxel character engine (owner: voxel).
//
// Characters are modelled on an integer voxel grid (1 unit = 1 voxel, feet at y=0, facing +z) and
// meshed per animated part with hidden-face culling, baked per-vertex voxel ambient occlusion and a
// tiny deterministic colour jitter per voxel, so figures look hand-built rather than flat.
// Each part becomes at most one mesh per material, all parts share a handful of materials.
//
// Public API (SPEC §4):
//   buildCharacter(appearance, opts?)      → THREE.Group (userData.parts = {head, body, armL, armR, legL, legR, held, …})
//   renderPortrait(appearance, {size, background, pose}) → Promise<PNG data URL> (one shared offscreen renderer)
//   createViewer(container, appearance, opts?) → { dispose(), setAppearance(a), setAction(name), renderer }
//   animateCharacter(group, action, t)
//   normalizeAppearance(a)                 → complete, valid Appearance (never throws)
// Extras: disposeCharacter(group), portraitStats(), clearPortraitCache(), ACTIONS.

import * as THREE from "three";
import { hashStr, safeColor, prefersReducedMotion } from "./util.js";
import {
  CREATURES, GENDERS, AGES, BUILDS, HAIR_STYLES, FACIAL_HAIR, TOP_KINDS, PATTERNS, BOTTOM_KINDS,
  HEADWEAR, ACCESSORIES, HOLDING, DEFAULT_APPEARANCE,
} from "./enums.js";

export const ACTIONS = ["idle", "talk", "walk", "dance", "fight", "wave", "sad", "celebrate"];

// =================================================================================================
// Appearance normalisation
// =================================================================================================

const ALIAS = {
  creature: {
    person: "human", man: "human", woman: "human", boy: "human", girl: "human", kid: "human", fairy: "elf",
    gnome: "dwarf", halfling: "hobbit", kitten: "cat", kitty: "cat", tiger: "cat", panther: "cat", leopard: "cat",
    puppy: "dog", hound: "dog", hare: "rabbit", bunny: "rabbit", rat: "mouse", pony: "horse", unicorn: "horse",
    donkey: "horse", android: "robot", automaton: "robot", machine: "robot", spirit: "ghost", phantom: "ghost",
    raven: "bird", crow: "bird", parrot: "bird", eagle: "bird", sparrow: "bird", swallow: "bird", piglet: "pig",
    hog: "pig", boar: "pig", serpent: "snake", python: "snake", wyvern: "dragon", lioness: "lion", cub: "bear",
  },
  gender: { man: "male", boy: "male", m: "male", woman: "female", girl: "female", f: "female", other: "neutral", unknown: "neutral" },
  age: { kid: "child", baby: "child", young: "teen", teenager: "teen", youth: "teen", old: "elder", elderly: "elder", senior: "elder", middle_aged: "adult" },
  build: { thin: "slim", skinny: "slim", fat: "broad", stout: "broad", heavy: "broad", muscular: "broad", plump: "broad", big: "broad", short: "small", tiny: "small", petite: "small" },
  hair: {
    bald: "none", shaved: "none", buzz: "short", crew_cut: "short", pixie: "short", afro: "curly", curls: "curly",
    dreadlocks: "braids", braid: "braids", pigtails: "braids", plait: "braids", top_knot: "bun", updo: "bun",
    pony_tail: "ponytail", straight: "long", wild: "messy", tousled: "messy", shaggy: "messy", spikes: "spiky",
    waves: "wavy", bobbed: "bob",
  },
  facial: { moustache: "mustache", whiskers: "mustache", goatee: "beard", full_beard: "beard", longbeard: "long_beard", long: "long_beard", shadow: "stubble" },
  top: {
    blouse: "shirt", t_shirt: "tshirt", tee: "tshirt", hoodie: "sweater", jumper: "sweater", cardigan: "sweater",
    blazer: "jacket", uniform: "jacket", tailcoat: "suit", tuxedo: "suit", overcoat: "coat", trench_coat: "coat",
    cloak: "robe", kimono: "robe", toga: "robe", frock: "dress", sundress: "dress", ball_gown: "gown",
    chainmail: "armor", armour: "armor", mail: "armor", waistcoat: "vest", doublet: "tunic", jerkin: "tunic",
    tabard: "tunic", smock: "tunic",
  },
  pattern: {
    striped: "stripes", stripe: "stripes", checked: "checks", check: "checks", plaid: "checks", tartan: "checks",
    polka: "dots", polka_dots: "dots", dotted: "dots", spotted: "dots", embroidered: "embroidery", ornate: "embroidery",
    none: "plain", solid: "plain",
  },
  bottom: { trousers: "pants", jeans: "pants", breeches: "pants", leggings: "pants", kilt: "skirt", dress: "skirt", gown: "robe" },
  headwear: {
    hat: "top_hat", bowler: "top_hat", bowler_hat: "top_hat", witch_hat: "wizard_hat", pointed_hat: "wizard_hat",
    baseball_cap: "cap", deerstalker: "cap", ribbon: "bow", hair_bow: "bow", cowl: "hood", circlet: "tiara",
    diadem: "tiara", wreath: "flower_wreath", flower_crown: "flower_wreath", cavalier_hat: "feather_hat",
    musketeer_hat: "feather_hat", plumed_hat: "feather_hat", pirate_hat: "tricorn", tricorne: "tricorn",
    bicorne: "tricorn", sun_hat: "straw_hat", sombrero: "straw_hat", boater: "straw_hat", knit_cap: "beanie",
    toque: "beanie", kerchief: "headscarf", scarf: "headscarf", veil: "headscarf", turban: "headscarf",
    hijab: "headscarf", headband: "bandana", bandanna: "bandana", helm: "helmet",
  },
  accessory: {
    spectacles: "glasses", eyeglasses: "glasses", sunglasses: "glasses", round_spectacles: "round_glasses",
    cloak: "cape", mantle: "cape", rucksack: "backpack", bag: "backpack", satchel: "backpack", pendant: "necklace",
    amulet: "necklace", locket: "necklace", beads: "necklace", eye_patch: "eyepatch", necktie: "tie",
    bow_tie: "bowtie", sword: "belt_sword", sword_belt: "belt_sword", scabbard: "belt_sword", wing: "wings",
    muffler: "scarf",
  },
  holding: {
    bow: "bow_weapon", longbow: "bow_weapon", crossbow: "bow_weapon", magic_wand: "wand", stick: "wand",
    cane: "staff", walking_stick: "staff", rod: "staff", scepter: "staff", sceptre: "staff", dagger: "sword",
    knife: "sword", saber: "sword", sabre: "sword", blade: "sword", axe: "sword", epee: "rapier", foil: "rapier",
    gun: "pistol", revolver: "pistol", musket: "pistol", flintlock: "pistol", spyglass: "telescope",
    lamp: "lantern", torch: "candle", scroll: "map", journal: "book", diary: "book", notebook: "book", tome: "book",
    envelope: "letter", note: "letter", mug: "cup", teacup: "cup", goblet: "cup", chalice: "cup",
    flowers: "flower", bouquet: "flower", tulip: "flower", daisy: "flower", mic: "microphone",
    magnifying_glass: "magnifier", lens: "magnifier", lance: "spear", trident: "spear", pike: "spear",
    pitchfork: "spear", smoking_pipe: "pipe",
  },
};

const NAMED_COLORS = {
  black: "#1c1a1a", white: "#f4f2ee", red: "#c83a3a", green: "#4f9a3f", blue: "#3a6ea5", yellow: "#f2c94c",
  orange: "#e8862e", purple: "#7a4fa0", pink: "#f08aa8", brown: "#7a4a2a", grey: "#8a8a8a", gray: "#8a8a8a",
  gold: "#e3b341", silver: "#c9ced6", navy: "#253a66", beige: "#e3d3b0",
};

function enumVal(v, list, fallback, alias) {
  if (typeof v !== "string") return fallback;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  // also try without filler words: "long hair" → long, "a wizard hat" → wizard_hat
  const bare = k.replace(/^(a|an|the)_/, "").replace(/_(hair|hairstyle|style|colou?r|clothes)$/, "").replace(/s$/, "");
  for (const c of [k, bare]) {
    if (list.includes(c)) return c;
    const al = alias && Object.prototype.hasOwnProperty.call(alias, c) ? alias[c] : null;
    if (al && list.includes(al)) return al;
  }
  return fallback;
}

function colorVal(v, fallback) {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (/^[0-9a-f]{6}$/.test(s) || /^[0-9a-f]{3}$/.test(s)) return safeColor("#" + s, fallback);
    if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  }
  return safeColor(v, fallback);
}

const asObj = (v, key) => (typeof v === "string" ? { [key]: v } : v && typeof v === "object" ? v : {});

/** Fill / clamp any partial or invalid Appearance. Never throws; always returns a fresh object. */
export function normalizeAppearance(input) {
  const D = DEFAULT_APPEARANCE;
  try {
    const s = input && typeof input === "object" ? input : {};
    const hair = asObj(s.hair, "style"), top = asObj(s.top, "kind"), bottom = asObj(s.bottom, "kind");
    return {
      creature: enumVal(s.creature, CREATURES, D.creature, ALIAS.creature),
      gender: enumVal(s.gender, GENDERS, D.gender, ALIAS.gender),
      age: enumVal(s.age, AGES, D.age, ALIAS.age),
      build: enumVal(s.build, BUILDS, D.build, ALIAS.build),
      skin: colorVal(s.skin, D.skin),
      hair: { style: enumVal(hair.style, HAIR_STYLES, D.hair.style, ALIAS.hair), color: colorVal(hair.color, D.hair.color) },
      facialHair: enumVal(s.facialHair, FACIAL_HAIR, D.facialHair, ALIAS.facial),
      eyes: colorVal(s.eyes, D.eyes),
      top: {
        kind: enumVal(top.kind, TOP_KINDS, D.top.kind, ALIAS.top),
        color: colorVal(top.color, D.top.color),
        accent: colorVal(top.accent, D.top.accent),
        pattern: enumVal(top.pattern, PATTERNS, D.top.pattern, ALIAS.pattern),
      },
      bottom: { kind: enumVal(bottom.kind, BOTTOM_KINDS, D.bottom.kind, ALIAS.bottom), color: colorVal(bottom.color, D.bottom.color) },
      shoes: colorVal(s.shoes, D.shoes),
      headwear: enumVal(s.headwear, HEADWEAR, D.headwear, ALIAS.headwear),
      headwearColor: colorVal(s.headwearColor, D.headwearColor),
      accessory: enumVal(s.accessory, ACCESSORIES, D.accessory, ALIAS.accessory),
      accessoryColor: colorVal(s.accessoryColor, D.accessoryColor),
      holding: enumVal(s.holding, HOLDING, D.holding, ALIAS.holding),
    };
  } catch {
    return JSON.parse(JSON.stringify(D));
  }
}

// =================================================================================================
// Colour helpers (sRGB integers 0xRRGGBB)
// =================================================================================================

const cl8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const R8 = (c) => (c >> 16) & 255, G8 = (c) => (c >> 8) & 255, B8 = (c) => c & 255;
const pack = (r, g, b) => (cl8(r) << 16) | (cl8(g) << 8) | cl8(b);
const hexInt = (hex) => parseInt(hex.slice(1), 16);
const mix = (a, b, t) => pack(R8(a) + (R8(b) - R8(a)) * t, G8(a) + (G8(b) - G8(a)) * t, B8(a) + (B8(b) - B8(a)) * t);
const mul = (c, f) => pack(R8(c) * f, G8(c) * f, B8(c) * f);
const luma = (c) => (0.2126 * R8(c) + 0.7152 * G8(c) + 0.0722 * B8(c)) / 255;
const cdist = (a, b) => Math.hypot(R8(a) - R8(b), G8(a) - G8(b), B8(a) - B8(b));
/** Darker shade with a slight cool shift (reads better than plain black-mixing). */
const shade = (c, f) => mix(mul(c, f), 0x2a2140, (1 - f) * 0.18);
/** `c` unless it looks like an unset near-black default, then `fb`. */
const orDefault = (c, fb) => (luma(c) < 0.16 ? fb : c);
/** `c` unless it is exactly an "unset" default (#222222 / #000000), then `fb`. */
const unsetOr = (c, fb) => (c === 0x222222 || c === 0x000000 ? fb : c);

const K = {
  white: 0xffffff, ink: 0x1d1714, wood: 0x8a5a33, woodDark: 0x5a3820, gold: 0xe6b440, goldDark: 0xb98a2c,
  steel: 0xd3d9e0, steelDark: 0x8f99a5, paper: 0xf4ead2, leather: 0x6a4127, red: 0xd2393f, leaf: 0x5aa647,
  leafDark: 0x3f8a3a, glow: 0xffd77a, flame: 0xffb43c, cream: 0xf5efe4, pink: 0xf28aa0, bone: 0xf1e4c6,
  brass: 0xcf9e3e, beak: 0xf0a33a,
};

function hash3(x, y, z, s) {
  let h = (s ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const mod = (n, m) => ((n % m) + m) % m;
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// =================================================================================================
// Voxel container + mesher
// =================================================================================================

const MAT_SOLID = 0, MAT_METAL = 1, MAT_GLOW = 2, MAT_GHOST = 3, MAT_GLASS = 4;
const TRANSPARENT = [false, false, false, true, true];
const MSHIFT = 0x1000000;

const key = (x, y, z) => ((x + 256) * 512 + (y + 256)) * 512 + (z + 256);
const kx = (k) => Math.floor(k / 262144) - 256;
const ky = (k) => (Math.floor(k / 512) % 512) - 256;
const kz = (k) => (k % 512) - 256;

class Vox {
  constructor(seed = 1, amp = 0.05) {
    this.m = new Map();   // key → colour + material * 2^24
    this.d = [];          // free-form "detail" boxes: x0,y0,z0,x1,y1,z1,colour,material (flat arrays)
    this.seed = seed;
    this.amp = amp;
  }
  set(x, y, z, c, mat = MAT_SOLID, amp = this.amp) {
    if (c == null || c < 0) return this;
    if (amp > 0) c = mul(c, 1 + (hash3(x, y, z, this.seed) - 0.5) * 2 * amp);
    this.m.set(key(x, y, z), c + mat * MSHIFT);
    return this;
  }
  has(x, y, z) { return this.m.has(key(x, y, z)); }
  get(x, y, z) { const v = this.m.get(key(x, y, z)); return v === undefined ? -1 : v % MSHIFT; }
  del(x, y, z) { this.m.delete(key(x, y, z)); return this; }
  /** Inclusive box; `c` may be a function (x,y,z) → colour (or -1 to skip). */
  box(x0, x1, y0, y1, z0, z1, c, mat = MAT_SOLID, amp = this.amp) {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const fn = typeof c === "function";
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const col = fn ? c(x, y, z) : c;
      if (col != null && col >= 0) this.set(x, y, z, col, mat, amp);
    }
    return this;
  }
  paint(x, y, z, c, amp = this.amp) {
    const v = this.m.get(key(x, y, z));
    if (v !== undefined) this.set(x, y, z, c, Math.floor(v / MSHIFT), amp);
    return this;
  }
  det(x0, y0, z0, x1, y1, z1, c, mat = MAT_SOLID, amp = 0) {
    if (amp > 0) c = mul(c, 1 + (hash3(Math.floor(x0 * 3), Math.floor(y0 * 3), Math.floor(z0 * 3), this.seed) - 0.5) * 2 * amp);
    this.d.push(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1), c, mat);
    return this;
  }
}

// Face table: axis a, sign s, tangent axes b,c and the 4 corners (CCW seen from outside).
const FACES = [];
for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
  const b = (a + 1) % 3, c = (a + 2) % 3;
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  if (s < 0) corners.reverse();
  const n = [0, 0, 0]; n[a] = s;
  const cs = corners.map(([u, w]) => {
    const v = [0, 0, 0]; v[a] = s > 0 ? 1 : 0; v[b] = u; v[c] = w;
    const s1 = n.slice(); s1[b] += u ? 1 : -1;
    const s2 = n.slice(); s2[c] += w ? 1 : -1;
    const cr = n.slice(); cr[b] += u ? 1 : -1; cr[c] += w ? 1 : -1;
    return { v, s1, s2, cr };
  });
  FACES.push({ n, cs });
}
const AO_CURVE = [0.56, 0.72, 0.87, 1];
const SRGB = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

function bucket(out, mat) {
  let b = out.get(mat);
  if (!b) out.set(mat, (b = { p: [], n: [], c: [], i: [] }));
  return b;
}

/** Mesh one part: culled voxel faces with AO (occupancy `occ` = Set of keys) + detail boxes. */
function meshVox(vox, pivot, occ) {
  const out = new Map();
  const [px, py, pz] = pivot;
  const m = vox.m;
  const ao = [0, 0, 0, 0];
  for (const [k, val] of m) {
    const x = kx(k), y = ky(k), z = kz(k);
    const mat = Math.floor(val / MSHIFT), col = val % MSHIFT;
    const r = SRGB[R8(col)], g = SRGB[G8(col)], bl = SRGB[B8(col)];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
      const nv = m.get(key(nx, ny, nz));
      if (nv !== undefined) {
        const nm = Math.floor(nv / MSHIFT);
        if (nm === mat || !TRANSPARENT[nm]) continue;
      }
      const B = bucket(out, mat);
      const base = B.p.length / 3;
      for (let ci = 0; ci < 4; ci++) {
        const C = F.cs[ci];
        const o1 = occ.has(key(x + C.s1[0], y + C.s1[1], z + C.s1[2])) ? 1 : 0;
        const o2 = occ.has(key(x + C.s2[0], y + C.s2[1], z + C.s2[2])) ? 1 : 0;
        const o3 = occ.has(key(x + C.cr[0], y + C.cr[1], z + C.cr[2])) ? 1 : 0;
        const lvl = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
        ao[ci] = lvl;
        const s = AO_CURVE[lvl];
        B.p.push(x + C.v[0] - px, y + C.v[1] - py, z + C.v[2] - pz);
        B.n.push(F.n[0], F.n[1], F.n[2]);
        B.c.push(r * s, g * s, bl * s);
      }
      if (ao[0] + ao[2] > ao[1] + ao[3]) B.i.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      else B.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const d = vox.d;
  for (let i = 0; i < d.length; i += 8) {
    const mat = d[i + 7], col = d[i + 6];
    const B = bucket(out, mat);
    const lo = [d[i] - px, d[i + 1] - py, d[i + 2] - pz], hi = [d[i + 3] - px, d[i + 4] - py, d[i + 5] - pz];
    const r = SRGB[R8(col)], g = SRGB[G8(col)], bl = SRGB[B8(col)];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const base = B.p.length / 3;
      for (let ci = 0; ci < 4; ci++) {
        const v = F.cs[ci].v;
        B.p.push(v[0] ? hi[0] : lo[0], v[1] ? hi[1] : lo[1], v[2] ? hi[2] : lo[2]);
        B.n.push(F.n[0], F.n[1], F.n[2]);
        B.c.push(r, g, bl);
      }
      B.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geos = new Map();
  for (const [mat, B] of out) {
    if (!B.i.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(B.p, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(B.n, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(B.c, 3));
    geo.setIndex(B.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(B.i, 1) : new THREE.Uint16BufferAttribute(B.i, 1));
    geo.computeBoundingSphere();
    geos.set(mat, geo);
  }
  return geos;
}

let MATS = null;
// Lambert/Phong keep the soft diffuse voxel look, are cheap to shade and need no renderer-global LUTs.
function materials() {
  if (!MATS) {
    MATS = [
      new THREE.MeshLambertMaterial({ vertexColors: true }),
      new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x8a8a8a, shininess: 46 }),
      new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.74, emissive: 0x8fd8ff, emissiveIntensity: 0.32 }),
      new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.32, depthWrite: false }),
    ];
    MATS.forEach((m, i) => { m.name = "voxel-" + ["solid", "metal", "glow", "ghost", "glass"][i]; });
  }
  return MATS;
}

// =================================================================================================
// Character design: appearance → voxel parts
// =================================================================================================

const ANTHRO = new Set(["fox", "cat", "dog", "rabbit", "bear", "mouse", "wolf", "pig", "lion"]);
const LIMB_PARTS = ["body", "head", "armL", "armR", "legL", "legR", "held", "eyes", "mouth", "mouthOpen"];
const PARENT_OF = { body: "rig", legL: "rig", legR: "rig", head: "body", armL: "body", armR: "body", held: "armR", eyes: "head", mouth: "head", mouthOpen: "head" };
const SWINGS = new Set(["sword", "rapier", "spear", "staff", "wand"]);

function palette(a) {
  const P = {
    skin: hexInt(a.skin), hair: hexInt(a.hair.color), eyes: hexInt(a.eyes), top: hexInt(a.top.color),
    accent: hexInt(a.top.accent), bottom: hexInt(a.bottom.color), shoes: hexInt(a.shoes),
    hw: hexInt(a.headwearColor), acc: hexInt(a.accessoryColor),
  };
  if (a.creature === "ghost") {
    for (const k of ["skin", "hair", "top", "accent", "bottom", "shoes", "hw", "acc"]) P[k] = mix(P[k], 0xd6efff, 0.45);
    P.eyes = 0x2a3550;
  }
  return P;
}

function addPart(ctx, name, parent, pivot, rest = [0, 0, 0], local = false) {
  const vox = new Vox(ctx.seed ^ hashStr(name));
  ctx.parts[name] = { name, parent, pivot, rest, vox, local };
  return vox;
}

function design(appearance) {
  const a = normalizeAppearance(appearance);
  const ctx = {
    a, seed: hashStr(JSON.stringify(a)) || 7, pal: palette(a), parts: {}, hairKeys: new Set(),
    kind: "biped", A: null, D: null, float: 0,
  };
  const cr = a.creature;
  if (cr === "snake") designSnake(ctx);
  else if (cr === "horse") designHorse(ctx);
  else if (cr === "owl" || cr === "bird") designBird(ctx);
  else designBiped(ctx);
  if (ctx.A) {
    buildHeadwear(ctx);
    let top = ctx.A.hairTop + 1;
    const hv = ctx.parts.head.vox;
    for (const k of hv.m.keys()) top = Math.max(top, ky(k) + 1);
    for (let i = 4; i < hv.d.length; i += 8) top = Math.max(top, hv.d[i]);
    ctx.A.top = top;
  }
  buildAccessory(ctx);
  buildHeld(ctx);
  for (const name of LIMB_PARTS) {
    if (ctx.parts[name]) continue;
    const parent = PARENT_OF[name];
    const pp = parent === "rig" ? [0, 0, 0] : ctx.parts[parent] ? ctx.parts[parent].pivot : [0, 0, 0];
    addPart(ctx, name, ctx.parts[parent] || parent === "rig" ? parent : "rig", pp.slice());
  }
  if (cr === "ghost") {
    for (const p of Object.values(ctx.parts)) {
      if (p.name === "eyes" || p.name === "mouth" || p.name === "mouthOpen") continue;
      for (const [k, v] of p.vox.m) if (Math.floor(v / MSHIFT) === MAT_SOLID) p.vox.m.set(k, (v % MSHIFT) + MAT_GHOST * MSHIFT);
      for (let i = 7; i < p.vox.d.length; i += 8) if (p.vox.d[i] === MAT_SOLID) p.vox.d[i] = MAT_GHOST;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Bipeds: humans, elves, dwarves, hobbits, ghosts, robots, dragons and dressed-up animals
// ---------------------------------------------------------------------------------------------

function designBiped(ctx) {
  const { a, pal } = ctx;
  const cr = a.creature;
  const animal = ANTHRO.has(cr);
  let legH = 6, torsoH = 7, bw = 8, bd = 5, armW = 2, legW = 3;
  const hw = 10, hd = 9;
  let hh = 10;
  if (a.age === "child") { legH = 4; torsoH = 5; bw = 6; hh = 9; }
  else if (a.age === "teen") { legH = 5; torsoH = 6; }
  else if (a.age === "elder") { legH = 5; }
  if (a.build === "slim") bw -= 2;
  else if (a.build === "broad") { bw += 2; bd += 2; armW = 3; legW = 4; }
  else if (a.build === "small") { legH -= 1; torsoH -= 1; }
  else if (a.build === "tall") { legH += 2; torsoH += 1; }
  if (cr === "dwarf") { legH -= 2; torsoH -= 1; bw = Math.max(bw, 8) + 2; bd = 7; armW = 3; legW = 4; }
  if (cr === "hobbit") { legH -= 2; torsoH -= 1; bd = 7; }
  if (cr === "elf") legH += 1;
  if ((cr === "bear" || cr === "pig") && a.build !== "broad") { bw += 2; bd = 7; legW = 4; }
  if (cr === "mouse") { legH -= 1; torsoH -= 1; }
  if (cr === "dragon") { bd = 7; bw = Math.max(bw, 8); legW = Math.max(legW, 3); }
  if (cr === "robot") { bd = 7; }
  legH = clampN(legH, 3, 9); torsoH = clampN(torsoH, 4, 9); bw = clampN(bw, 6, 12);
  legW = Math.min(legW, bw / 2);
  const armLen = torsoH - 1;
  const hy = legH + torsoH;
  const bx0 = -bw / 2, bx1 = bw / 2 - 1, bz0 = -(bd - 1) / 2, bz1 = (bd - 1) / 2;
  const X0 = -hw / 2, X1 = hw / 2 - 1, Y0 = hy, Y1 = hy + hh - 1, Z0 = -(hd - 1) / 2, Z1 = (hd - 1) / 2;
  const zc = 0.5;
  ctx.D = { legH, torsoH, bw, bd, armW, legW, armLen, hy, bx0, bx1, bz0, bz1, zc };
  ctx.A = {
    X0, X1, Y0, Y1, Z0, Z1, FZ: Z1 + 1, eyeY: Y0 + 3, eyeXR: -3, eyeXL: 1, mouthY: Y0 + 1.45, mouthZ: Z1 + 1,
    blushY: Y0 + 2, hairTop: Y1, faceZ: Z1 + 1,
  };
  ctx.animal = animal;
  ctx.topKind = cr === "robot" ? "robot" : cr === "dragon" ? "dragon"
    : animal && cdist(pal.top, pal.skin) < 30 ? "fur" : a.top.kind;
  ctx.bottomKind = (animal || cr === "dragon" || cr === "robot") && (a.bottom.kind === "none" || cdist(pal.bottom, pal.skin) < 30) ? "fur" : a.bottom.kind;
  if (cr === "dragon" || cr === "robot") ctx.bottomKind = "fur";
  if (cr === "ghost") ctx.float = 2.2;

  const elder = a.age === "elder";
  addPart(ctx, "body", "rig", [0, legH, zc], elder ? [0.12, 0, 0] : [0, 0, 0]);
  addPart(ctx, "legR", "rig", [-legW / 2, legH, zc]);
  addPart(ctx, "legL", "rig", [legW / 2, legH, zc]);
  addPart(ctx, "head", "body", [0, hy, zc], elder ? [-0.1, 0, 0] : [0, 0, 0]);
  addPart(ctx, "armR", "body", [bx0 - armW / 2, hy - 0.5, zc], [0, 0, -0.05]);
  addPart(ctx, "armL", "body", [bx1 + 1 + armW / 2, hy - 0.5, zc], [0, 0, 0.05]);
  ctx.hand = [bx0 - armW / 2, hy - armLen + 1, zc];

  if (cr !== "ghost") buildLegs(ctx);
  buildTorso(ctx);
  buildArms(ctx);
  if (cr === "robot") buildRobotHead(ctx);
  else if (cr === "dragon") buildDragonHead(ctx);
  else if (animal) buildAnimalHead(ctx);
  else buildHumanHead(ctx);
  if (!animal && cr !== "robot" && cr !== "dragon") {
    buildHair(ctx);
    buildFacialHair(ctx);
    if (cr === "elf" || cr === "hobbit") buildEars(ctx);
  }
  faceFeatures(ctx);
  if (animal || cr === "dragon") buildTail(ctx);
  if (cr === "dragon") buildWings(ctx, "bat", mix(pal.skin, 0x2a1a3a, 0.25), mix(pal.skin, 0xffe2a8, 0.18));
}

function legPalette(ctx) {
  const { a, pal } = ctx;
  const cr = a.creature;
  const dark = cr === "fox" ? 0x3b2a24 : cr === "wolf" ? shade(pal.skin, 0.62) : null;
  return { dark };
}

function buildLegs(ctx) {
  const { a, pal, D } = ctx;
  const { legH, legW } = D;
  const cr = a.creature;
  const bk = ctx.bottomKind;
  const top = ctx.topKind;
  const covered = top === "gown" || top === "robe" || bk === "robe";
  const { dark } = legPalette(ctx);
  const animalFeet = ctx.animal || cr === "dragon";
  for (const [name, x0] of [["legR", -legW], ["legL", 0]]) {
    const v = ctx.parts[name].vox;
    const colorAt = (x, y, z) => {
      if (y <= 1) {
        if (cr === "hobbit") return pal.skin;
        if (cr === "robot") return y === 0 ? shade(pal.shoes, 0.7) : pal.shoes;
        if (animalFeet) return dark ?? (y === 0 ? shade(pal.skin, 0.86) : pal.skin);
        return y === 0 ? shade(pal.shoes, 0.62) : pal.shoes;
      }
      if (cr === "robot") return y === Math.floor(legH / 2) ? shade(pal.skin, 0.62) : pal.skin;
      if (bk === "fur" || (ctx.animal && bk === "none")) return dark && y < legH / 2 + 0.5 ? dark : pal.skin;
      if (covered) return pal.bottom;
      switch (bk) {
        case "pants": return cr === "hobbit" && y === 2 ? shade(pal.bottom, 0.8) : pal.bottom;
        case "shorts": return y >= legH - 2 ? pal.bottom : y === 2 && legH >= 5 ? K.cream : pal.skin;
        case "skirt": case "none": return top === "dress" && y === 2 && legH >= 5 ? K.cream : pal.skin;
        default: return pal.bottom;
      }
    };
    v.box(x0, x0 + legW - 1, 0, legH - 1, -1, 1, colorAt, cr === "robot" ? MAT_METAL : MAT_SOLID);
    // toes / big feet
    if (cr === "hobbit") {
      v.box(x0, x0 + legW - 1, 0, 0, 2, 3, pal.skin);
      for (let x = x0; x < x0 + legW; x++) v.set(x, 1, 2, pal.hair, MAT_SOLID, 0.12);
      v.set(x0 + (name === "legR" ? 0 : legW - 1), 1, 1, pal.hair, MAT_SOLID, 0.12);
    } else if (animalFeet) {
      v.box(x0, x0 + legW - 1, 0, 0, 2, 2, dark ?? pal.skin);
      if (cr === "dragon") for (let x = x0; x < x0 + legW; x += 1) v.det(x + 0.25, 0, 3, x + 0.75, 0.5, 3.5, K.bone);
    } else {
      v.box(x0, x0 + legW - 1, 0, 0, 2, 2, cr === "robot" ? pal.shoes : shade(pal.shoes, 0.86), cr === "robot" ? MAT_METAL : MAT_SOLID);
    }
  }
}

function patternColor(main, acc, pat, x, y, z) {
  switch (pat) {
    case "stripes": return (y & 1) ? main : mix(main, acc, 0.9);
    case "checks": return ((((x + z) >> 1) + (y >> 1)) & 1) ? mix(main, acc, 0.55) : main;
    case "dots": return mod(y, 3) === 1 && mod(x + z + (mod(y, 6) === 1 ? 0 : 2), 4) === 0 ? acc : main;
    default: return main;
  }
}

function buildTorso(ctx) {
  const { a, pal, D } = ctx;
  const v = ctx.parts.body.vox;
  const { legH, hy, bx0, bx1, bz0, bz1 } = D;
  const kind = ctx.topKind;
  const main = pal.top, acc = pal.accent, pat = a.top.pattern;
  const top = hy - 1, bot = legH;
  const P = (x, y, z) => patternColor(main, acc, pat, x, y, z);
  const emb = pat === "embroidery";
  const front = (y, x0, x1, c, z = bz1, mat = MAT_SOLID) => { for (let x = x0; x <= x1; x++) v.set(x, y, z, c, mat); };
  const ring = (y, c, e = 0, mat = MAT_SOLID) => {
    for (let x = bx0 - e; x <= bx1 + e; x++) for (let z = bz0 - e; z <= bz1 + e; z++)
      if (x === bx0 - e || x === bx1 + e || z === bz0 - e || z === bz1 + e) v.set(x, y, z, c, mat);
  };
  // Flared skirt / coat tails from yTop down to yBot; flare(y) → extra width; colour fn gets (x,y,z,e).
  const skirt = (yTop, yBot, flare, colorFn, skip) => {
    for (let y = yTop; y >= yBot; y--) {
      const e = flare(y);
      for (let x = bx0 - e; x <= bx1 + e; x++) for (let z = bz0 - e; z <= bz1 + e; z++) {
        if (skip && skip(x, y, z, e)) continue;
        const edge = x === bx0 - e || x === bx1 + e || z === bz0 - e || z === bz1 + e;
        if (!edge && y !== yBot && y !== yTop) continue; // hollow inside, keep caps
        v.set(x, y, z, colorFn(x, y, z, e));
      }
    }
  };
  // Embroidery = a solid accent band with a dotted row next to it (hems, necklines).
  const embroider = (y, dir) => {
    if (!emb) return;
    for (const [k, val] of [...v.m]) {
      const yy = ky(k);
      if (yy !== y && yy !== y + dir) continue;
      const x = kx(k), z = kz(k);
      if (yy === y || mod(x + z, 2) === 0) v.set(x, yy, z, acc, Math.floor(val / MSHIFT), 0.03);
    }
  };
  const belt = (y, c = 0x4a3426, buckle = K.gold) => {
    ring(y, c);
    v.det(-0.8, y + 0.1, bz1 + 1, 0.8, y + 0.9, bz1 + 1.25, buckle, MAT_METAL);
  };
  const buttons = (ys, c = shade(main, 0.62), x = 0) => { for (const y of ys) v.det(x - 0.28, y - 0.28, bz1 + 1, x + 0.28, y + 0.28, bz1 + 1.18, c); };

  // ---- base torso -----------------------------------------------------------------------------
  if (kind === "fur" || kind === "dragon") {
    const cr = a.creature;
    const belly = cr === "dragon" ? mix(pal.skin, 0xf8e4a2, 0.62)
      : cr === "bear" ? mix(pal.skin, 0xf1d3a2, 0.5)
      : cr === "pig" ? mix(pal.skin, 0xffd9e0, 0.45)
      : cr === "lion" ? mix(pal.skin, 0xfff0d0, 0.45)
      : cr === "dog" ? mix(pal.skin, 0xffffff, 0.55)
      : mix(pal.skin, 0xfffbf4, 0.85);
    v.box(bx0, bx1, bot, top, bz0, bz1, pal.skin);
    for (let y = bot; y <= top; y++) for (let x = bx0 + 1; x <= bx1 - 1; x++) {
      const c = kind === "dragon" && (y - bot) % 2 === 1 ? shade(belly, 0.86) : belly;
      if (cr === "fox" || cr === "wolf" ? y >= bot + 1 : true) v.set(x, y, bz1, c);
    }
    if (cr === "bear" || cr === "pig" || cr === "dragon" || cr === "hobbit") {
      for (let y = bot; y <= top - 2; y++) for (let x = bx0 + 2; x <= bx1 - 2; x++)
        v.set(x, y, bz1 + 1, kind === "dragon" && (y - bot) % 2 === 1 ? shade(belly, 0.86) : belly);
    }
    if (cr === "cat" && luma(pal.skin) > 0.2) {
      for (const k of [...v.m.keys()]) {
        const x = kx(k), y = ky(k), z = kz(k);
        if (z === bz1 && x > bx0 && x < bx1) continue;
        if (mod(y - bot, 3) === 1) v.paint(x, y, z, shade(pal.skin, 0.74));
      }
    }
    return;
  }
  if (kind === "robot") {
    const metal = pal.skin;
    v.box(bx0, bx1, bot, top, bz0, bz1, metal, MAT_METAL, 0.02);
    const panel = cdist(pal.top, pal.skin) > 60 ? pal.top : 0x2a3340;
    for (let y = bot + 2; y <= top - 1; y++) for (let x = bx0 + 1; x <= bx1 - 1; x++) v.set(x, y, bz1, panel, MAT_SOLID, 0.02);
    ring(bot, shade(metal, 0.62), 0, MAT_METAL);
    const lights = [0xff5d5d, 0x7dff9a, 0xffd65a];
    lights.forEach((c, i) => v.det(bx0 + 1.6 + i * 1.6, top - 1.9, bz1 + 1, bx0 + 2.5 + i * 1.6, top - 1.0, bz1 + 1.2, c, MAT_GLOW));
    for (let i = 0; i < 2; i++) v.det(bx0 + 1.5, bot + 2.4 + i * 1.1, bz1 + 1, bx1 - 0.5, bot + 2.8 + i * 1.1, bz1 + 1.1, shade(panel, 1.5));
    return;
  }

  v.box(bx0, bx1, bot, top, bz0, bz1, P);
  const longSkirt = (yBot, flareFn, colorFn) => skirt(bot - 1, yBot, flareFn, colorFn);

  switch (kind) {
    case "shirt":
      front(top, -2, 1, acc); v.set(-1, top, bz1, pal.skin); v.set(0, top, bz1, pal.skin);
      front(top - 1, -1, 0, acc);
      buttons([top - 2.5, top - 4.3].filter((y) => y > bot + 0.5), shade(acc, 0.8));
      break;
    case "tshirt":
      front(top, -1, 0, pal.skin); v.set(-2, top, bz1, shade(main, 0.82)); v.set(1, top, bz1, shade(main, 0.82));
      break;
    case "sweater":
      ring(top, shade(main, 0.84));
      for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) if (x === bx0 || x === bx1 || z === bz0 || z === bz1)
        v.set(x, bot, z, (x + z) & 1 ? shade(main, 0.84) : main);
      front(top, -1, 0, shade(main, 0.84));
      break;
    case "jacket": case "suit": case "coat": {
      const lapel = shade(main, 0.76);
      if (kind === "suit") {
        front(top, -2, 1, acc); front(top - 1, -2, 1, acc); front(top - 2, -1, 0, acc);
        if (top - 3 > bot) front(top - 3, -1, 0, acc);
        v.set(-3, top, bz1, lapel); v.set(2, top, bz1, lapel); v.set(-3, top - 1, bz1, lapel); v.set(2, top - 1, bz1, lapel);
        v.set(-2, top - 2, bz1, lapel); v.set(1, top - 2, bz1, lapel);
        buttons([bot + 1.5], 0x2a2a2e);
        v.det(1.15, top - 2.6, bz1 + 1, 2.0, top - 2.0, bz1 + 1.15, K.cream); // pocket square
      } else if (kind === "coat") {
        front(top, -2, 1, lapel); front(top, -1, 0, acc);
        buttons([top - 1.6, top - 3.4, bot + 0.8].filter((y) => y > bot), K.gold, -1.4);
        buttons([top - 1.6, top - 3.4, bot + 0.8].filter((y) => y > bot), K.gold, 1.4);
        for (let y = bot; y <= top; y++) for (const x of [-1, 0]) if (y < top) v.set(x, y, bz1, shade(main, 0.9));
        belt(bot, shade(main, 0.58), K.gold);
        longSkirt(Math.max(1, legH - 4), (y) => (y < bot - 2 ? 1 : 0), (x, y, z) => P(x, y, z));
        // split at the front so legs show
        for (let y = bot - 1; y >= 0; y--) for (const x of [-1, 0]) for (let z = 2; z <= bz1 + 2; z++) v.del(x, y, z);
      } else {
        for (let y = bot; y <= top; y++) front(y, -1, 0, acc);
        front(top, -2, 1, acc);
        v.set(-2, top - 1, bz1, lapel); v.set(1, top - 1, bz1, lapel); v.set(-3, top, bz1, lapel); v.set(2, top, bz1, lapel);
        if (bot + 1 < top - 2) { v.set(-3, bot + 1, bz1, shade(main, 0.8)); v.set(2, bot + 1, bz1, shade(main, 0.8)); }
      }
      if (kind !== "coat") {
        for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) {
          if ((x === -1 || x === 0) && z === bz1) continue;
          if (x === bx0 || x === bx1 || z === bz0 || z === bz1) v.set(x, bot - 1, z, P(x, bot - 1, z));
        }
      }
      break;
    }
    case "vest": {
      for (let y = top; y >= top - 3 && y >= bot; y--) front(y, -1, 0, acc);
      front(top, -2, 1, acc);
      v.set(-1, bot, bz1, acc); v.set(0, bot, bz1, acc);
      buttons([top - 4.5, top - 5.6].filter((y) => y > bot + 0.6), K.gold);
      v.det(0.3, bot + 1.7, bz1 + 1, 2.4, bot + 1.85, bz1 + 1.12, K.gold); // watch chain
      break;
    }
    case "tunic": {
      front(top, -1, 0, pal.skin);
      v.det(-0.9, top - 1.2, bz1 + 1, 0.9, top - 0.95, bz1 + 1.1, acc);
      v.det(-0.9, top - 2.2, bz1 + 1, 0.9, top - 1.95, bz1 + 1.1, acc);
      longSkirt(Math.max(1, bot - 2), (y) => (y === bot - 2 ? 1 : 0), (x, y, z) => P(x, y, z));
      belt(bot, 0x4f3420, K.gold);
      if (emb) for (const [k, val] of [...v.m]) { const y = ky(k); if (y === bot - 2 || y === top) v.set(kx(k), y, kz(k), mod(kx(k) + kz(k), 2) ? acc : main, Math.floor(val / MSHIFT), 0.02); }
      break;
    }
    case "dress": {
      front(top, -2, 1, pal.skin);
      ring(bot, acc);
      const yb = Math.max(1, Math.round(legH * 0.38));
      longSkirt(yb, (y) => 1 + Math.floor((bot - 1 - y) / 2), (x, y, z) => (y === yb ? acc : P(x, y, z)));
      v.det(-0.8, bot + 0.05, bz0 - 0.4, 0.8, bot + 0.95, bz0, acc); // bow knot at the back
      v.det(-2.2, bot - 0.2, bz0 - 0.3, -0.8, bot + 1.2, bz0, acc);
      v.det(0.8, bot - 0.2, bz0 - 0.3, 2.2, bot + 1.2, bz0, acc);
      break;
    }
    case "gown": {
      for (let x = bx0 + 1; x <= bx1 - 1; x++) v.set(x, top, bz1, pal.skin);
      front(top - 1, -2, 1, acc);
      ring(bot, acc);
      const panel = mix(main, acc, 0.45);
      longSkirt(0, (y) => Math.min(5, 1 + Math.floor((bot - 1 - y) * 0.75)), (x, y, z, e) => {
        if (y === 0) return acc;
        const hp = Math.floor((bot - 1 - y) / 2);
        if (z === bz1 + e && x >= -1 - hp && x <= hp) return emb && mod(y, 3) === 0 && mod(x, 2) === 0 ? acc : panel;
        return (bot - 1 - y) % 3 === 2 ? shade(P(x, y, z), 0.9) : P(x, y, z);
      });
      break;
    }
    case "robe": {
      front(top, -2, 1, acc); front(top - 1, -1, 0, acc);
      for (let y = bot; y < top - 1; y++) front(y, -1, 0, mix(main, acc, 0.75));
      ring(bot, shade(main, 0.72));
      v.det(-0.7, bot + 0.1, bz1 + 1, 0.7, bot + 0.9, bz1 + 1.2, orDefault(acc, K.gold), MAT_METAL);
      longSkirt(1, (y) => (y <= 2 ? 1 : 0), (x, y, z, e) => {
        if (y === 1) return emb ? acc : shade(main, 0.85);
        if (z === bz1 + e && (x === -1 || x === 0)) return mix(main, acc, 0.75);
        return P(x, y, z);
      });
      break;
    }
    case "armor": {
      const metal = main;
      v.box(bx0, bx1, bot, top, bz0, bz1, (x, y, z) => ((y - bot) % 2 === 0 && y !== top ? shade(metal, 0.86) : metal), MAT_METAL, 0.03);
      for (let y = bot + 1; y <= top; y++) front(y, -1, 0, mix(metal, 0xffffff, 0.25), bz1, MAT_METAL);
      for (let y = bot + 1; y <= top - 1; y++) for (const x of [-1, 0]) v.set(x, y, bz1 + 1, (y - bot) % 2 ? metal : mix(metal, 0xffffff, 0.2), MAT_METAL, 0.02);
      const trim = orDefault(acc, K.gold);
      for (const x of [bx0 + 0.6, bx1 + 0.4]) v.det(x - 0.3, top - 0.7, bz1 + 1, x + 0.3, top - 0.1, bz1 + 1.2, trim, MAT_METAL);
      belt(bot, 0x4a3426, trim);
      longSkirt(Math.max(1, bot - 2), () => 1, (x, y, z) => (mod(x + z, 2) ? metal : shade(metal, 0.78)));
      for (const [k, val] of [...v.m]) if (ky(k) < bot && Math.floor(val / MSHIFT) === MAT_SOLID) v.m.set(k, (val % MSHIFT) + MAT_METAL * MSHIFT);
      break;
    }
    default: break;
  }

  // Bottoms that live on the body (skirts, long robes)
  const fullSkirt = kind === "dress" || kind === "gown" || kind === "robe" || kind === "coat";
  if (!fullSkirt && ctx.bottomKind === "skirt") {
    skirt(bot - 1, Math.max(1, legH - 3), (y) => (y >= bot - 1 ? 0 : 1), (x, y, z) => (y === Math.max(1, legH - 3) ? shade(pal.bottom, 0.85) : pal.bottom));
  } else if (!fullSkirt && ctx.bottomKind === "robe") {
    skirt(bot - 1, 1, (y) => 1 + Math.floor((bot - 1 - y) / 3), () => pal.bottom);
  }
  if ((kind === "shirt" || kind === "tshirt" || kind === "sweater") && (ctx.bottomKind === "pants" || ctx.bottomKind === "shorts")) {
    if (kind === "shirt") belt(bot);
  }
  if (emb && kind !== "tunic") {
    let low = top;
    for (const k of v.m.keys()) low = Math.min(low, ky(k));
    embroider(top, -1);
    embroider(low, 1);
  }
  if (emb && (kind === "shirt" || kind === "tshirt" || kind === "sweater" || kind === "jacket")) {
    for (let y = bot + 1; y < top; y++) if (mod(y, 2) === 0) { v.set(-1, y, bz1, acc); v.set(0, y, bz1, acc); }
  }
  if (a.creature === "ghost") {
    const wisp = ctx.topKind === "gown" || ctx.topKind === "robe" || ctx.topKind === "dress" ? null : pal.top;
    let lowest = bot;
    for (const k of v.m.keys()) lowest = Math.min(lowest, ky(k));
    const start = lowest - 1;
    for (let k = 0; k <= start; k++) {
      const y = start - k;
      const shrink = Math.ceil((k + 1) * 0.75);
      const xa = bx0 + shrink + Math.round(k * 0.45), xb = bx1 - shrink + Math.round(k * 0.45);
      const za = bz0 + Math.min(1, k) - Math.round(k * 0.5), zb = bz1 - Math.ceil(k * 0.6) - Math.round(k * 0.5);
      if (xa > xb) { v.set(xb, y, za, wisp ?? main); break; }
      v.box(xa, xb, y, y, za, Math.max(za, zb), (x, yy, z) => patternColor(wisp ?? main, acc, pat, x, yy, z));
    }
  }
  if (a.creature === "hobbit" || a.creature === "dwarf") {
    for (let y = bot; y <= bot + 2; y++) for (let x = bx0 + 2; x <= bx1 - 2; x++) {
      const c = v.get(x, y, bz1);
      if (c >= 0) v.set(x, y, bz1 + 1, c, MAT_SOLID, 0.02);
    }
  }
}

function buildArms(ctx) {
  const { a, pal, D } = ctx;
  const { hy, armLen, armW, bx0, bx1 } = D;
  const kind = ctx.topKind;
  const cr = a.creature;
  const main = pal.top, acc = pal.accent;
  const { dark } = legPalette(ctx);
  for (const side of ["R", "L"]) {
    const v = ctx.parts["arm" + side].vox;
    const x0 = side === "R" ? bx0 - armW : bx1 + 1, x1 = x0 + armW - 1;
    const out = side === "R" ? -1 : 1;
    const xo = side === "R" ? x0 : x1;
    const yb = hy - armLen;
    let hand = pal.skin;
    if (ctx.animal) hand = dark ?? pal.skin;
    if (cr === "robot") hand = shade(pal.skin, 0.7);
    if (kind === "armor") hand = shade(main, 0.74);
    const sleeve = (i, x, y, z) => {
      const P = patternColor(main, acc, a.top.pattern, x, y, z);
      switch (kind) {
        case "fur": case "dragon": return pal.skin;
        case "robot": return i === Math.floor(armLen / 2) ? shade(pal.skin, 0.62) : pal.skin;
        case "tshirt": return i >= armLen - 2 ? P : pal.skin;
        case "dress": case "gown": return i >= armLen - 2 ? P : i === armLen - 3 && kind === "gown" ? acc : pal.skin;
        case "vest": return i === 2 ? mix(acc, 0xffffff, 0.35) : acc;
        case "jacket": case "suit": case "coat": return i === 2 ? acc : P;
        case "sweater": return i === 2 ? shade(main, 0.84) : P;
        case "robe": return i === 2 ? acc : P;
        case "shirt": return i === 2 ? shade(main, 0.9) : P;
        default: return P;
      }
    };
    const mat = kind === "armor" || kind === "robot" ? MAT_METAL : MAT_SOLID;
    for (let y = yb; y < hy; y++) for (let x = x0; x <= x1; x++) for (let z = -1; z <= 1; z++) {
      const i = y - yb;
      if (i <= 1) v.set(x, y, z, hand, kind === "armor" ? MAT_METAL : MAT_SOLID);
      else v.set(x, y, z, sleeve(i, x, y, z), i <= 1 ? MAT_SOLID : mat);
    }
    if (kind === "dress" || kind === "gown") {
      for (let y = hy - 2; y < hy; y++) for (let z = -1; z <= 1; z++) v.set(xo + out, y, z, patternColor(main, acc, a.top.pattern, xo + out, y, z));
      for (let y = hy - 2; y < hy; y++) for (let x = x0; x <= x1; x++) { v.set(x, y, -2, main); v.set(x, y, 2, main); }
    } else if (kind === "robe") {
      for (let y = yb + 2; y <= yb + 3; y++) {
        for (let z = -1; z <= 1; z++) v.set(xo + out, y, z, y === yb + 2 ? acc : main);
        for (let x = x0; x <= x1; x++) { v.set(x, y, 2, y === yb + 2 ? acc : main); v.set(x, y, -2, y === yb + 2 ? acc : main); }
      }
    } else if (kind === "armor") {
      for (let y = hy - 2; y <= hy; y++) for (let x = x0; x <= x1 + (side === "R" ? 0 : 0); x++) for (let z = -2; z <= 2; z++) {
        if (y === hy && (z === -2 || z === 2)) continue;
        v.set(x, y, z, y === hy - 2 ? shade(main, 0.8) : mix(main, 0xffffff, 0.12), MAT_METAL, 0.02);
      }
      for (let y = hy - 2; y <= hy - 1; y++) for (let z = -2; z <= 2; z++) v.set(xo + out, y, z, shade(main, 0.9), MAT_METAL, 0.02);
    }
    if (ctx.animal && cr !== "pig" && cr !== "bear") {
      // little paw pads
      v.det(x0 + 0.3, yb - 0.02, 1.6, x1 + 0.7, yb + 0.4, 2.02, mix(hand, 0xffffff, 0.25));
    }
    if (cr === "dragon") for (let x = x0; x <= x1; x++) v.det(x + 0.3, yb - 0.5, 1.2, x + 0.7, yb + 0.2, 1.8, K.bone);
  }
}

// ---------------------------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------------------------

function buildHumanHead(ctx) {
  const { a, pal, A } = ctx;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const skin = pal.skin;
  v.box(X0, X1, Y0, Y1, Z0, Z1, skin, MAT_SOLID, 0.03);
  for (const x of [X0, X1]) { v.del(x, Y0, Z1); v.del(x, Y0, Z0); }
  const cr = a.creature;
  if (cr !== "elf" && cr !== "hobbit") buildEars(ctx);
  if (a.hair.style === "none" || a.hair.style === "mohawk") {
    // rounded dome instead of a sharp box top, with a soft highlight
    for (let x = X0; x <= X1; x++) { v.del(x, Y1, Z0); v.del(x, Y1, Z1); }
    for (let z = Z0; z <= Z1; z++) { v.del(X0, Y1, z); v.del(X1, Y1, z); }
    for (const x of [X0, X1]) for (const z of [Z0, Z1]) v.del(x, Y1 - 1, z);
    if (a.hair.style === "none") for (let x = -2; x <= 1; x++) for (let z = -1; z <= 2; z++) v.paint(x, Y1, z, mix(skin, 0xffffff, 0.16), 0.02);
  }
  if (cr === "dwarf") v.det(-1.1, Y0 + 2.0, Z1 + 1, 1.1, Y0 + 3.3, Z1 + 1.9, shade(skin, 0.93));
  if (cr === "hobbit" || a.age === "child") v.det(-0.5, Y0 + 2.4, Z1 + 1, 0.5, Y0 + 2.9, Z1 + 1.3, shade(skin, 0.9));
}

function buildEars(ctx) {
  const { a, pal, A } = ctx;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0 } = A;
  const ear = shade(pal.skin, 0.92);
  const set = (x, y, z, c) => { v.set(x, y, z, c); ctx.hairKeys.delete(key(x, y, z)); };
  for (const [ex, o] of [[X0 - 1, -1], [X1 + 1, 1]]) {
    if (a.creature === "elf") {
      // long leaf-shaped ears sweeping up and out through the hair
      const inner = mix(pal.skin, 0xff9a9a, 0.25);
      for (let y = Y0 + 3; y <= Y0 + 5; y++) for (let z = 0; z <= 1; z++) set(ex, y, z, ear);
      for (let y = Y0 + 4; y <= Y0 + 6; y++) for (let z = 0; z <= 1; z++) set(ex + o, y, z, y === Y0 + 5 && z === 1 ? inner : ear);
      for (let y = Y0 + 5; y <= Y0 + 7; y++) for (let z = 0; z <= 1; z++) set(ex + 2 * o, y, z, ear);
      set(ex + 3 * o, Y0 + 7, 0, ear); set(ex + 3 * o, Y0 + 8, 0, ear); set(ex + 3 * o, Y0 + 7, 1, ear);
      set(ex + 4 * o, Y0 + 9, 0, ear);
    } else if (a.creature === "hobbit") {
      for (let y = Y0 + 3; y <= Y0 + 5; y++) for (let z = 0; z <= 1; z++) set(ex + o, y, z, ear);
      set(ex + o, Y0 + 6, 0, ear); set(ex + 2 * o, Y0 + 6, 0, ear);
    } else {
      for (let y = Y0 + 3; y <= Y0 + 4; y++) for (let z = 0; z <= 1; z++) v.set(ex, y, z, ear);
    }
  }
}

function animalTraits(cr, fur) {
  const white = 0xfffaf2;
  const light = cr === "fox" ? white : cr === "bear" ? mix(fur, 0xf1d3a2, 0.55) : cr === "pig" ? mix(fur, 0xffc4cf, 0.35)
    : cr === "lion" ? mix(fur, 0xfff3d6, 0.55) : mix(fur, white, 0.7);
  return { light, inner: cr === "bear" ? shade(fur, 0.7) : cr === "fox" ? white : K.pink };
}

function buildAnimalHead(ctx) {
  const { a, pal, A } = ctx;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const cr = a.creature;
  const fur = pal.skin;
  const { light, inner } = animalTraits(cr, fur);
  const nose = cr === "pig" ? shade(fur, 0.7) : cr === "cat" || cr === "rabbit" || cr === "mouse" ? 0xf27a90 : 0x2a1d1a;
  v.box(X0, X1, Y0, Y1, Z0, Z1, fur, MAT_SOLID, 0.045);
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) v.del(x, Y1, z);
  for (const x of [X0, X1]) { v.del(x, Y0, Z1); v.del(x, Y0, Z0); }
  let muzzleFront = Z1 + 1;
  const ear = (side, fn) => { const o = side < 0 ? 1 : -1; const ex = side < 0 ? X0 : X1; fn(ex, o); };
  switch (cr) {
    case "fox": case "wolf": {
      const wolf = cr === "wolf";
      for (const x of [X0, X0 + 1, X0 + 2, X1 - 2, X1 - 1, X1]) for (let y = Y0; y <= Y0 + 2; y++) {
        if ((x === X0 + 2 || x === X1 - 2) && y === Y0 + 2) continue;
        v.set(x, y, Z1, light);
      }
      for (const x of [X0, X1]) for (let z = Z1 - 2; z <= Z1; z++) for (let y = Y0 + 1; y <= Y0 + 2; y++) v.set(x, y, z, light);
      v.box(-2, 1, Y0, Y0 + 1, Z1 + 1, Z1 + 1, light);
      v.box(-2, 1, Y0 + 2, Y0 + 2, Z1 + 1, Z1 + 1, fur);
      v.box(-1, 0, Y0, Y0 + 1, Z1 + 2, Z1 + 2, light);
      v.box(-1, 0, Y0 + 2, Y0 + 2, Z1 + 2, Z1 + 2, nose);
      if (wolf) { v.box(-1, 0, Y0 + 2, Y0 + 2, Z1 + 2, Z1 + 2, fur); v.box(-1, 0, Y0 + 2, Y0 + 2, Z1 + 3, Z1 + 3, nose); v.box(-1, 0, Y0, Y0 + 1, Z1 + 3, Z1 + 3, light); muzzleFront = Z1 + 4; }
      else muzzleFront = Z1 + 3;
      const tip = wolf ? shade(fur, 0.6) : 0x3b2a24;
      const h = wolf ? 4 : 3;
      for (const side of [-1, 1]) ear(side, (ex, o) => {
        for (let r = 0; r < h; r++) {
          const w = Math.max(1, 3 - Math.floor(r * (wolf ? 0.7 : 1)));
          for (let i = 0; i < w; i++) for (let z = -1; z <= 0; z++) {
            const x = ex + o * i;
            const isTip = r >= h - 1;
            const c = isTip ? tip : z === 0 && i > 0 && r < h - 1 ? inner : fur;
            v.set(x, Y1 + 1 + r, z, c);
          }
        }
      });
      if (wolf) for (let x = X0 + 1; x <= X1 - 1; x++) for (let z = Z0; z <= Z1 - 1; z++) v.paint(x, Y1, z, shade(fur, 0.82));
      break;
    }
    case "cat": {
      v.box(-1, 0, Y0, Y0 + 1, Z1 + 1, Z1 + 1, light);
      muzzleFront = Z1 + 2;
      v.det(-0.5, Y0 + 1.55, Z1 + 2, 0.5, Y0 + 2.0, Z1 + 2.15, nose);
      for (const side of [-1, 1]) {
        ear(side, (ex, o) => {
          for (let z = -1; z <= 0; z++) { v.set(ex, Y1 + 1, z, fur); v.set(ex + o, Y1 + 1, z, z === 0 ? inner : fur); v.set(ex + 2 * o, Y1 + 1, z, fur); v.set(ex, Y1 + 2, z, fur); v.set(ex + o, Y1 + 2, z, fur); }
          v.set(ex, Y1 + 3, -1, fur);
        });
        for (let i = 0; i < 2; i++) {
          const y = Y0 + 0.75 + i * 0.6;
          if (side < 0) v.det(-4.4, y, Z1 + 1.35, -1.2, y + 0.14, Z1 + 1.5, 0xf6f1ea);
          else v.det(1.2, y, Z1 + 1.35, 4.4, y + 0.14, Z1 + 1.5, 0xf6f1ea);
        }
      }
      if (luma(fur) > 0.3) for (const x of [-2, 0, 1]) v.paint(x, Y1, Z1, shade(fur, 0.72));
      break;
    }
    case "dog": {
      v.box(-2, 1, Y0, Y0 + 2, Z1 + 1, Z1 + 1, light);
      v.box(-1, 0, Y0, Y0 + 1, Z1 + 2, Z1 + 2, light);
      v.box(-1, 0, Y0 + 2, Y0 + 2, Z1 + 2, Z1 + 2, nose);
      muzzleFront = Z1 + 3;
      const earC = shade(fur, 0.68);
      for (const side of [-1, 1]) ear(side, (ex, o) => {
        const x = ex - o;
        v.box(x, x, Y0 + 3, Y1, -1, 2, earC);
        v.box(ex, ex, Y1 + 1, Y1 + 1, -1, 2, earC);
        v.box(x, x, Y0 + 2, Y0 + 2, 0, 1, earC);
      });
      break;
    }
    case "rabbit": {
      v.box(-1, 0, Y0, Y0 + 1, Z1 + 1, Z1 + 1, light);
      muzzleFront = Z1 + 2;
      v.det(-0.5, Y0 + 1.55, Z1 + 2, 0.5, Y0 + 2.0, Z1 + 2.15, nose);
      v.det(-0.45, Y0 - 0.45, Z1 + 1.6, 0.45, Y0 + 0.1, Z1 + 1.9, 0xffffff);
      for (const side of [-1, 1]) ear(side, (ex, o) => {
        const xi = ex + o, xo2 = ex + 2 * o;
        for (let r = 0; r < 7; r++) {
          const shift = r >= 4 ? -o : 0;
          for (let z = -1; z <= 0; z++) {
            v.set(xi + shift, Y1 + 1 + r, z, z === 0 && r > 0 && r < 6 ? inner : fur);
            if (r < 6) v.set(xo2 + shift, Y1 + 1 + r, z, fur);
          }
        }
      });
      break;
    }
    case "bear": {
      v.box(-2, 1, Y0, Y0 + 2, Z1 + 1, Z1 + 1, light);
      v.box(-1, 0, Y0 + 1, Y0 + 2, Z1 + 2, Z1 + 2, nose);
      muzzleFront = Z1 + 2;
      for (const side of [-1, 1]) ear(side, (ex, o) => {
        for (let i = 0; i < 3; i++) for (let r = 0; r < 2; r++) for (let z = -1; z <= 0; z++) {
          if (r === 1 && i === 2) continue;
          v.set(ex + o * i, Y1 + 1 + r, z, z === 0 && i === 1 && r === 0 ? inner : fur);
        }
      });
      break;
    }
    case "mouse": {
      v.box(-1, 0, Y0, Y0 + 1, Z1 + 1, Z1 + 2, light);
      muzzleFront = Z1 + 3;
      v.det(-0.55, Y0 + 1.2, Z1 + 3, 0.55, Y0 + 2.1, Z1 + 3.4, nose);
      for (const side of [-1, 1]) {
        const cx = side < 0 ? X0 + 0.5 : X1 + 0.5;
        for (let x = Math.floor(cx - 3); x <= Math.ceil(cx + 3); x++) for (let y = Y1 - 2; y <= Y1 + 4; y++) {
          const d = Math.hypot(x + 0.5 - cx - side * 0.8, y + 0.5 - (Y1 + 1.6));
          if (d > 2.9) continue;
          v.set(x, y, -1, fur);
          v.set(x, y, 0, d < 1.9 ? inner : fur);
        }
        for (let i = 0; i < 2; i++) {
          const y = Y0 + 0.8 + i * 0.6;
          if (side < 0) v.det(-4.0, y, Z1 + 2.2, -0.8, y + 0.13, Z1 + 2.35, 0x6d6560);
          else v.det(0.8, y, Z1 + 2.2, 4.0, y + 0.13, Z1 + 2.35, 0x6d6560);
        }
      }
      break;
    }
    case "pig": {
      const sn = mix(fur, 0xff9fb2, 0.35);
      v.box(-2, 1, Y0 + 1, Y0 + 2, Z1 + 1, Z1 + 1, sn);
      v.det(-1.4, Y0 + 1.5, Z1 + 2, -0.6, Y0 + 2.3, Z1 + 2.1, shade(fur, 0.55));
      v.det(0.6, Y0 + 1.5, Z1 + 2, 1.4, Y0 + 2.3, Z1 + 2.1, shade(fur, 0.55));
      muzzleFront = Z1 + 1;
      for (const side of [-1, 1]) ear(side, (ex, o) => {
        for (let i = 0; i < 3; i++) for (let z = Z1 - 3; z <= Z1 - 2; z++) v.set(ex + o * i, Y1 + 1, z, fur);
        for (let i = 0; i < 2; i++) v.set(ex + o * i, Y1 + 1, Z1 - 1, shade(fur, 0.9));
        v.set(ex, Y1 + 2, Z1 - 3, fur);
      });
      ctx.A.mouthY = Y0 + 0.6;
      break;
    }
    case "lion": {
      const mane = a.hair.style !== "none" && cdist(pal.hair, fur) > 40 ? pal.hair : mix(fur, 0x7a3b12, 0.55);
      const s = ctx.seed ^ 0x77;
      const cy = (Y0 + Y1 + 1) / 2;
      for (let x = X0 - 4; x <= X1 + 4; x++) for (let y = Y0 - 4; y <= Y1 + 4; y++) {
        const ang = Math.atan2(y + 0.5 - cy, x + 0.5);
        const R = 7.6 + 1.3 * Math.sin(ang * 7 + 0.6) + hash3(x, y, 0, s) * 0.8;
        const r = Math.hypot(x + 0.5, (y + 0.5 - cy) * 1.05);
        if (r > R) continue;
        const inSkull = x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
        for (let z = Z0 - 1; z <= Z1; z++) {
          if (inSkull && z >= Z0) continue;
          if (z >= Z1 - 1 && r < 6.2 && !inSkull && y < Y0) continue; // keep the chin/neck front clear
          if (z === Z1 && r < 6.0) continue;
          if (z === Z0 - 1 && r > R - 1.2) continue;
          v.set(x, y, z, r > R - 1.4 ? shade(mane, 0.86) : mane, MAT_SOLID, 0.09);
        }
      }
      v.box(-2, 1, Y0, Y0 + 2, Z1 + 1, Z1 + 1, light);
      v.box(-1, 0, Y0 + 2, Y0 + 2, Z1 + 1, Z1 + 1, 0x4a2c22);
      muzzleFront = Z1 + 2;
      for (const side of [-1, 1]) ear(side, (ex, o) => { v.box(ex + o, ex + o, Y1 + 1, Y1 + 2, -1, 0, fur); v.box(ex + 2 * o, ex + 2 * o, Y1 + 1, Y1 + 1, -1, 0, fur); });
      break;
    }
    default: break;
  }
  ctx.A.mouthZ = muzzleFront;
  if (cr !== "pig") ctx.A.mouthY = Y0 + 0.75;
  ctx.A.blushY = Y0 + 1.7;
  ctx.A.noBrows = true;
}

function buildDragonHead(ctx) {
  const { pal, A } = ctx;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const sc = pal.skin;
  const belly = mix(sc, 0xf8e4a2, 0.62);
  v.box(X0, X1, Y0, Y1, Z0, Z1, sc, MAT_SOLID, 0.05);
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) v.del(x, Y1, z);
  v.box(-3, 2, Y0, Y0 + 3, Z1 + 1, Z1 + 2, (x, y) => (y === Y0 ? belly : sc));
  v.box(-2, 1, Y0, Y0 + 2, Z1 + 3, Z1 + 3, (x, y) => (y === Y0 ? belly : sc));
  for (const x of [-1.6, 0.7]) v.det(x, Y0 + 2.2, Z1 + 3.9, x + 0.9, Y0 + 2.7, Z1 + 4.05, shade(sc, 0.45));
  for (const [x, o] of [[X0 + 1, -1], [X1 - 1, 1]]) {
    v.box(x, x, Y1 + 1, Y1 + 2, -2, -1, K.bone);
    v.set(x + o, Y1 + 3, -2, K.bone); v.set(x + o, Y1 + 3, -3, K.bone);
  }
  const spike = shade(sc, 0.7);
  for (let z = Z1 - 2; z >= Z0; z -= 2) v.box(-1, 0, Y1 + 1, Y1 + (z % 4 === 0 ? 2 : 1), z, z, spike);
  for (let y = Y1 - 1; y >= Y0 + 2; y -= 2) v.box(-1, 0, y, y, Z0 - 1, Z0 - 1, spike);
  A.eyeY = Y0 + 5;
  A.mouthY = Y0 + 0.75;
  A.mouthZ = Z1 + 4;
  A.blushY = Y0 + 4;
  A.noBrows = true;
}

function buildRobotHead(ctx) {
  const { pal, A } = ctx;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const metal = pal.skin;
  v.box(X0, X1, Y0, Y1, Z0, Z1, metal, MAT_METAL, 0.02);
  const screen = 0x1d2632;
  for (let x = X0 + 1; x <= X1 - 1; x++) for (let y = Y0 + 1; y <= Y1 - 2; y++) v.set(x, y, Z1, screen, MAT_SOLID, 0.02);
  for (const [x, o] of [[X0 - 1, -1], [X1 + 1, 1]]) {
    v.box(x, x, Y0 + 3, Y0 + 5, -1, 1, shade(metal, 0.7), MAT_METAL);
    v.det(x + (o < 0 ? -0.4 : 1), Y0 + 3.6, -0.1, x + (o < 0 ? 0 : 1.4), Y0 + 5.4, 1.1, mix(metal, 0xffffff, 0.3), MAT_METAL);
  }
  v.det(-0.25, Y1 + 1, 0.25, 0.25, Y1 + 3.6, 0.75, shade(metal, 0.6), MAT_METAL);
  v.det(-0.6, Y1 + 3.4, -0.1, 0.6, Y1 + 4.6, 1.1, 0xff5a5a, MAT_GLOW);
  v.det(-1.6, Y1 + 1, -0.6, 1.6, Y1 + 1.4, 1.6, shade(metal, 0.75), MAT_METAL);
  A.robot = true;
  A.noBrows = true;
}

/** Eyes (blinkable part), brows, blush, mouth (closed + open variants). */
function faceFeatures(ctx) {
  const { a, pal, A } = ctx;
  const head = ctx.parts.head.vox;
  const FZ = A.faceZ;
  const ey = A.eyeY;
  const eyes = addPart(ctx, "eyes", "head", [0, ey + 1, FZ]);
  const robot = A.robot;
  const eyeDark = robot ? mix(pal.eyes, 0xffffff, 0.35) : mix(pal.eyes, 0x120e0c, 0.62);
  for (const ex of [A.eyeXR, A.eyeXL]) {
    eyes.det(ex, ey, FZ - 0.02, ex + 2, ey + 2, FZ + 0.1, eyeDark, robot ? MAT_GLOW : MAT_SOLID);
    if (!robot) {
      eyes.det(ex + 0.18, ey + 1.2, FZ + 0.1, ex + 0.82, ey + 1.84, FZ + 0.16, 0xffffff, MAT_GLOW);
      eyes.det(ex + 1.35, ey + 0.35, FZ + 0.1, ex + 1.65, ey + 0.65, FZ + 0.15, mix(pal.eyes, 0xffffff, 0.45), MAT_GLOW);
    }
    if (a.gender === "female" && !robot) {
      const outer = ex === A.eyeXR ? ex - 0.42 : ex + 2;
      eyes.det(outer, ey + 1.55, FZ - 0.02, outer + 0.42, ey + 2.05, FZ + 0.12, eyeDark);
    }
  }
  if (!A.noBrows) {
    const hasHair = a.hair.style !== "none";
    const browC = hasHair ? shade(pal.hair, 0.78) : shade(pal.skin, 0.62);
    const th = a.age === "elder" ? 0.55 : a.gender === "female" ? 0.32 : 0.42;
    for (const ex of [A.eyeXR, A.eyeXL]) head.det(ex + 0.05, ey + 2.5, FZ, ex + 1.95, ey + 2.5 + th, FZ + 0.12, browC);
  }
  // blush
  const blush = robot ? 0xff8fa8 : mix(pal.skin, 0xff6b7d, luma(pal.skin) > 0.5 ? 0.42 : 0.5);
  const by = A.blushY;
  head.det(A.eyeXR - 1.75, by, FZ, A.eyeXR - 0.2, by + 0.75, FZ + 0.06, blush, robot ? MAT_GLOW : MAT_SOLID);
  head.det(A.eyeXL + 2.2, by, FZ, A.eyeXL + 3.75, by + 0.75, FZ + 0.06, blush, robot ? MAT_GLOW : MAT_SOLID);
  // mouth
  const my = A.mouthY, mz = A.mouthZ;
  const mouth = addPart(ctx, "mouth", "head", [0, my, mz]);
  const open = addPart(ctx, "mouthOpen", "head", [0, my, mz]);
  const lip = robot ? mix(pal.eyes, 0xffffff, 0.35) : mix(pal.skin, 0x4a1c1c, 0.82);
  const mm = robot ? MAT_GLOW : MAT_SOLID;
  mouth.det(-0.85, my - 0.22, mz - 0.02, 0.85, my + 0.22, mz + 0.08, lip, mm);
  mouth.det(-1.3, my + 0.05, mz - 0.02, -0.85, my + 0.5, mz + 0.08, lip, mm);
  mouth.det(0.85, my + 0.05, mz - 0.02, 1.3, my + 0.5, mz + 0.08, lip, mm);
  open.det(-0.85, my - 0.65, mz - 0.02, 0.85, my + 0.4, mz + 0.08, robot ? lip : 0x5a1a20, mm);
  if (!robot) open.det(-0.6, my - 0.65, mz + 0.06, 0.6, my - 0.25, mz + 0.1, 0xf07a86);
  ctx.parts.mouthOpen.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Hair & beards
// ---------------------------------------------------------------------------------------------

function buildHair(ctx) {
  const { a, pal, A, D } = ctx;
  const style = a.hair.style;
  if (style === "none") return;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const hc = pal.hair, dk = shade(hc, 0.8), lt = mix(hc, 0xffffff, 0.14);
  const s = ctx.seed ^ 0x5bd1e995;
  const rnd = (x, y, z) => hash3(x, y, z, s ^ 0x9e37);
  const col = (x, y, z) => {
    const strand = hash3(x, 0, z, s ^ 0x51), h = hash3(x, y, z, s);
    return strand < 0.2 || h < 0.07 ? dk : strand > 0.86 || h > 0.95 ? lt : hc;
  };
  const put = (x, y, z, c) => { v.set(x, y, z, c ?? col(x, y, z), MAT_SOLID, 0.06); ctx.hairKeys.add(key(x, y, z)); };
  const top = (y = Y1 + 1, inset = 0) => { for (let x = X0 + inset; x <= X1 - inset; x++) for (let z = Z0 + inset; z <= Z1 - inset; z++) put(x, y, z); };
  const sides = (yb, yt = Y1) => { for (let y = yb; y <= yt; y++) for (let z = Z0; z <= Z1; z++) { put(X0 - 1, y, z); put(X1 + 1, y, z); } };
  const back = (yb, yt = Y1) => { for (let y = yb; y <= yt; y++) for (let x = X0 - 1; x <= X1 + 1; x++) put(x, y, Z0 - 1); };
  const fringe = (rows) => rows.forEach((n, i) => { for (let k = 0; k < n; k++) put(X0 - 1 + i, Y1 - k, Z1 + 1); });
  const curtain = (yb, ragged = true) => {
    const zb = Math.min(Z0 + 1, D.bz0 - 1);
    for (let y = yb; y < Y0; y++) for (let x = X0 - 1; x <= X1 + 1; x++) for (let z = Z0 - 1; z <= zb; z++) {
      if (ragged && y === yb && rnd(x, y, z) < 0.45) continue;
      if (y < yb + 2 && (x === X0 - 1 || x === X1 + 1)) continue;
      put(x, y, z);
    }
  };
  const locks = (yb) => { for (let y = yb; y < Y0; y++) for (let z = D.bz1 + 0; z <= D.bz1 + 1; z++) { put(X0 - 1, y, z); put(X1 + 1, y, z); } };
  const centerPart = [4, 3, 2, 2, 1, 0, 0, 1, 2, 2, 3, 4];
  const parted = (ctx.seed & 1) === 0;
  switch (style) {
    case "short":
      top(); sides(Y0 + 5); back(Y0 + 2);
      for (const z of [Z1 - 1, Z1]) { put(X0 - 1, Y0 + 4, z); put(X1 + 1, Y0 + 4, z); }
      fringe([3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 2, 3]);
      break;
    case "messy":
      top(); sides(Y0 + 4); back(Y0 + 2);
      fringe([3, 2, 3, 1, 2, 3, 1, 2, 1, 3, 2, 3].map((n, i) => Math.min(3, n + (rnd(i, 0, 1) > 0.7 ? 1 : 0))));
      for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) {
        const r = rnd(x, Y1 + 2, z);
        if (r > 0.62) put(x, Y1 + 2, z);
        if (r > 0.92) put(x, Y1 + 3, z);
      }
      for (let y = Y0 + 4; y <= Y1; y++) for (let z = Z0; z <= Z1; z += 1) {
        if (rnd(X0 - 2, y, z) > 0.8) put(X0 - 2, y, z);
        if (rnd(X1 + 2, y, z) > 0.8) put(X1 + 2, y, z);
      }
      break;
    case "long": case "wavy": {
      top(); top(Y1 + 2, 1); sides(Y0); back(Y0);
      curtain(Y0 - 5); locks(Y0 - 4);
      const rows = parted ? [10, 4, 3, 3, 2, 2, 1, 1, 1, 2, 3, 10] : [10, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 10];
      fringe(rows);
      if (style === "wavy") {
        for (let y = Y0 - 4; y <= Y1 - 1; y++) {
          if (((y >> 1) & 1) === 0) continue;
          for (let z = Z0 - 1; z <= Z1 - 1; z++) {
            if (y < Y0 && z > Math.min(Z0 + 1, D.bz0 - 1) && z < D.bz1) continue;
            put(X0 - 2, y, z); put(X1 + 2, y, z);
          }
          for (let x = X0 - 1; x <= X1 + 1; x++) put(x, y, Z0 - 2);
        }
      }
      break;
    }
    case "bob":
      top(); top(Y1 + 2, 1); sides(Y0 + 1); back(Y0);
      for (let y = Y0 + 1; y <= Y0 + 2; y++) for (let z = Z0; z <= Z1 - 1; z++) { put(X0 - 2, y, z); put(X1 + 2, y, z); }
      for (let y = Y0; y <= Y0 + 1; y++) for (let x = X0 - 1; x <= X1 + 1; x++) put(x, y, Z0 - 2);
      fringe([9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 9]);
      break;
    case "curly": {
      top(); top(Y1 + 2, 1); top(Y1 + 3, 3); sides(Y0 + 2); back(Y0);
      curtain(Y0 - 2);
      const shell = [...ctx.hairKeys];
      for (const k of shell) {
        const x = kx(k), y = ky(k), z = kz(k);
        if (rnd(x, y, z) < 0.5) continue;
        if (y >= Y1 + 1 && x >= X0 && x <= X1 && z >= Z0 && z <= Z1) { if (!v.has(x, y + 1, z)) put(x, y + 1, z); }
        else if (x === X0 - 1 && y > Y0) put(X0 - 2, y, z);
        else if (x === X1 + 1 && y > Y0) put(X1 + 2, y, z);
        else if (z === Z0 - 1 && y >= Y0) put(x, y, Z0 - 2);
      }
      fringe([5, 3, 2, 3, 2, 2, 2, 2, 3, 2, 3, 5].map((n, i) => n + (rnd(i, 3, 3) > 0.75 ? -1 : 0)));
      break;
    }
    case "spiky": {
      top(); sides(Y0 + 5); back(Y0 + 3);
      fringe([3, 3, 2, 3, 1, 3, 1, 3, 1, 3, 2, 3]);
      for (let x = X0; x <= X1 - 1; x += 3) for (let z = Z0; z <= Z1 - 1; z += 3) {
        const h = 2 + Math.floor(rnd(x, 0, z) * 3);
        for (let i = 0; i < h; i++) {
          const zz = z - Math.floor(i / 2);
          if (i < 1) { put(x, Y1 + 2 + i, zz); put(x + 1, Y1 + 2 + i, zz); put(x, Y1 + 2 + i, zz + 1); put(x + 1, Y1 + 2 + i, zz + 1); }
          else put(x + (i > 1 ? 1 : 0), Y1 + 2 + i, zz);
        }
      }
      for (const z of [Z0 + 1, Z0 + 4, Z1 - 2]) { put(X0 - 2, Y1 - 1, z); put(X1 + 2, Y1 - 1, z); put(X0 - 3, Y1, z); put(X1 + 3, Y1, z); }
      break;
    }
    case "bun": case "ponytail": case "braids": {
      top(); sides(style === "braids" ? Y0 + 3 : Y0 + 4); back(Y0 + 1);
      fringe(style === "braids" ? [3, 2, 2, 1, 1, 0, 0, 1, 1, 2, 2, 3] : centerPart);
      const tie = a.gender === "female" ? 0xe0566b : shade(hc, 0.55);
      if (style === "bun") {
        for (let x = -2; x <= 1; x++) for (let y = Y1 + 2; y <= Y1 + 4; y++) for (let z = Z0 + 1; z <= Z0 + 4; z++) {
          const edgeX = x === -2 || x === 1, edgeZ = z === Z0 + 1 || z === Z0 + 4;
          if ((y === Y1 + 4 || y === Y1 + 2) && edgeX && edgeZ) continue;
          put(x, y, z, y === Y1 + 2 && (edgeX || edgeZ) ? tie : undefined);
        }
      } else if (style === "ponytail") {
        for (let x = -1; x <= 0; x++) for (let y = Y0 + 6; y <= Y0 + 7; y++) put(x, y, Z0 - 2, tie);
        for (let y = Y0 + 6; y >= Y0 - 3; y--) {
          const z = Z0 - 2 - Math.floor((Y0 + 6 - y) / 4);
          const xs = y < Y0 - 1 ? [-1] : [-1, 0];
          for (const x of xs) { if (y < Y0 + 6) put(x, y, z); put(x, y, z - 1); }
        }
      } else {
        for (const sx of [X0 - 1, X1 + 1]) {
          for (let y = Y0 + 2; y >= Y0 - 5; y--) {
            const odd = (y & 1) === 1;
            put(sx, y, Z1 - 2, odd ? dk : hc); put(sx, y, Z1 - 1, odd ? hc : dk);
            if (odd) put(sx, y, Z1, hc);
          }
          put(sx, Y0 - 6, Z1 - 2, tie); put(sx, Y0 - 6, Z1 - 1, tie);
          put(sx, Y0 - 7, Z1 - 2, hc);
        }
      }
      break;
    }
    case "mohawk": {
      const shaved = mix(pal.skin, hc, 0.28);
      for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) v.paint(x, Y1, z, shaved, 0.05);
      for (let z = Z0; z <= Z1 - 1; z++) for (let y = Y0 + 6; y < Y1; y++) { v.paint(X0, y, z, shaved, 0.05); v.paint(X1, y, z, shaved, 0.05); }
      for (let z = Z0; z <= Z1 + 1; z++) {
        const h = z === Z1 + 1 ? 2 : z === Z0 ? 2 : 3 + (z > Z0 + 2 && z < Z1 - 1 ? 1 : 0);
        for (let i = 0; i < h; i++) { put(-1, Y1 + 1 + i, z); put(0, Y1 + 1 + i, z); }
      }
      break;
    }
    default: break;
  }
  let maxY = Y1;
  for (const k of ctx.hairKeys) { const x = kx(k), z = kz(k); if (x >= X0 && x <= X1 && z >= Z0 && z <= Z1) maxY = Math.max(maxY, ky(k)); }
  A.hairTop = maxY;
}

function clearHair(ctx, pred) {
  const v = ctx.parts.head.vox;
  for (const k of [...ctx.hairKeys]) {
    if (pred(kx(k), ky(k), kz(k))) { v.m.delete(k); ctx.hairKeys.delete(k); }
  }
}

function buildFacialHair(ctx) {
  const { a, pal, A } = ctx;
  let fh = a.facialHair;
  if (a.creature === "dwarf" && fh === "none" && a.gender !== "female") fh = "long_beard";
  if (fh === "none") return;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Z1 } = A;
  const hc = pal.hair;
  const put = (x, y, z) => v.set(x, y, z, hash3(x, y, z, ctx.seed) < 0.2 ? shade(hc, 0.82) : hc, MAT_SOLID, 0.07);
  const mustache = () => {
    v.det(-2.05, Y0 + 1.85, Z1 + 1, 2.05, Y0 + 2.6, Z1 + 1.45, hc);
    v.det(-2.45, Y0 + 1.25, Z1 + 1, -1.6, Y0 + 2.2, Z1 + 1.4, shade(hc, 0.9));
    v.det(1.6, Y0 + 1.25, Z1 + 1, 2.45, Y0 + 2.2, Z1 + 1.4, shade(hc, 0.9));
  };
  if (fh === "stubble") {
    const st = mix(pal.skin, hc, 0.3);
    for (let x = X0; x <= X1; x++) for (let y = Y0; y <= Y0 + 1; y++) v.paint(x, y, Z1, st, 0.12);
    for (const x of [X0, X1]) for (let z = Z1 - 3; z <= Z1; z++) for (let y = Y0; y <= Y0 + 3; y++) v.paint(x, y, z, st, 0.12);
    return;
  }
  if (fh === "mustache") { mustache(); return; }
  // beard / long beard
  for (let x = X0; x <= X1; x++) for (let y = Y0 - 1; y <= Y0 + 1; y++) {
    if (y === Y0 + 1 && (x === -1 || x === 0)) continue;
    put(x, y, Z1 + 1);
  }
  for (let x = X0; x <= X1; x++) for (let z = Z1 - 3; z <= Z1; z++) put(x, Y0 - 1, z);
  for (const x of [X0 - 1, X1 + 1]) for (let y = Y0 - 1; y <= Y0 + 4; y++) for (let z = Z1 - 3; z <= Z1; z++) put(x, y, z);
  for (const x of [X0, X0 + 1, X1 - 1, X1]) put(x, Y0 + 2, Z1 + 1);
  mustache();
  ctx.A.mouthZ = Z1 + 1;
  if (fh === "long_beard") {
    const len = ctx.a.age === "child" ? 3 : 7;
    for (let k = 0; k < len; k++) {
      const y = Y0 - 2 - k;
      const hwk = Math.max(1, 5 - Math.floor(k * 0.7));
      for (let x = -hwk; x <= hwk - 1; x++) for (let z = Z1 - 2; z <= Z1 + 1; z++) {
        if (z === Z1 - 2 && k > 2) continue;
        put(x, y, z);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tails & wings (separate animated parts)
// ---------------------------------------------------------------------------------------------

function buildTail(ctx) {
  const { a, pal, D } = ctx;
  const cr = a.creature;
  const { legH, bz0 } = D;
  const fur = pal.skin;
  const { light } = animalTraits(cr, fur);
  const root = [0, legH + 1, bz0];
  const v = addPart(ctx, "tail", "body", root);
  switch (cr) {
    case "fox": case "wolf": {
      const tip = cr === "fox" ? 0xfffaf2 : light;
      v.box(-1, 0, legH, legH + 1, bz0 - 2, bz0 - 1, fur);
      v.box(-3, 0, legH, legH + 2, bz0 - 4, bz0 - 2, fur);
      v.box(-5, -2, legH + 1, legH + 3, bz0 - 5, bz0 - 3, fur);
      v.box(-6, -3, legH + 2, legH + 4, bz0 - 5, bz0 - 3, (x, y) => (x <= -5 && y >= legH + 3 ? tip : fur));
      v.box(-7, -5, legH + 3, legH + 5, bz0 - 4, bz0 - 3, tip);
      v.box(-6, -4, legH + 4, legH + 4, bz0 - 5, bz0 - 5, tip);
      break;
    }
    case "cat": case "lion": {
      const path = [[-1, 0, 1], [-2, 0, 2], [-3, 0, 2], [-4, 0, 2], [-5, 1, 2], [-6, 1, 2], [-7, 2, 2], [-7, 3, 2], [-7, 4, 2], [-7, 5, 1], [-6, 6, 1]];
      path.forEach(([x, y, d], i) => v.box(x, x, legH + y, legH + y, bz0 - d - 1, bz0 - d, cr === "cat" && i % 3 === 2 ? shade(fur, 0.74) : fur));
      if (cr === "lion") v.box(-7, -5, legH + 6, legH + 7, bz0 - 2, bz0 - 1, mix(fur, 0x7a3b12, 0.55));
      else v.box(-6, -6, legH + 7, legH + 7, bz0 - 2, bz0 - 1, fur);
      break;
    }
    case "dog": v.box(-1, 0, legH + 1, legH + 3, bz0 - 2, bz0 - 1, (x, y) => (y === legH + 3 ? light : fur)); break;
    case "rabbit": v.box(-1, 0, legH, legH + 2, bz0 - 2, bz0 - 1, 0xffffff); v.set(-2, legH + 1, bz0 - 1, 0xffffff); v.set(1, legH + 1, bz0 - 1, 0xffffff); break;
    case "bear": v.box(-1, 0, legH, legH + 1, bz0 - 1, bz0 - 1, fur); break;
    case "pig":
      v.det(-0.3, legH + 0.5, bz0 - 1.0, 0.3, legH + 1.1, bz0, shade(fur, 0.9));
      v.det(-0.3, legH + 1.1, bz0 - 1.6, 0.3, legH + 1.7, bz0 - 0.6, shade(fur, 0.9));
      v.det(-0.3, legH + 1.7, bz0 - 1.0, 0.3, legH + 2.3, bz0 - 0.4, shade(fur, 0.9));
      break;
    case "mouse":
      for (let i = 0; i < 9; i++) v.det(-0.25, legH - 0.5 + Math.sin(i * 0.7) * 0.8 + i * 0.25, bz0 - 0.5 - i * 0.7, 0.25, legH + 0.0 + Math.sin(i * 0.7) * 0.8 + i * 0.25, bz0 - i * 0.7, 0xf2a3b0);
      break;
    case "dragon": {
      const spike = shade(fur, 0.7);
      let xs = 0, yc = 0, z = 0;
      for (let k = 0; k < 9; k++) {
        z = bz0 - 1 - k;
        xs = -Math.round(k * 0.6);
        yc = legH + 1 - Math.min(k, 4) + (k > 6 ? k - 6 : 0);
        const w = Math.max(1, 3 - Math.floor(k / 3));
        v.box(xs - w, xs + w - 1, Math.max(0, yc - 1), yc + (k < 3 ? 1 : 0), z, z, fur);
        if (k % 2 === 0) v.box(xs - 1, xs, yc + (k < 3 ? 2 : 1), yc + (k < 3 ? 2 : 1), z, z, spike);
      }
      v.box(xs - 2, xs + 1, yc + 1, yc + 1, z - 1, z, spike);
      v.box(xs - 1, xs, yc + 2, yc + 2, z - 1, z - 1, spike);
      break;
    }
    default: break;
  }
}

/** Wings on the back: style "feather" | "bat" | "fairy" (translucent two-lobed). */
function buildWings(ctx, style, color, membrane) {
  const { D } = ctx;
  const { hy, bz0 } = D;
  for (const side of [-1, 1]) {
    const name = side < 0 ? "wingR" : "wingL";
    const v = addPart(ctx, name, "body", [side * 1, hy - 2, bz0 - 0.5], [0, side * 0.55, side * -0.12]);
    if (style === "fairy") {
      const rimC = mix(color, 0x8a9fd6, 0.5);
      for (let u = 1; u <= 10; u++) for (let y = hy - 7; y <= hy + 7; y++) {
        const fu = u - 0.5, fy = y + 0.5 - hy;
        const e = Math.min(((fu - 4.6) / 4.6) ** 2 + ((fy - 2.6) / 3.8) ** 2, ((fu - 3.2) / 3.1) ** 2 + ((fy + 2.8) / 2.7) ** 2);
        if (e > 1) continue;
        const x = side < 0 ? -u - 1 : u;
        const rim = e > 0.6 || (u > 2 && (u + y) % 5 === 0 && e > 0.3);
        v.set(x, y, bz0 - 1, rim ? rimC : membrane, rim ? MAT_SOLID : MAT_GHOST, 0.03);
      }
      continue;
    }
    for (let u = 1; u <= 9; u++) {
      const x = side < 0 ? -u - 1 : u;
      const topY = hy + Math.min(u, 6) * 0.5 - Math.max(0, u - 6) * 0.9;
      const botY = hy - 4 - Math.floor(u * 0.45) + (style === "bat" ? (u % 3 === 0 ? 2 : 0) : 0);
      for (let y = Math.floor(botY); y <= Math.floor(topY); y++) {
        const edge = y === Math.floor(topY);
        let c;
        if (style === "bat") c = edge || u % 3 === 0 ? color : membrane;
        else {
          const light = luma(color) > 0.65;
          const band = Math.floor((topY - y) / 2.2);
          const rim = light ? mix(color, 0x7d93c4, 0.42) : mix(color, 0xffffff, 0.3);
          const tip = y === Math.floor(botY) || u === 9;
          c = edge || tip ? rim : band % 2 ? (light ? mix(color, 0xa9bde3, 0.3) : shade(color, 0.9)) : color;
          if (y === Math.floor(botY) && u % 2 === 0) v.set(x, y - 1, bz0 - 1, rim);
        }
        v.set(x, y, bz0 - 1, c, MAT_SOLID, 0.05);
        if (u < 4 && style !== "bat") v.set(x, y, bz0 - 2, shade(c, 0.95));
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Snakes, horses, birds
// ---------------------------------------------------------------------------------------------

function designSnake(ctx) {
  const { pal } = ctx;
  ctx.kind = "snake";
  const sk = pal.skin, belly = mix(sk, 0xfff2c6, 0.55), mark = shade(sk, 0.68);
  const body = addPart(ctx, "body", "rig", [0, 0, 0.5]);
  const rings = [[0, 5.2], [2.2, 3.9], [4.3, 2.6]];
  for (const [base, R] of rings) {
    for (let x = -8; x <= 7; x++) for (let z = -8; z <= 8; z++) for (let y = Math.floor(base); y <= Math.floor(base) + 3; y++) {
      const cx = x + 0.5, cz = z + 0.5 - 0.5;
      const rho = Math.hypot(cx, cz);
      const d = Math.hypot(rho - R, y + 0.5 - (base + 1.5));
      if (d > 1.55) continue;
      const th = Math.atan2(cz, cx);
      const band = Math.floor(((th + Math.PI) / (Math.PI * 2)) * 14);
      const upper = y + 0.5 > base + 1.6;
      const c = rho < R - 0.6 || !upper && rho > R + 0.9 ? belly : upper && band % 2 === 0 ? mark : sk;
      body.set(x, y, z, c, MAT_SOLID, 0.05);
    }
  }
  // neck rising from the top ring
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const py = 5.5 + 7 * t, pz = 1.2 + 2.2 * Math.sin(t * Math.PI * 0.6);
    for (let x = -2; x <= 1; x++) for (let y = Math.floor(py - 2); y <= Math.ceil(py + 2); y++) for (let z = Math.floor(pz - 2); z <= Math.ceil(pz + 2); z++) {
      if (Math.hypot(x + 0.5, y + 0.5 - py, z + 0.5 - pz) > 1.6) continue;
      body.set(x, y, z, z + 0.5 > pz + 0.6 ? belly : (y % 3 === 0 ? mark : sk));
    }
  }
  // tail tip on the ground
  const tail = addPart(ctx, "tail", "body", [4.5, 0.5, 4]);
  for (let i = 0; i < 4; i++) tail.box(4 + i, 4 + i, 0, i < 2 ? 1 : 0, 4 + Math.floor(i / 2), 4 + Math.floor(i / 2), i % 2 ? mark : sk);
  const Y0 = 12, Y1 = 17, X0 = -4, X1 = 3, Z0 = -1, Z1 = 6;
  const head = addPart(ctx, "head", "body", [0, 12, 3]);
  head.box(X0, X1, Y0, Y1, Z0, Z1, (x, y, z) => (y === Y0 ? belly : (y === Y1 && (x + z) % 3 === 0 ? mark : sk)), MAT_SOLID, 0.05);
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) { head.del(x, Y1, z); head.del(x, Y0, z); }
  ctx.A = { X0, X1, Y0, Y1, Z0, Z1, FZ: Z1 + 1, faceZ: Z1 + 1, eyeY: Y0 + 2, eyeXR: -3, eyeXL: 1, mouthY: Y0 + 0.9, mouthZ: Z1 + 1, blushY: Y0 + 1.1, hairTop: Y1, noBrows: true };
  ctx.D = { legH: 6, hy: 12, bx0: -3, bx1: 2, bz0: -2, bz1: 2, armLen: 4, armW: 2, zc: 0.5 };
  for (const n of ["armR", "armL", "legR", "legL"]) addPart(ctx, n, n.startsWith("arm") ? "body" : "rig", [n.endsWith("R") ? -4 : 4, 6, 0.5]);
  ctx.hand = null;
  faceFeatures(ctx);
  const m = ctx.parts.mouth.vox;
  m.det(-0.2, Y0 + 0.55, Z1 + 1, 0.2, Y0 + 0.8, Z1 + 2.6, 0xd8344a);
  m.det(-0.55, Y0 + 0.55, Z1 + 2.5, -0.15, Y0 + 0.8, Z1 + 3.1, 0xd8344a);
  m.det(0.15, Y0 + 0.55, Z1 + 2.5, 0.55, Y0 + 0.8, Z1 + 3.1, 0xd8344a);
}

function designHorse(ctx) {
  const { pal, a } = ctx;
  ctx.kind = "quad";
  const coat = pal.skin;
  const mane = a.hair.style !== "none" ? pal.hair : shade(coat, 0.5);
  const hoof = luma(pal.shoes) < 0.5 ? pal.shoes : 0x3a2c26;
  const muzzle = mix(coat, 0xf3e6d8, 0.35);
  const legH = 7;
  const body = addPart(ctx, "body", "rig", [0, legH, 0.5]);
  body.box(-3, 2, legH, legH + 6, -7, 7, coat, MAT_SOLID, 0.04);
  for (const x of [-3, 2]) for (const y of [legH, legH + 6]) for (const z of [-7, 7]) body.del(x, y, z);
  for (let z = -7; z <= 7; z++) { body.del(-3, legH + 6, z); body.del(2, legH + 6, z); }
  for (let z = -6; z <= 6; z++) for (let x = -2; x <= 1; x++) body.set(x, legH, z, mix(coat, 0xffffff, 0.08));
  if (cdist(pal.top, coat) > 70) {
    for (let z = -2; z <= 2; z++) for (let x = -3; x <= 2; x++) body.set(x, legH + 6, z, pal.top);
    for (let z = -2; z <= 2; z++) for (let y = legH + 3; y <= legH + 5; y++) { body.set(-4, y, z, y === legH + 3 ? pal.accent : pal.top); body.set(3, y, z, y === legH + 3 ? pal.accent : pal.top); }
    body.box(-2, 1, legH + 7, legH + 7, -1, 1, 0x6a3e22);
    body.box(-2, 1, legH + 8, legH + 8, -1, -1, 0x6a3e22);
  }
  const legs = [["armR", -3, 4], ["armL", 1, 4], ["legR", -3, -6], ["legL", 1, -6]];
  for (const [n, x0, z0] of legs) {
    const v = addPart(ctx, n, n.startsWith("arm") ? "body" : "rig", [x0 + 1, legH, z0 + 1]);
    v.box(x0, x0 + 1, 0, legH - 1, z0, z0 + 1, (x, y) => (y <= 1 ? hoof : y === 2 ? mix(coat, 0xffffff, 0.45) : coat));
  }
  const head = addPart(ctx, "head", "body", [0, legH + 5, 6]);
  for (let y = legH + 4; y <= legH + 10; y++) {
    const zs = 5 + Math.floor((y - legH - 4) / 2);
    head.box(-2, 1, y, y, zs, zs + 3, coat);
    head.box(-1, 0, y, y, zs - 1, zs - 1, mane, MAT_SOLID, 0.08);
  }
  const Y0 = legH + 9, Y1 = legH + 15, X0 = -3, X1 = 2, Z0 = 8, Z1 = 13;
  head.box(X0, X1, Y0, Y1, Z0, Z1, coat, MAT_SOLID, 0.04);
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) head.del(x, Y1, z);
  head.box(-2, 1, Y0, Y0 + 2, Z1 + 1, Z1 + 3, (x, y, z) => (z === Z1 + 3 && y === Y0 + 2 ? shade(muzzle, 0.9) : muzzle));
  head.det(-1.6, Y0 + 1.6, Z1 + 4, -0.8, Y0 + 2.3, Z1 + 4.1, shade(muzzle, 0.5));
  head.det(0.8, Y0 + 1.6, Z1 + 4, 1.6, Y0 + 2.3, Z1 + 4.1, shade(muzzle, 0.5));
  for (const x of [X0, X1]) { head.box(x, x, Y1 + 1, Y1 + 2, Z0 + 2, Z0 + 3, coat); head.set(x, Y1 + 3, Z0 + 3, coat); head.set(x, Y1 + 1, Z0 + 3, mix(coat, K.pink, 0.4)); }
  for (let z = Z0; z <= Z1; z++) head.box(-1, 0, Y1 + 1, Y1 + 1, z, z, mane, MAT_SOLID, 0.08);
  head.box(-1, 0, Y1 - 1, Y1, Z1 + 1, Z1 + 1, mane, MAT_SOLID, 0.08);
  for (let y = Y0; y <= Y1; y++) head.box(-1, 0, y, y, Z0 - 1, Z0 - 1, mane, MAT_SOLID, 0.08);
  const tail = addPart(ctx, "tail", "body", [0, legH + 5, -7.5]);
  for (let y = legH + 5; y >= 2; y--) {
    const z = -8 - Math.floor((legH + 5 - y) / 3);
    tail.box(-1, 0, y, y, z, z, mane, MAT_SOLID, 0.1);
    if (y < legH + 2) tail.box(-1, 0, y, y, z - 1, z - 1, mane, MAT_SOLID, 0.1);
  }
  ctx.A = { X0, X1, Y0, Y1, Z0, Z1, FZ: Z1 + 1, faceZ: Z1 + 1, eyeY: Y0 + 3, eyeXR: -3, eyeXL: 1, mouthY: Y0 + 0.75, mouthZ: Z1 + 4, blushY: Y0 + 2.6, hairTop: Y1 + 1, noBrows: true };
  ctx.D = { legH, hy: legH + 7, bx0: -3, bx1: 2, bz0: -7, bz1: 7, armLen: 6, armW: 2, zc: 0.5, horse: true };
  ctx.hand = null;
  faceFeatures(ctx);
}

function designBird(ctx) {
  const { pal, a } = ctx;
  const owl = a.creature === "owl";
  ctx.kind = "bird";
  const pl = pal.skin, belly = mix(pl, 0xfffaf0, owl ? 0.55 : 0.62), wing = shade(pl, 0.78);
  const legH = 2;
  const bw = owl ? 10 : 8, bd = owl ? 9 : 7, bh = owl ? 8 : 7;
  const bx0 = -bw / 2, bx1 = bw / 2 - 1, bz0 = -(bd - 1) / 2, bz1 = (bd - 1) / 2;
  const top = legH + bh - 1;
  const body = addPart(ctx, "body", "rig", [0, legH, 0.5]);
  body.box(bx0, bx1, legH, top, bz0, bz1, (x, y, z) => {
    if (z === bz1 && x > bx0 && x < bx1) return owl && (y + x) % 3 === 0 && y < top - 1 ? shade(belly, 0.82) : belly;
    return pl;
  }, MAT_SOLID, 0.05);
  for (const x of [bx0, bx1]) for (const z of [bz0, bz1]) for (const y of [legH, top]) body.del(x, y, z);
  for (const x of [bx0, bx1]) for (let y = legH; y <= top; y++) { body.del(x, y, bz0); body.del(x, y, bz1); }
  for (const [n, x0] of [["legR", -3], ["legL", 1]]) {
    const v = addPart(ctx, n, "rig", [x0 + 1, legH, 0.5]);
    v.box(x0, x0 + 1, 0, legH - 1, 0, 1, K.beak);
    for (const dx of [0.1, 0.8, 1.5]) v.det(x0 + dx, 0, 2, x0 + dx + 0.42, 0.45, 2.9, shade(K.beak, 0.85));
  }
  const hw = owl ? 12 : 8, hd = owl ? 9 : 7, hh = owl ? 9 : 7;
  const X0 = -hw / 2, X1 = hw / 2 - 1, Y0 = top + 1, Y1 = top + hh, Z0 = -(hd - 1) / 2, Z1 = (hd - 1) / 2;
  const head = addPart(ctx, "head", "body", [0, Y0, 0.5]);
  head.box(X0, X1, Y0, Y1, Z0, Z1, pl, MAT_SOLID, 0.05);
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) { head.del(x, Y1, z); head.del(x, Y0, z); }
  if (owl) {
    const disc = mix(pl, 0xfff3e0, 0.5);
    for (const cx of [-2.5, 2.5]) for (let x = X0; x <= X1; x++) for (let y = Y0; y <= Y1 - 1; y++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - (Y0 + 4.2));
      if (d < 2.9) head.set(x, y, Z1, d > 2.2 ? shade(pl, 0.72) : disc);
    }
    for (const [x, o] of [[X0, 1], [X1, -1]]) { head.box(x, x + o, Y1 + 1, Y1 + 1, -1, 0, pl); head.set(x, Y1 + 2, -1, shade(pl, 0.8)); head.set(x, Y1 + 2, 0, shade(pl, 0.8)); }
    head.box(-1, 0, Y0 + 1, Y0 + 3, Z1 + 1, Z1 + 1, K.beak);
    head.set(-1, Y0 + 1, Z1 + 2, shade(K.beak, 0.85)); head.set(0, Y0 + 1, Z1 + 2, shade(K.beak, 0.85));
    ctx.A = { X0, X1, Y0, Y1, Z0, Z1, FZ: Z1 + 1, faceZ: Z1 + 1, eyeY: Y0 + 3, eyeXR: -4, eyeXL: 2, mouthY: Y0 + 0.4, mouthZ: Z1 + 1, blushY: Y0 + 1.2, hairTop: Y1, noBrows: true, owl: true };
  } else {
    head.box(-1, 0, Y0 + 1, Y0 + 2, Z1 + 1, Z1 + 2, K.beak);
    head.set(-1, Y0 + 1, Z1 + 3, shade(K.beak, 0.9)); head.set(0, Y0 + 1, Z1 + 3, shade(K.beak, 0.9));
    for (let i = 0; i < 3; i++) head.box(-1, 0, Y1 + 1 + (i === 1 ? 1 : 0), Y1 + 1 + (i === 1 ? 1 : 0), Z1 - 2 - i * 2, Z1 - 1 - i * 2, wing);
    head.box(-1, 0, Y1 + 1, Y1 + 1, Z0 + 1, Z1 - 1, wing);
    ctx.A = { X0, X1, Y0, Y1, Z0, Z1, FZ: Z1 + 1, faceZ: Z1 + 1, eyeY: Y0 + 3, eyeXR: -3, eyeXL: 1, mouthY: Y0 + 0.5, mouthZ: Z1 + 1, blushY: Y0 + 1.8, hairTop: Y1 + 2, noBrows: true };
  }
  const armLen = bh - 1;
  for (const side of ["R", "L"]) {
    const x0 = side === "R" ? bx0 - 1 : bx1 + 1;
    const v = addPart(ctx, "arm" + side, "body", [x0 + 0.5, top + 0.5, 0.5], [0, 0, side === "R" ? -0.08 : 0.08]);
    for (let y = top - armLen + 1; y <= top; y++) for (let z = bz0 + 1; z <= bz1 - 1; z++) {
      if (y < top - armLen + 3 && z > bz1 - 3) continue;
      v.set(x0, y, z, (top - y) % 3 === 2 ? shade(wing, 0.85) : wing);
    }
    for (let z = bz0; z <= bz0 + 1; z++) v.set(x0, top - armLen + 1, z - 1, shade(wing, 0.8));
  }
  const tail = addPart(ctx, "tail", "body", [0, legH + 1, bz0]);
  tail.box(-1, 0, legH, legH + 1, bz0 - (owl ? 1 : 3), bz0 - 1, (x, y, z) => (z % 2 ? wing : shade(wing, 0.85)));
  if (!owl) tail.box(-1, 0, legH + 2, legH + 2, bz0 - 4, bz0 - 3, wing);
  ctx.D = { legH, hy: Y0, bx0, bx1, bz0, bz1, armLen, armW: 1, zc: 0.5, bird: true };
  ctx.hand = [bx0 - 0.5, top - armLen + 1.5, 0.5];
  faceFeatures(ctx);
  if (owl) {
    // big round owl eyes replace the default ones
    const e = ctx.parts.eyes.vox;
    e.d.length = 0;
    const iris = luma(pal.eyes) > 0.35 ? pal.eyes : 0xffc83a;
    for (const cx of [-2.5, 2.5]) {
      e.det(cx - 1.6, Y0 + 2.6, Z1 + 0.98, cx + 1.6, Y0 + 5.8, Z1 + 1.08, 0xfffaf0);
      e.det(cx - 1.25, Y0 + 2.95, Z1 + 1.08, cx + 1.25, Y0 + 5.45, Z1 + 1.14, iris);
      e.det(cx - 0.8, Y0 + 3.4, Z1 + 1.14, cx + 0.8, Y0 + 5.0, Z1 + 1.2, 0x16110e);
      e.det(cx - 0.65, Y0 + 4.2, Z1 + 1.2, cx - 0.1, Y0 + 4.75, Z1 + 1.25, 0xffffff, MAT_GLOW);
    }
    ctx.parts.eyes.pivot = [0, Y0 + 4.2, Z1 + 1];
  }
}

// ---------------------------------------------------------------------------------------------
// Headwear
// ---------------------------------------------------------------------------------------------

function buildHeadwear(ctx) {
  const { a, pal, A } = ctx;
  const kind = a.headwear;
  if (kind === "none") return;
  const v = ctx.parts.head.vox;
  const { X0, X1, Y0, Y1, Z0, Z1 } = A;
  const c = pal.hw;
  const set = (x, y, z, col, mat = MAT_SOLID, amp) => { v.set(x, y, z, col, mat, amp); ctx.hairKeys.delete(key(x, y, z)); };
  const cxm = (X0 + X1 + 1) / 2, czm = (Z0 + Z1 + 1) / 2;
  const roundBrim = (y, r, col, mat = MAT_SOLID, rz = r) => {
    for (let x = Math.floor(cxm - r - 1); x <= Math.ceil(cxm + r); x++) for (let z = Math.floor(czm - rz - 1); z <= Math.ceil(czm + rz); z++) {
      const dx = (x + 0.5 - cxm) / r, dz = (z + 0.5 - czm) / rz;
      if (dx * dx + dz * dz <= 1.0) set(x, y, z, typeof col === "function" ? col(x, y, z) : col, mat);
    }
  };
  const block = (x0, x1, y0, y1, z0, z1, col, mat = MAT_SOLID, roundTop = true) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (roundTop && y === y1 && (x === x0 || x === x1) && (z === z0 || z === z1)) continue;
      set(x, y, z, typeof col === "function" ? col(x, y, z) : col, mat);
    }
  };
  const brimY = Y1 + 1;
  switch (kind) {
    case "crown": {
      const gold = orDefault(c, K.gold);
      const y0 = A.hairTop + 1;
      for (let x = -3; x <= 2; x++) for (let z = -2; z <= 3; z++) {
        const edge = x === -3 || x === 2 || z === -2 || z === 3;
        if (!edge) continue;
        set(x, y0, z, gold, MAT_METAL, 0.03);
        const corner = (x === -3 || x === 2) && (z === -2 || z === 3);
        const mid = (x === -1 || x === 0) && (z === -2 || z === 3) || (z === 0 || z === 1) && (x === -3 || x === 2);
        if (corner || mid) set(x, y0 + 1, z, gold, MAT_METAL, 0.03);
        if (corner) v.det(x + 0.2, y0 + 2, z + 0.2, x + 0.8, y0 + 2.6, z + 0.8, mix(gold, 0xffffff, 0.4), MAT_METAL);
      }
      v.det(-0.75, y0 + 0.2, 4, 0.75, y0 + 1.5, 4.3, 0xd8344a, MAT_METAL);
      v.det(-3.3, y0 + 0.3, 0.3, -3.0, y0 + 1.1, 1.7, 0x3a8fd8, MAT_METAL);
      v.det(3.0, y0 + 0.3, 0.3, 3.3, y0 + 1.1, 1.7, 0x3a8fd8, MAT_METAL);
      break;
    }
    case "tiara": {
      const metal = orDefault(c, 0xe9e4f0);
      const y0 = A.hairTop + 0.6, z0 = Z1 - 0.6;
      v.det(-4, y0, z0, 4, y0 + 0.45, z0 + 0.6, metal, MAT_METAL);
      const peaks = [[-3.6, 0.6], [-2.4, 1.0], [-1.2, 1.5], [0, 2.1], [1.2, 1.5], [2.4, 1.0], [3.6, 0.6]];
      for (const [x, h] of peaks) v.det(x - 0.3, y0 + 0.4, z0 + 0.1, x + 0.3, y0 + 0.4 + h, z0 + 0.5, metal, MAT_METAL);
      v.det(-0.55, y0 + 0.9, z0 + 0.45, 0.55, y0 + 1.9, z0 + 0.75, 0xff6fa8, MAT_METAL);
      break;
    }
    case "wizard_hat": case "top_hat": case "cap": case "feather_hat": case "tricorn": case "straw_hat": {
      clearHair(ctx, (x, y, z) => y >= brimY && x >= X0 - 1 && x <= X1 + 1 && z >= Z0 - 1 && z <= Z1 + 1);
      if (kind === "wizard_hat") {
        const band = orDefault(pal.acc, K.gold) === pal.acc && cdist(pal.acc, c) > 80 ? pal.acc : mix(c, K.gold, 0.75);
        roundBrim(brimY, 7.4, c, MAT_SOLID, 7);
        const sizes = [10, 10, 8, 8, 6, 6, 5, 4, 3, 2, 2, 1];
        let bend = 0;
        sizes.forEach((sz, i) => {
          const y = brimY + 1 + i;
          if (i >= 8) bend -= 1;
          const half = sz / 2;
          for (let x = Math.ceil(cxm - half); x < cxm + half; x++) for (let z = Math.ceil(czm - half) + bend; z < czm + half + bend; z++) {
            if (sz >= 6 && (x === Math.ceil(cxm - half) || x === Math.ceil(cxm + half) - 1) && (z === Math.ceil(czm - half) + bend || z === Math.ceil(czm + half) + bend - 1)) continue;
            set(x, y, z, i < 2 && i === 0 ? band : c, MAT_SOLID, 0.05);
          }
        });
        const star = 0xffe27a;
        v.det(-0.5, brimY + 3.5, czm + 3.0, 0.5, brimY + 4.5, czm + 3.2, star, MAT_GLOW);
        v.det(-1.0, brimY + 3.85, czm + 3.0, 1.0, brimY + 4.15, czm + 3.15, star, MAT_GLOW);
        v.det(-0.15, brimY + 3.0, czm + 3.0, 0.15, brimY + 5.0, czm + 3.15, star, MAT_GLOW);
        v.det(1.6, brimY + 6.2, czm + 1.2, 2.0, brimY + 6.6, czm + 1.4, star, MAT_GLOW);
      } else if (kind === "top_hat") {
        roundBrim(brimY, 6.6, c, MAT_SOLID, 6.2);
        const band = luma(c) < 0.3 ? 0x9b2d34 : shade(c, 0.6);
        block(-4, 3, brimY + 1, brimY + 6, -3, 4, (x, y) => (y <= brimY + 2 ? band : c), MAT_SOLID, true);
      } else if (kind === "cap") {
        block(X0, X1, brimY, brimY, Z0, Z1, c, MAT_SOLID, false);
        block(X0 + 1, X1 - 1, brimY + 1, brimY + 1, Z0 + 1, Z1 - 1, c, MAT_SOLID, true);
        for (let x = -3; x <= 2; x++) for (let z = Z1 + 1; z <= Z1 + 4; z++) if (!(z === Z1 + 4 && (x === -3 || x === 2))) set(x, brimY, z, z === Z1 + 4 ? shade(c, 0.9) : c);
        v.det(-0.4, brimY + 2, czm - 0.4, 0.4, brimY + 2.4, czm + 0.4, shade(c, 0.8));
        v.det(-1, brimY + 0.2, Z1 + 1, 1, brimY + 1.0, Z1 + 1.12, mix(c, 0xffffff, 0.7));
      } else if (kind === "feather_hat") {
        // cavalier hat: wide brim pinned up on the far side, low round crown, big sweeping plume
        roundBrim(brimY, 8.6, c, MAT_SOLID, 8.0);
        for (let x = X1 + 2; x <= X1 + 7; x++) for (let z = Z0 - 6; z <= Z1 + 6; z++) {
          if (!v.has(x, brimY, z)) continue;
          v.del(x, brimY, z);
          set(X1 + 2, brimY + (x - X1 - 1), z, shade(c, 0.92));
        }
        const band = cdist(pal.acc, c) > 80 && luma(pal.acc) > 0.3 ? pal.acc : K.gold;
        block(-4, 3, brimY + 1, brimY + 2, -3, 4, (x, y) => (y === brimY + 1 ? band : c), MAT_SOLID, false);
        block(-3, 2, brimY + 3, brimY + 3, -2, 3, c, MAT_SOLID, true);
        const plume = luma(c) < 0.55 ? 0xf7f3ea : 0xd2343a;
        const path = [[-4, 2, 3], [-4, 3, 2], [-4, 4, 1], [-4, 5, 0], [-4, 5, -1], [-5, 5, -2], [-6, 4, -3], [-7, 3, -4], [-8, 2, -4], [-9, 1, -4], [-9, 0, -4]];
        path.forEach(([x, dy, z], i) => {
          const y = brimY + dy;
          const col = i % 2 ? shade(plume, 0.9) : plume;
          set(x, y, z, col); set(x + 1, y, z, col);
          if (i > 0 && i < 9) { set(x, y + 1, z, mix(plume, 0xffffff, 0.35)); set(x + 1, y + 1, z, col); set(x, y, z - 1, shade(plume, 0.86)); }
        });
      } else if (kind === "tricorn") {
        // three-cornered hat: triangular brim with walls rising towards the corners, gold trim
        const trim = cdist(pal.acc, c) > 80 && luma(pal.acc) > 0.3 ? pal.acc : K.gold;
        const verts = [[cxm, Z1 + 4.2], [cxm - 7.6, Z0 - 1.6], [cxm + 7.6, Z0 - 1.6]];
        const edges = [[verts[0], verts[1]], [verts[1], verts[2]], [verts[2], verts[0]]];
        const sd = (px, pz, [ax, az], [bx, bz]) => ((px - ax) * (bz - az) - (pz - az) * (bx - ax)) / Math.hypot(bx - ax, bz - az);
        block(-4, 3, brimY + 1, brimY + 4, -3, 3, c, MAT_SOLID, true);
        for (let x = -10; x <= 10; x++) for (let z = Z0 - 4; z <= Z1 + 6; z++) {
          const px = x + 0.5, pz = z + 0.5;
          const d = edges.map(([p0, p1]) => sd(px, pz, p0, p1));
          if (!(d.every((q) => q <= 0) || d.every((q) => q >= 0))) continue;
          const m = Math.min(...d.map(Math.abs));
          set(x, brimY, z, shade(c, 0.9));
          if (m < 1.35) {
            const nearV = Math.min(...verts.map(([vx, vz]) => Math.hypot(px - vx, pz - vz)));
            const h = nearV < 3.2 ? 3 : 2;
            for (let k = 1; k <= h; k++) set(x, brimY + k, z, k === h ? trim : c, k === h ? MAT_METAL : MAT_SOLID);
          }
        }
      } else if (kind === "straw_hat") {
        const straw = orDefault(c, 0xe7c877);
        roundBrim(brimY, 8.4, (x, y, z) => (mod(x + z, 2) ? straw : shade(straw, 0.9)), MAT_SOLID, 8);
        for (let x = -10; x <= 10; x++) for (let z = -10; z <= 11; z++) {
          const dx = x + 0.5 - cxm, dz = z + 0.5 - czm;
          const r = Math.hypot(dx / 8.4, dz / 8);
          if (r <= 1 && r > 0.86) { v.del(x, brimY, z); set(x, brimY - 1, z, shade(straw, 0.92)); }
        }
        block(-4, 3, brimY + 1, brimY + 3, -3, 4, (x, y) => (y === brimY + 1 ? 0xc8363f : mod(x + y, 2) ? straw : shade(straw, 0.92)), MAT_SOLID, true);
      }
      break;
    }
    case "bow": {
      const col = unsetOr(c, 0xf06b8b);
      const knot = shade(col, 0.78), inner = mix(col, 0xffffff, luma(col) < 0.2 ? 0.18 : 0.3);
      const y = A.hairTop, bx = 2, bz = Z1 - 2;
      for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) set(bx, y + dy, bz + dz, knot);
      for (const o of [-1, 1]) for (let i = 1; i <= 3; i++) {
        const lo = i === 1 ? 0 : -1, hi = i === 1 ? 1 : 2;
        for (let dy = lo; dy <= hi; dy++) for (let dz = 0; dz <= 1; dz++) {
          const hollow = i === 2 && dy >= 0 && dy <= 1 && dz === 1;
          set(bx + o * i, y + dy, bz + dz, hollow ? inner : i === 3 && (dy === lo || dy === hi) ? shade(col, 0.9) : col);
        }
      }
      break;
    }
    case "hood": case "headscarf": case "beanie": case "helmet": case "bandana": {
      const metal = kind === "helmet";
      const col = metal ? orDefault(c, 0xb9c2cc) : c;
      const mat = metal ? MAT_METAL : MAT_SOLID;
      if (kind === "hood") {
        // rounded cowl (rounded-box shell) with an open face and a little point at the back
        clearHair(ctx, (x, y, z) => y > Y1 + 1 || x < X0 - 1 || x > X1 + 1 || z < Z0 - 1);
        const lining = shade(col, 0.6);
        const cx = cxm, cy = (Y0 - 1 + Y1 + 3) / 2, cz = czm - 0.5;
        const hx = (X1 - X0 + 1) / 2 + 2, hyy = (Y1 + 3 - (Y0 - 1)) / 2, hz = (Z1 - Z0 + 1) / 2 + 1.5, r = 3.2;
        for (let x = Math.floor(cx - hx); x <= Math.ceil(cx + hx); x++) for (let y = Y0 - 1; y <= Y1 + 3; y++) for (let z = Math.floor(cz - hz); z <= Math.ceil(cz + hz); z++) {
          const qx = Math.abs(x + 0.5 - cx) - (hx - r), qy = Math.abs(y + 0.5 - cy) - (hyy - r), qz = Math.abs(z + 0.5 - cz) - (hz - r);
          const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
          if (d > 0 || d < -1.35) continue;
          if (z >= Z1 && x >= X0 && x <= X1 && y <= Y1) continue; // face opening
          if (y === Y0 - 1 && x >= X0 && x <= X1 && z >= Z1 - 3) continue; // keep the chin free
          set(x, y, z, z >= Z1 ? lining : mod(x + z, 4) === 0 ? shade(col, 0.92) : col, MAT_SOLID, 0.05);
        }
        for (const [x, y, z] of [[-1, Y1 + 3, Z0 - 2], [0, Y1 + 3, Z0 - 2], [-1, Y1 + 2, Z0 - 3], [0, Y1 + 2, Z0 - 3], [0, Y1 + 1, Z0 - 4]]) set(x, y, z, col);
      } else if (kind === "helmet") {
        clearHair(ctx, (x, y) => y >= Y0 + 3);
        for (let x = X0 - 1; x <= X1 + 1; x++) for (let y = Y0 + 3; y <= Y1 + 2; y++) for (let z = Z0 - 1; z <= Z1 + 1; z++) {
          const insideSkull = x >= X0 && x <= X1 && y <= Y1 && z >= Z0 && z <= Z1;
          if (insideSkull) continue;
          if (y === Y1 + 2 && (x === X0 - 1 || x === X1 + 1 || z === Z0 - 1 || z === Z1 + 1)) continue;
          if (z === Z1 + 1) {
            const brow = y >= Y1 - 1;
            const nose = (x === -1 || x === 0) && y >= Y0 + 4;
            const cheek = (x <= X0 || x >= X1) && y >= Y0 + 3;
            if (!brow && !nose && !cheek) continue;
          }
          set(x, y, z, y === Y1 - 1 ? shade(col, 0.82) : col, mat, 0.03);
        }
        for (let z = Z0; z <= Z1; z++) set(-1, Y1 + 3, z, shade(col, 0.85), mat);
        for (let z = Z0; z <= Z1; z++) set(0, Y1 + 3, z, shade(col, 0.85), mat);
        for (const x of [X0 - 1.2, X1 + 1.0]) for (const z of [Z0 + 1.2, Z1 - 1.2]) v.det(x, Y1 - 0.8, z, x + 0.2, Y1 - 0.2, z + 0.6, mix(col, 0xffffff, 0.4), MAT_METAL);
      } else if (kind === "headscarf") {
        clearHair(ctx, (x, y) => y > Y1 + 1);
        const dotC = mix(col, 0xffffff, 0.65);
        for (let x = X0 - 1; x <= X1 + 1; x++) for (let y = Y0 + 2; y <= Y1 + 1; y++) for (let z = Z0 - 1; z <= Z1 + 1; z++) {
          const insideSkull = x >= X0 && x <= X1 && y <= Y1 && z >= Z0 && z <= Z1;
          if (insideSkull) continue;
          if (y === Y1 + 1 && (x === X0 - 1 || x === X1 + 1 || z === Z0 - 1 || z === Z1 + 1)) continue;
          if (z === Z1 + 1 && y < Y1 - 1 && x >= X0 && x <= X1) continue;
          if (z === Z1 + 1 && y < Y0 + 4) continue;
          set(x, y, z, hash3(x, y, z, 99) > 0.82 ? dotC : col, MAT_SOLID, 0.04);
        }
        for (let y = Y0 - 1; y <= Y0 + 1; y++) for (const x of [X0 - 1, X1 + 1]) set(x, y, Z1 - 1, col);
        block(-1, 0, Y0 - 2, Y0 - 1, Z1 - 1, Z1, shade(col, 0.85), MAT_SOLID, false);
        set(-2, Y0 - 3, Z1, col); set(1, Y0 - 3, Z1, col);
      } else if (kind === "beanie") {
        clearHair(ctx, (x, y) => y > Y0 + 6);
        for (let x = X0 - 1; x <= X1 + 1; x++) for (let y = Y0 + 6; y <= Y1 + 2; y++) for (let z = Z0 - 1; z <= Z1 + 1; z++) {
          const insideSkull = x >= X0 && x <= X1 && y <= Y1 && z >= Z0 && z <= Z1;
          if (insideSkull) continue;
          if (y === Y1 + 2 && (x <= X0 || x >= X1 || z <= Z0 || z >= Z1)) continue;
          set(x, y, z, mod(x + z, 2) ? col : shade(col, 0.88), MAT_SOLID, 0.04);
        }
        for (let x = X0 - 2; x <= X1 + 2; x++) for (let y = Y0 + 6; y <= Y0 + 7; y++) for (let z = Z0 - 2; z <= Z1 + 2; z++) {
          const ringCell = x === X0 - 2 || x === X1 + 2 || z === Z0 - 2 || z === Z1 + 2;
          if (!ringCell || ((x === X0 - 2 || x === X1 + 2) && (z === Z0 - 2 || z === Z1 + 2))) continue;
          set(x, y, z, mod(x + z, 2) ? shade(col, 0.82) : shade(col, 0.72));
        }
        const pom = mix(col, 0xffffff, 0.7);
        block(-1, 0, Y1 + 3, Y1 + 4, 0, 1, pom, MAT_SOLID, false);
        set(-2, Y1 + 3, 0, pom); set(1, Y1 + 3, 1, pom); set(0, Y1 + 5, 0, pom); set(-1, Y1 + 3, 2, pom); set(0, Y1 + 3, -1, pom);
      } else if (kind === "bandana") {
        const dotC = mix(col, 0xffffff, 0.8);
        clearHair(ctx, (x, y) => y > Y1 + 1);
        for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) set(x, Y1 + 1, z, hash3(x, 0, z, 7) > 0.85 ? dotC : col);
        for (let y = Y1 - 2; y <= Y1; y++) for (let x = X0 - 1; x <= X1 + 1; x++) for (let z = Z0 - 1; z <= Z1 + 1; z++) {
          const ringCell = x === X0 - 1 || x === X1 + 1 || z === Z0 - 1 || z === Z1 + 1;
          if (!ringCell) continue;
          if (z === Z1 + 1 && y === Y1 - 2) continue;
          set(x, y, z, hash3(x, y, z, 7) > 0.85 ? dotC : col);
        }
        block(-1, 0, Y1 - 2, Y1 - 1, Z0 - 2, Z0 - 2, shade(col, 0.85), MAT_SOLID, false);
        set(-1, Y1 - 3, Z0 - 2, col); set(-2, Y1 - 4, Z0 - 2, col); set(0, Y1 - 3, Z0 - 3, col); set(1, Y1 - 4, Z0 - 3, col);
      }
      break;
    }
    case "flower_wreath": {
      const petals = [orDefault(c, 0xf28aa0), 0xffffff, 0xffd84a, orDefault(c, 0xf28aa0), 0xb58cf0];
      let i = 0;
      const y = Math.min(A.hairTop, Y1 + 1);
      for (let x = X0 - 1; x <= X1 + 1; x++) for (let z = Z0 - 1; z <= Z1 + 1; z++) {
        const ringCell = x === X0 - 1 || x === X1 + 1 || z === Z0 - 1 || z === Z1 + 1;
        if (!ringCell) continue;
        set(x, y, z, (x + z) % 2 ? K.leaf : K.leafDark, MAT_SOLID, 0.08);
        if ((x * 7 + z * 3) % 3 === 0) {
          const pc = petals[i++ % petals.length];
          const ox = x === X0 - 1 ? -0.3 : x === X1 + 1 ? 0.3 : 0, oz = z === Z0 - 1 ? -0.3 : z === Z1 + 1 ? 0.3 : 0;
          v.det(x + ox - 0.1, y + 0.6, z + oz - 0.1, x + ox + 1.1, y + 1.5, z + oz + 1.1, pc);
          v.det(x + ox + 0.3, y + 1.4, z + oz + 0.3, x + ox + 0.7, y + 1.6, z + oz + 0.7, 0xffc93a);
        }
      }
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------------------------

function buildAccessory(ctx) {
  const { a, pal, A, D } = ctx;
  const kind = a.accessory;
  if (kind === "none" || !D) return;
  const head = ctx.parts.head ? ctx.parts.head.vox : null;
  const body = ctx.parts.body.vox;
  const c = pal.acc;
  const FZ = A ? A.faceZ : 0;
  const quad = ctx.kind === "quad";
  const { hy, bx0, bx1, bz0, bz1, legH } = D;
  switch (kind) {
    case "glasses": case "round_glasses": case "monocle": case "eyepatch": {
      if (!A || !head || quad && kind !== "monocle") break;
      const frame = luma(c) < 0.45 ? c : mix(c, 0x1a1414, 0.35);
      const ey = A.eyeY, z0 = FZ + 0.18, z1 = FZ + 0.48;
      const eyes = A.owl ? [[-2.5 - 1.1, 2.2], [2.5 - 1.1, 2.2]] : [[A.eyeXR, 2], [A.eyeXL, 2]];
      const ring = (cx, cy, r, col) => {
        const n = 18;
        for (let i = 0; i < n; i++) {
          const t = (i / n) * Math.PI * 2;
          const x = cx + Math.cos(t) * r, y = cy + Math.sin(t) * r;
          head.det(x - 0.26, y - 0.26, z0, x + 0.26, y + 0.26, z1, col, MAT_METAL);
        }
      };
      if (kind === "glasses") {
        for (const [ex, w] of eyes) {
          const eyY = A.owl ? ey - 0.2 : ey;
          const x0 = ex - 0.5, x1 = ex + w + 0.5, y0 = eyY - 0.5, y1 = eyY + 2.5;
          head.det(x0, y1 - 0.36, z0, x1, y1, z1, frame);
          head.det(x0, y0, z0, x1, y0 + 0.32, z1, frame);
          head.det(x0, y0, z0, x0 + 0.34, y1, z1, frame);
          head.det(x1 - 0.34, y0, z0, x1, y1, z1, frame);
          head.det(ex - 0.2, eyY - 0.2, z0 + 0.05, ex + w + 0.2, eyY + 2.2, z0 + 0.1, 0xdff4ff, MAT_GLASS);
        }
        head.det(eyes[0][0] + eyes[0][1] + 0.5, ey + 1.6, z0, eyes[1][0] - 0.5, ey + 1.95, z1, frame);
        head.det(A.X0 - 0.35, ey + 1.6, A.Z1 - 2.5, A.X0 + 0.05, ey + 1.95, FZ + 0.48, frame);
        head.det(A.X1 + 0.95, ey + 1.6, A.Z1 - 2.5, A.X1 + 1.35, ey + 1.95, FZ + 0.48, frame);
        head.det(A.X0 - 0.35, ey + 1.6, FZ + 0.18, eyes[0][0] - 0.5, ey + 1.95, FZ + 0.48, frame);
        head.det(eyes[1][0] + eyes[1][1] + 0.5, ey + 1.6, FZ + 0.18, A.X1 + 1.35, ey + 1.95, FZ + 0.48, frame);
      } else if (kind === "round_glasses") {
        const r = A.owl ? 2.2 : 1.62;
        for (const [ex, w] of eyes) {
          ring(ex + w / 2, ey + (A.owl ? 1.0 : 1), r, frame);
          head.det(ex + w / 2 - r * 0.8, ey + 1 - r * 0.8, z0 + 0.05, ex + w / 2 + r * 0.8, ey + 1 + r * 0.8, z0 + 0.1, 0xdff4ff, MAT_GLASS);
        }
        const xr = eyes[0][0] + eyes[0][1] / 2 + r, xl = eyes[1][0] + eyes[1][1] / 2 - r;
        head.det(xr - 0.1, ey + 1.3, z0, xl + 0.1, ey + 1.62, z1, frame, MAT_METAL);
        head.det(A.X0 - 0.35, ey + 1.0, FZ + 0.18, eyes[0][0] + eyes[0][1] / 2 - r, ey + 1.32, FZ + 0.48, frame, MAT_METAL);
        head.det(eyes[1][0] + eyes[1][1] / 2 + r, ey + 1.0, FZ + 0.18, A.X1 + 1.35, ey + 1.32, FZ + 0.48, frame, MAT_METAL);
      } else if (kind === "monocle") {
        const gold = orDefault(c, K.gold);
        const [ex, w] = eyes[1];
        ring(ex + w / 2, ey + 1, A.owl ? 2.2 : 1.62, gold);
        head.det(ex + w / 2 - 1.1, ey - 0.1, z0 + 0.05, ex + w / 2 + 1.1, ey + 2.1, z0 + 0.1, 0xdff4ff, MAT_GLASS);
        for (let i = 0; i < 7; i++) head.det(ex + w / 2 + 1.4 + i * 0.12, ey - 0.6 - i * 0.62, FZ + 0.2, ex + w / 2 + 1.65 + i * 0.12, ey - 0.25 - i * 0.62, FZ + 0.42, gold, MAT_METAL);
      } else {
        const [ex, w] = eyes[0];
        const patch = 0x1b1716;
        head.det(ex - 0.4, ey - 0.45, FZ + 0.14, ex + w + 0.4, ey + 2.35, FZ + 0.42, patch);
        for (let i = 0; i < 9; i++) {
          const x = ex + w + 0.2 + i * 0.62, y = ey + 2.1 + i * 0.5;
          if (x > A.X1 + 0.9) break;
          head.det(x, y, FZ + 0.12, x + 0.62, y + 0.34, FZ + 0.3, patch);
        }
        head.det(A.X0 - 0.3, ey + 1.6, A.Z0, A.X0, ey + 1.95, FZ + 0.3, patch);
        head.det(A.X0, ey + 1.6, FZ + 0.12, ex - 0.4, ey + 1.95, FZ + 0.3, patch);
      }
      break;
    }
    case "scarf": {
      if (quad) {
        const hv = ctx.parts.head.vox;
        for (let y = legH + 5; y <= legH + 6; y++) for (let x = -3; x <= 2; x++) for (let z = 4; z <= 8; z++) {
          if (x > -3 && x < 2 && z > 4 && z < 8) continue;
          hv.set(x, y, z, (x + z) % 2 ? c : mix(c, 0xffffff, 0.55));
        }
        break;
      }
      const stripe = (y) => (mod(y, 2) ? c : mix(c, 0xffffff, 0.6));
      for (let y = hy - 2; y <= hy - 1; y++) for (let x = bx0; x <= bx1; x++) for (let z = bz0 - 1; z <= bz1 + 1; z++) {
        if (z > bz0 - 1 && z < bz1 + 1 && x > bx0 && x < bx1) continue;
        body.set(x, y, z, (x + z) % 3 === 0 ? shade(c, 0.88) : c);
      }
      for (let y = hy - 6; y <= hy - 3; y++) body.box(1, 2, y, y, bz1 + 1, bz1 + 1, stripe(y));
      body.box(-1, 0, hy - 4, hy - 3, bz1 + 1, bz1 + 1, c);
      for (const x of [1.1, 1.6, 2.1, 2.6]) body.det(x, hy - 6.6, bz1 + 1.2, x + 0.25, hy - 6, bz1 + 1.6, mix(c, 0xffffff, 0.3));
      break;
    }
    case "cape": {
      const lining = shade(c, 0.6);
      const y0 = quad ? legH + 6 : hy - 1;
      const yb = quad ? legH + 1 : 1;
      if (quad) {
        for (let y = yb; y <= y0; y++) for (let z = -5; z <= 3; z++) { body.set(-4, y, z, c); body.set(3, y, z, c); }
        for (let z = -5; z <= 3; z++) for (let x = -3; x <= 2; x++) body.set(x, y0 + 1, z, c);
        break;
      }
      for (let y = y0; y >= yb; y--) {
        const e = Math.floor((y0 - y) / 3);
        const zz = bz0 - 1 - (y < (y0 + yb) / 2 ? 1 : 0);
        for (let x = bx0 - D.armW - e; x <= bx1 + D.armW + e; x++) {
          const side = x === bx0 - D.armW - e || x === bx1 + D.armW + e;
          body.set(x, y, zz, side ? lining : c, MAT_SOLID, 0.05);
          if (y === yb && mod(x, 2) === 0) body.set(x, y, zz, shade(c, 0.85));
        }
        if (zz < bz0 - 1) for (let x = bx0 - D.armW - e + 1; x <= bx1 + D.armW + e - 1; x++) body.set(x, y, bz0 - 1, lining);
      }
      for (let x = bx0 - D.armW; x <= bx1 + D.armW; x++) for (let z = bz0 - 1; z <= bz0; z++) body.set(x, hy, z, c);
      const clasp = orDefault(pal.accent, K.gold);
      body.det(bx0 + 0.3, hy - 1.6, bz1 + 1, bx0 + 1.3, hy - 0.6, bz1 + 1.25, clasp === pal.accent ? K.gold : clasp, MAT_METAL);
      body.det(bx1 - 0.3, hy - 1.6, bz1 + 1, bx1 + 0.7, hy - 0.6, bz1 + 1.25, K.gold, MAT_METAL);
      body.det(bx0 + 1.3, hy - 1.25, bz1 + 1, bx1 - 0.3, hy - 0.95, bz1 + 1.15, K.gold, MAT_METAL);
      break;
    }
    case "backpack": {
      if (quad) break;
      const y0 = legH + 1, y1 = hy - 2;
      body.box(bx0 + 1, bx1 - 1, y0, y1, bz0 - 3, bz0 - 1, c, MAT_SOLID, 0.05);
      body.box(bx0 + 1, bx1 - 1, y1 - 1, y1 + 1, bz0 - 4, bz0 - 3, shade(c, 0.8));
      body.box(bx0 + 2, bx1 - 2, y0 + 1, y0 + 2, bz0 - 4, bz0 - 4, mix(c, 0xffffff, 0.15));
      body.det(-0.4, y1 - 2.2, bz0 - 4.2, 0.4, y1 - 1.0, bz0 - 3.9, K.gold, MAT_METAL);
      for (const x of [bx0 + 1, bx1 - 1]) {
        body.det(x + 0.15, legH + 2, bz1 + 1, x + 0.85, hy, bz1 + 1.2, shade(c, 0.75));
        body.det(x + 0.15, hy, bz0 - 1, x + 0.85, hy + 0.25, bz1 + 1.2, shade(c, 0.75));
      }
      break;
    }
    case "necklace": {
      if (quad) break;
      const gem = orDefault(c, 0x3fa7d6);
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const x = bx0 + 1.2 + (bx1 - bx0 - 1.4) * t;
        const y = hy - 0.6 - Math.sin(t * Math.PI) * 2.0;
        body.det(x - 0.2, y - 0.2, bz1 + 1, x + 0.2, y + 0.2, bz1 + 1.18, K.gold, MAT_METAL);
      }
      body.det(-0.6, hy - 3.8, bz1 + 1, 0.6, hy - 2.5, bz1 + 1.3, gem, MAT_METAL);
      break;
    }
    case "wings": {
      if (ctx.parts.wingL) break;
      const dark = luma(c) < 0.18, light = luma(c) > 0.65;
      const col = dark ? mix(c, 0x3a2a4a, 0.4) : c;
      buildWings(ctx, dark ? "bat" : light ? "fairy" : "feather", col, dark ? mix(col, 0x7a5a8a, 0.35) : light ? mix(col, 0xffffff, 0.3) : col);
      break;
    }
    case "tie": {
      if (quad || D.bird) break;
      const col = orDefault(c, 0xb8343e);
      body.det(-0.6, hy - 1.6, bz1 + 1, 0.6, hy - 0.6, bz1 + 1.45, shade(col, 0.88));
      body.det(-0.45, hy - 4.6, bz1 + 1, 0.45, hy - 1.6, bz1 + 1.3, col);
      body.det(-0.7, hy - 5.5, bz1 + 1, 0.7, hy - 4.6, bz1 + 1.3, col);
      body.det(-0.3, hy - 5.9, bz1 + 1, 0.3, hy - 5.5, bz1 + 1.3, col);
      break;
    }
    case "bowtie": {
      const col = orDefault(c, 0xb8343e);
      const yb = quad ? legH + 5 : hy - 1.3;
      const zb = quad ? 9 : bz1 + 1;
      const tgt = quad ? ctx.parts.head.vox : body;
      tgt.det(-0.45, yb - 0.4, zb, 0.45, yb + 0.4, zb + 0.5, shade(col, 0.85));
      tgt.det(-1.7, yb - 0.75, zb, -0.45, yb + 0.75, zb + 0.4, col);
      tgt.det(0.45, yb - 0.75, zb, 1.7, yb + 0.75, zb + 0.4, col);
      break;
    }
    case "belt_sword": {
      if (quad || D.bird) break;
      for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) if (x === bx0 || x === bx1 || z === bz0 || z === bz1) body.set(x, legH, z, 0x4a3426);
      body.det(-0.8, legH + 0.1, bz1 + 1, 0.8, legH + 0.9, bz1 + 1.25, K.gold, MAT_METAL);
      const sv = addPart(ctx, "sheath", "body", [bx1 + 1.45, legH + 0.5, 0.5], [0.95, 0, 0.08], true);
      sv.det(-0.45, -7.5, -0.45, 0.45, 0, 0.45, orDefault(c, 0x3a2a22));
      sv.det(-0.5, -7.9, -0.5, 0.5, -7.3, 0.5, K.gold, MAT_METAL);
      sv.det(-1.5, 0, -0.45, 1.5, 0.5, 0.45, K.gold, MAT_METAL);
      sv.det(-0.3, 0.5, -0.3, 0.3, 2.4, 0.3, K.leather);
      sv.det(-0.45, 2.4, -0.45, 0.45, 2.9, 0.45, K.gold, MAT_METAL);
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Held items (right hand). Modelled locally: grip at origin, item axis +y, forward +z.
// ---------------------------------------------------------------------------------------------

function buildHeld(ctx) {
  const { a, pal, A } = ctx;
  const item = a.holding;
  if (item === "none") return;
  if (item === "pipe") {
    if (!A || !ctx.parts.head) return;
    const v = ctx.parts.head.vox;
    const my = A.mouthY, mz = A.mouthZ;
    v.det(0.6, my - 0.35, mz - 0.1, 1.0, my + 0.05, mz + 1.6, 0x3a2418);
    v.det(0.85, my - 1.7, mz + 1.2, 2.05, my + 0.25, mz + 2.4, 0x7a4a2a);
    v.det(1.05, my - 0.05, mz + 1.4, 1.85, my + 0.3, mz + 2.2, 0x2a1a12);
    v.det(1.2, my + 0.25, mz + 1.55, 1.7, my + 0.4, mz + 2.05, 0xff7a2a, MAT_GLOW);
    return;
  }
  if (!ctx.hand) return;
  const v = addPart(ctx, "held", "armR", ctx.hand.slice(), [0, 0, 0], true);
  const H = (x0, y0, z0, x1, y1, z1, c, mat = MAT_SOLID, amp = 0) => v.det(x0, y0, z0, x1, y1, z1, c, mat, amp);
  const itemC = (fb) => (a.accessory === "none" && luma(pal.acc) > 0.16 ? pal.acc : fb);
  const handY = ctx.hand[1];
  const shoulderY = ctx.parts.armR ? ctx.parts.armR.pivot[1] : handY + 4;
  const L = shoulderY - handY; // shoulder → grip distance
  /** World height of the grip when the arm is rotated forward by `ax` and sideways by `az`. */
  const gripY = (ax, az) => shoulderY - L * Math.cos(az) * Math.cos(ax);
  let rx = 0.45, ry = 0, rz = 0, arm = 0.35, armZ = 0;
  switch (item) {
    case "wand":
      H(-0.3, -1.6, -0.3, 0.3, 1.4, 0.3, 0x6b4428);
      H(-0.22, 1.4, -0.22, 0.22, 6.2, 0.22, 0x3d2616);
      H(-0.34, 6.2, -0.34, 0.34, 6.9, 0.34, 0xfff1b8, MAT_GLOW);
      H(-0.12, 7.25, -0.12, 0.12, 7.55, 0.12, 0xfff6c8, MAT_GLOW);
      H(0.55, 6.4, -0.1, 0.8, 6.65, 0.15, 0xfff6c8, MAT_GLOW);
      rx = 0.85; rz = 0.15; break;
    case "sword":
      H(-0.45, -1.4, -0.45, 0.45, 1.2, 0.45, K.leather);
      H(-0.6, -2.0, -0.6, 0.6, -1.4, 0.6, K.gold, MAT_METAL);
      H(-2.0, 1.2, -0.55, 2.0, 1.9, 0.55, K.gold, MAT_METAL);
      H(-0.6, 1.9, -0.2, 0.6, 10.2, 0.2, K.steel, MAT_METAL);
      H(-0.15, 2.2, -0.25, 0.15, 9.8, 0.25, mix(K.steel, 0x8090a0, 0.4), MAT_METAL);
      H(-0.35, 10.2, -0.18, 0.35, 10.9, 0.18, K.steel, MAT_METAL);
      rx = 0.5; rz = 0.55; break;
    case "rapier": {
      H(-0.3, -1.4, -0.3, 0.3, 1.0, 0.3, K.leather);
      H(-0.5, -1.9, -0.5, 0.5, -1.4, 0.5, K.gold, MAT_METAL);
      for (let i = 0; i < 10; i++) { const t = (i / 10) * Math.PI * 2; H(Math.cos(t) * 1.3 - 0.2, 1.0, Math.sin(t) * 1.3 - 0.2, Math.cos(t) * 1.3 + 0.2, 1.4, Math.sin(t) * 1.3 + 0.2, K.gold, MAT_METAL); }
      H(-0.9, 1.0, 1.0, 0.9, 1.4, 1.4, K.gold, MAT_METAL);
      H(-0.17, 1.4, -0.17, 0.17, 12.5, 0.17, K.steel, MAT_METAL);
      rx = 0.55; rz = 0.45; break;
    }
    case "book": {
      const cov = itemC(0x9b2f36);
      H(-0.75, -2.6, -1.9, 0.75, 2.6, 1.9, cov, MAT_SOLID, 0.04);
      H(-0.55, -2.4, -1.5, 0.55, 2.4, 2.0, K.paper);
      H(-0.8, -2.65, -2.0, 0.8, 2.65, -1.6, shade(cov, 0.75));
      H(-0.82, 0.6, -1.0, -0.74, 1.6, 1.4, K.gold);
      H(-0.82, -1.4, -0.4, -0.74, -1.1, 0.8, K.gold);
      rx = 0.1; ry = -0.2; arm = 0.3; break;
    }
    case "lantern": {
      const frame = 0x2e2a26;
      H(-0.15, -1.0, -0.15, 0.15, 0.6, 0.15, frame);
      H(-0.9, -1.2, -0.25, 0.9, -0.9, 0.25, frame);
      H(-1.3, -1.7, -1.3, 1.3, -1.2, 1.3, frame);
      H(-1.1, -4.6, -1.1, 1.1, -1.7, 1.1, 0xffd77a, MAT_GLOW);
      for (const [x, z] of [[-1.3, -1.3], [1.0, -1.3], [-1.3, 1.0], [1.0, 1.0]]) H(x, -4.9, z, x + 0.3, -1.6, z + 0.3, frame);
      H(-1.4, -5.3, -1.4, 1.4, -4.7, 1.4, frame);
      rx = 0; arm = 0.42; break;
    }
    case "candle": {
      H(-1.6, -0.2, -1.6, 1.6, 0.25, 1.6, K.brass, MAT_METAL);
      H(-1.75, -0.05, -1.75, 1.75, 0.4, -1.3, K.brass, MAT_METAL);
      H(-0.6, -1.0, -0.6, 0.6, -0.2, 0.6, K.brass, MAT_METAL);
      H(-0.7, 0.25, -0.7, 0.7, 4.2, 0.7, K.cream);
      H(0.4, 2.9, 0.5, 0.78, 4.2, 0.78, 0xfffaf0);
      H(-0.78, 3.4, -0.3, -0.4, 4.2, 0.3, 0xfffaf0);
      H(-0.09, 4.2, -0.09, 0.09, 4.5, 0.09, 0x2a1d1a);
      H(-0.42, 4.45, -0.42, 0.42, 5.9, 0.42, 0xffb43c, MAT_GLOW);
      H(-0.22, 4.55, -0.22, 0.22, 5.3, 0.22, 0xfff3c4, MAT_GLOW);
      rx = 0; arm = 0.6; break;
    }
    case "rose": case "flower": {
      H(-0.18, -1.2, -0.18, 0.18, 5.0, 0.18, K.leafDark);
      H(0.1, 2.0, -0.2, 1.2, 2.5, 0.2, K.leaf);
      H(-1.1, 3.2, -0.2, -0.1, 3.7, 0.2, K.leaf);
      if (item === "rose") {
        const r = itemC(0xd2343a);
        H(-1.0, 5.0, -1.0, 1.0, 6.8, 1.0, r, MAT_SOLID, 0.05);
        H(-0.6, 6.4, -0.6, 0.6, 7.1, 0.6, shade(r, 0.82));
        H(-1.15, 5.0, -0.5, 1.15, 5.9, 0.5, shade(r, 0.9));
      } else {
        const p = itemC(0xffffff);
        for (const [dx, dy] of [[0, 1.05], [0, -1.05], [1.05, 0], [-1.05, 0], [0.75, 0.75], [-0.75, 0.75], [0.75, -0.75], [-0.75, -0.75]])
          H(dx - 0.5, 6.0 + dy - 0.5, -0.2, dx + 0.5, 6.0 + dy + 0.5, 0.2, p);
        H(-0.6, 5.4, -0.35, 0.6, 6.6, 0.35, 0xffc93a);
      }
      rx = 0.3; break;
    }
    case "staff": case "spear": {
      // held out to the side so the shaft clears the big head and hair, planted on the ground
      arm = 0.2; armZ = -0.55;
      const gy = gripY(arm, armZ) + ctx.float;
      const groundY = -gy + 0.2;
      const topY = (A ? A.hairTop + 3 : gy + 14) - gy;
      const wood = item === "staff" ? 0x7a4f2c : 0x8a6038;
      H(-0.38, groundY, -0.38, 0.38, topY, 0.38, wood, MAT_SOLID, 0.05);
      for (let y = groundY + 2; y < topY - 1; y += 3.3) H(-0.45, y, -0.45, 0.45, y + 0.4, 0.45, shade(wood, 0.78));
      if (item === "staff") {
        const orb = itemC(0x7fd8ff);
        H(-0.9, topY - 0.3, -0.9, 0.9, topY + 0.3, 0.9, shade(wood, 0.8));
        for (const [x, z] of [[-0.9, -0.2], [0.5, -0.2], [-0.2, -0.9], [-0.2, 0.5]]) H(x, topY, z, x + 0.4, topY + 2.0, z + 0.4, shade(wood, 0.8));
        H(-0.75, topY + 0.6, -0.75, 0.75, topY + 2.1, 0.75, orb, MAT_GLOW);
      } else {
        H(-0.5, topY, -0.5, 0.5, topY + 0.5, 0.5, K.steelDark, MAT_METAL);
        H(-0.7, topY + 0.5, -0.25, 0.7, topY + 2.4, 0.25, K.steel, MAT_METAL);
        H(-0.4, topY + 2.4, -0.2, 0.4, topY + 3.2, 0.2, K.steel, MAT_METAL);
        H(-0.15, topY + 3.2, -0.15, 0.15, topY + 3.7, 0.15, K.steel, MAT_METAL);
        H(-0.5, topY - 1.6, -0.5, 0.5, topY - 0.2, 0.5, 0xc8363f);
      }
      rx = 0; break;
    }
    case "shield": {
      const field = pal.top, emblem = cdist(pal.accent, pal.top) > 60 ? pal.accent : mix(pal.top, 0xffffff, 0.6);
      const rim = K.steelDark;
      for (let y = -3; y <= 3; y++) {
        const w = y < -1 ? 2.6 + (y + 1) * 0.9 : 2.6;
        H(-w - 0.4, y - 0.5, 1.4, w + 0.4, y + 0.5, 1.9, rim, MAT_METAL);
        H(-w, y - 0.5, 1.9, w, y + 0.5, 2.25, field, MAT_SOLID, 0.03);
      }
      H(-0.45, -3.0, 2.25, 0.45, 3.2, 2.4, emblem);
      H(-2.2, 0.6, 2.25, 2.2, 1.5, 2.4, emblem);
      H(-0.6, -0.5, 0.8, 0.6, 0.5, 1.4, K.leather);
      rx = 0; ry = -0.3; arm = 0.25; break;
    }
    case "bow_weapon": {
      const wood = 0x8a5a2b;
      for (let i = -8; i <= 8; i++) {
        const z = 2.8 * (1 - (i / 8.5) ** 2);
        H(-0.32, i - 0.55, z - 0.4, 0.32, i + 0.55, z + 0.4, Math.abs(i) <= 1 ? K.leather : wood, MAT_SOLID, 0.04);
      }
      H(-0.1, -8.2, -0.05, 0.1, 8.2, 0.2, 0xf2efe6);
      rx = 0; ry = -1.5; arm = 0.3; break;
    }
    case "umbrella": {
      // Held up high (Mary Poppins pose): the arm is raised, the canopy floats above the head.
      const can = itemC(0xc8363f);
      armZ = -2.6;
      const t = Math.max(4, (A ? A.top : handY + 12) + 3.5 - gripY(0.1, armZ));
      H(-0.2, -1.2, -0.2, 0.2, t + 2.2, 0.2, 0x3a3a40);
      H(-0.3, -2.4, -0.3, 0.3, -1.2, 0.3, K.leather);
      H(-0.3, -2.4, 0.3, 0.3, -1.9, 1.3, K.leather);
      for (let k = 0; k < 4; k++) {
        const r = 7.4 - k * 1.9, y = t - 1 + k;
        for (let i = -7; i <= 7; i++) for (let j = -7; j <= 7; j++) {
          if (i * i + j * j > r * r) continue;
          const sector = Math.floor(((Math.atan2(j, i) + Math.PI) / (Math.PI * 2)) * 8);
          H(i - 0.5, y, j - 0.5, i + 0.5, y + 1, j + 0.5, sector % 2 ? can : mix(can, 0xfff8ee, luma(can) < 0.25 ? 0.25 : 0.8), MAT_SOLID, 0.03);
        }
      }
      H(-0.25, t + 3, -0.25, 0.25, t + 3.8, 0.25, K.gold, MAT_METAL);
      rx = 0.32; arm = 0.1; rz = -0.12; break; // tilted a little towards the viewer so the dome reads
    }
    case "cup": {
      H(-0.9, 0.0, -0.9, 0.9, 1.8, 0.9, 0xfaf7f0);
      H(-0.92, 1.2, -0.92, 0.92, 1.5, 0.92, itemC(0x3a7bd5));
      H(-0.7, 1.75, -0.7, 0.7, 1.82, 0.7, 0x8a5a33);
      H(0.9, 0.4, -0.2, 1.5, 1.4, 0.2, 0xfaf7f0);
      H(-1.5, -0.25, -1.5, 1.5, 0.0, 1.5, 0xfaf7f0);
      rx = 0; arm = 0.75; break;
    }
    case "key": {
      const g = itemC(K.gold);
      H(-0.25, -0.6, -0.25, 0.25, 5.2, 0.25, g, MAT_METAL);
      H(-1.2, -2.6, -0.3, 1.2, -2.2, 0.3, g, MAT_METAL);
      H(-1.2, -0.9, -0.3, 1.2, -0.5, 0.3, g, MAT_METAL);
      H(-1.2, -2.6, -0.3, -0.8, -0.5, 0.3, g, MAT_METAL);
      H(0.8, -2.6, -0.3, 1.2, -0.5, 0.3, g, MAT_METAL);
      H(0.25, 4.0, -0.25, 1.4, 4.4, 0.25, g, MAT_METAL);
      H(0.25, 4.8, -0.25, 1.1, 5.2, 0.25, g, MAT_METAL);
      rx = 0.6; break;
    }
    case "letter": {
      H(-2.0, -0.2, -0.12, 2.0, 2.6, 0.12, 0xfbf6ea);
      for (let i = 0; i < 6; i++) H(-2.0 + i * 0.36, 2.25 - i * 0.22, 0.12, -1.6 + i * 0.36, 2.55 - i * 0.22, 0.18, 0xd9cfba);
      for (let i = 0; i < 6; i++) H(1.6 - i * 0.36, 2.25 - i * 0.22, 0.12, 2.0 - i * 0.36, 2.55 - i * 0.22, 0.18, 0xd9cfba);
      H(-0.45, 0.65, 0.12, 0.45, 1.5, 0.3, 0xc8303a);
      rx = 0.15; ry = -0.5; arm = 0.6; break;
    }
    case "map": {
      H(-2.6, -0.1, -0.15, 2.6, 3.6, 0.1, 0xf1e2bb, MAT_SOLID, 0.03);
      H(-2.8, -0.4, -0.4, 2.8, 0.2, 0.3, 0xe2cfa0);
      H(-2.8, 3.4, -0.4, 2.8, 4.0, 0.3, 0xe2cfa0);
      for (let i = 0; i < 5; i++) H(-2.0 + i * 0.7, 1.0 + (i % 2) * 0.6, 0.1, -1.6 + i * 0.7, 1.3 + (i % 2) * 0.6, 0.18, 0x8a5a33);
      H(1.4, 1.8, 0.1, 2.0, 2.4, 0.2, 0xd2343a);
      H(-1.8, 2.3, 0.1, -1.2, 3.0, 0.2, 0x4f9a3f);
      rx = 0.15; ry = -0.5; arm = 0.6; break;
    }
    case "basket": {
      const wick = 0xc28e52;
      for (let x = -2; x <= 2; x++) for (let y = 0; y < 3; y++) {
        const c = mod(x + y, 2) ? wick : shade(wick, 0.82);
        H(x - 0.5, -5.0 + y, -1.7, x + 0.5, -4.0 + y, 1.7, c);
      }
      H(-2.6, -2.2, -1.9, 2.6, -1.8, 1.9, shade(wick, 0.75));
      for (let i = -3; i <= 3; i++) H(i * 0.6 - 0.25, -1.9 + Math.cos((i / 3.4) * Math.PI / 2) * 1.9, -0.2, i * 0.6 + 0.25, -1.5 + Math.cos((i / 3.4) * Math.PI / 2) * 1.9, 0.2, shade(wick, 0.8));
      H(-1.8, -2.0, -1.2, 0.0, -1.3, 1.2, 0xd2343a);
      H(0.2, -2.1, -1.0, 1.6, -1.2, 0.4, 0xd83c2f);
      H(-0.6, -1.5, 0.0, 0.8, -1.1, 1.3, 0xf3eee4);
      rx = 0; arm = 0.35; break;
    }
    case "microphone":
      H(-0.4, -1.6, -0.4, 0.4, 3.0, 0.4, 0x2a2a30);
      H(-0.5, 2.6, -0.5, 0.5, 3.0, 0.5, 0x8a8f99, MAT_METAL);
      H(-0.85, 3.0, -0.85, 0.85, 4.6, 0.85, 0xb9bfc8, MAT_METAL);
      for (let y = 3.2; y < 4.6; y += 0.45) H(-0.9, y, -0.9, 0.9, y + 0.1, 0.9, 0x5a5f69, MAT_METAL);
      rx = 0.65; arm = 0.7; break;
    case "pistol": {
      H(-0.4, -1.6, -0.6, 0.4, 0.6, 0.6, 0x6b4428);
      H(-0.45, 0.4, -0.9, 0.45, 1.2, 1.2, 0x6b4428);
      H(-0.32, 0.55, 1.2, 0.32, 1.15, 5.6, K.steelDark, MAT_METAL);
      H(-0.42, 0.45, 5.4, 0.42, 1.25, 5.8, K.gold, MAT_METAL);
      H(-0.2, 1.2, -0.2, 0.2, 1.7, 0.3, K.steelDark, MAT_METAL);
      H(-0.15, -0.2, 0.6, 0.15, 0.4, 1.6, K.gold, MAT_METAL);
      rx = 0; arm = 0.75; break;
    }
    case "telescope":
      H(-0.95, -1.2, -0.95, 0.95, 3.2, 0.95, K.brass, MAT_METAL);
      H(-0.75, 3.2, -0.75, 0.75, 5.6, 0.75, mix(K.brass, 0xffffff, 0.15), MAT_METAL);
      H(-0.55, 5.6, -0.55, 0.55, 7.6, 0.55, K.brass, MAT_METAL);
      H(-1.05, 2.9, -1.05, 1.05, 3.3, 1.05, 0x5a3a20);
      H(-0.85, 5.3, -0.85, 0.85, 5.7, 0.85, 0x5a3a20);
      H(-1.05, -1.4, -1.05, 1.05, -1.1, 1.05, 0x5a3a20);
      rx = 1.05; arm = 0.5; break;
    case "magnifier": {
      H(-0.35, -1.6, -0.35, 0.35, 2.2, 0.35, 0x5a3a20);
      H(-0.5, 2.0, -0.5, 0.5, 2.6, 0.5, K.gold, MAT_METAL);
      const cy = 4.3;
      for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; H(Math.cos(t) * 1.7 - 0.32, cy + Math.sin(t) * 1.7 - 0.32, -0.3, Math.cos(t) * 1.7 + 0.32, cy + Math.sin(t) * 1.7 + 0.32, 0.3, K.gold, MAT_METAL); }
      H(-1.45, cy - 1.45, -0.08, 1.45, cy + 1.45, 0.08, 0xcff0ff, MAT_GLASS);
      rx = 0.35; ry = -0.6; arm = 0.6; break;
    }
    default: break;
  }
  if (a.age === "child" && item !== "umbrella" && item !== "staff" && item !== "spear") ctx.parts.held.scale = 0.8;
  // The item is a child of the arm: local rotation = (arm rest)^-1 · (desired world rotation).
  const armR = ctx.parts.armR;
  const armRest = [-arm, 0, armZ || (armR ? armR.rest[2] - 0.04 : 0)];
  const qArm = new THREE.Quaternion().setFromEuler(new THREE.Euler(armRest[0], armRest[1], armRest[2]));
  const qWorld = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const e = new THREE.Euler().setFromQuaternion(qArm.invert().multiply(qWorld));
  ctx.parts.held.rest = [e.x, e.y, e.z];
  if (armR) armR.rest = armRest;
}

// =================================================================================================
// Assembly: design → THREE.Group
// =================================================================================================

const PART_KEYS = ["head", "body", "armL", "armR", "legL", "legR", "held", "eyes", "mouth", "mouthOpen", "tail", "wingL", "wingR", "sheath"];

/**
 * Build a voxel character. Feet at y=0, facing +z, ~1 unit per voxel.
 * opts: { castShadow = true, receiveShadow = true }
 */
export function buildCharacter(appearance, opts = {}) {
  const ctx = design(appearance);
  return assemble(ctx, opts);
}

function assemble(ctx, opts = {}) {
  const cast = opts.castShadow !== false, receive = opts.receiveShadow !== false;
  const mats = materials();
  const occ = new Set();
  for (const p of Object.values(ctx.parts)) {
    if (p.local) continue;
    for (const [k, v] of p.vox.m) if (!TRANSPARENT[Math.floor(v / MSHIFT)]) occ.add(k);
  }
  const root = new THREE.Group();
  root.name = "voxel-character";
  const rig = new THREE.Group();
  rig.name = "rig";
  rig.position.y = ctx.float;
  root.add(rig);
  const groups = { rig };
  const pivots = { rig: [0, 0, 0] };
  const pending = Object.values(ctx.parts);
  let guard = 0;
  while (pending.length && guard++ < 50) {
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const parentName = groups[p.parent] ? p.parent : (ctx.parts[p.parent] ? null : "rig");
      if (!parentName) continue;
      const g = new THREE.Group();
      g.name = p.name;
      const pp = pivots[parentName];
      g.position.set(p.pivot[0] - pp[0], p.pivot[1] - pp[1], p.pivot[2] - pp[2]);
      g.rotation.set(p.rest[0], p.rest[1], p.rest[2]);
      if (p.scale) g.scale.setScalar(p.scale);
      const geos = meshVox(p.vox, p.local ? [0, 0, 0] : p.pivot, p.local ? new Set() : occ);
      for (const [mat, geo] of geos) {
        const mesh = new THREE.Mesh(geo, mats[mat]);
        mesh.castShadow = cast && mat !== MAT_GLASS && mat !== MAT_GLOW;
        mesh.receiveShadow = receive && mat !== MAT_GLOW;
        g.add(mesh);
      }
      if (p.hidden) g.visible = false;
      g.userData.rest = { p: g.position.clone(), r: g.rotation.clone(), s: g.scale.clone() };
      groups[parentName].add(g);
      groups[p.name] = g;
      pivots[p.name] = p.pivot;
      pending.splice(i--, 1);
    }
  }
  rig.userData.rest = { p: rig.position.clone(), r: rig.rotation.clone(), s: rig.scale.clone() };
  const parts = { rig };
  for (const k of PART_KEYS) if (groups[k]) parts[k] = groups[k];
  root.userData.parts = parts;
  root.userData.kind = ctx.kind;
  root.userData.appearance = ctx.a;
  root.userData.holding = ctx.a.holding;
  root.userData.phase = (ctx.seed % 1000) / 137;
  root.userData.voxel = true;
  root.userData.footprint = footprint(ctx);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.userData.height = box.max.y;
  root.userData.bounds = box;
  return root;
}

/** Half-extent of what stands on the ground (body + legs; whole figure for quadrupeds). */
function footprint(ctx) {
  let ext = 4;
  const names = ctx.kind === "quad" ? Object.keys(ctx.parts) : ["body", "legL", "legR"];
  for (const n of names) {
    const p = ctx.parts[n];
    if (!p || p.local) continue;
    for (const k of p.vox.m.keys()) ext = Math.max(ext, Math.abs(kx(k) + 0.5), Math.abs(kz(k)));
  }
  return ext;
}

/** Free the GPU geometry of a character built by buildCharacter (materials are shared and kept). */
export function disposeCharacter(group) {
  if (!group) return;
  group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  if (group.parent) group.parent.remove(group);
}

// =================================================================================================
// Animation
// =================================================================================================

function blink(t) {
  const p = mod(t, 4.1);
  if (p > 3.95) return 0.12;
  if (p > 3.88) return 0.5;
  return 1;
}

const ACTION_MAP = { travel: "walk", chase: "chase", discover: "discover", rest: "rest" };

/** Pose `group` for action at time `t` (seconds). Unknown actions fall back to idle. */
export function animateCharacter(group, action, t = 0) {
  const ud = group && group.userData;
  const P = ud && ud.parts;
  if (!P) return;
  if (!Number.isFinite(t)) t = 0;
  for (const k in P) {
    const o = P[k];
    const r = o && o.userData && o.userData.rest;
    if (r) { o.position.copy(r.p); o.rotation.copy(r.r); o.scale.copy(r.s); }
  }
  if (P.mouthOpen) P.mouthOpen.visible = false;
  if (P.mouth) P.mouth.visible = true;
  const act = ACTIONS.includes(action) ? action : ACTION_MAP[action] || "idle";
  const kind = ud.kind;
  const quad = kind === "quad";
  const S = Math.sin, PI = Math.PI;
  const tt = t + (ud.phase || 0);
  const { body, head, armL, armR, legL, legR, rig, tail, wingL, wingR, eyes } = P;
  const holds = ud.holding && ud.holding !== "none" && ud.holding !== "pipe";
  const openMouth = (on) => { if (P.mouthOpen && P.mouth) { P.mouthOpen.visible = on; P.mouth.visible = !on; } };
  if (eyes) eyes.scale.y = blink(tt);
  if (tail) tail.rotation.y += 0.22 * S(tt * 3.1);
  if (wingL && wingR) { wingL.rotation.y += 0.07 * S(tt * 2); wingR.rotation.y -= 0.07 * S(tt * 2); }
  if (ud.appearance && ud.appearance.creature === "ghost") rig.position.y += 0.45 * S(tt * 1.6);
  const breathe = S(tt * 2.1);

  switch (act) {
    case "idle": {
      body.scale.y *= 1 + 0.012 * breathe;
      head.rotation.z += 0.035 * S(tt * 0.8);
      head.rotation.x += 0.025 * S(tt * 1.3 + 1);
      if (!quad) { armL.rotation.z += 0.025 + 0.02 * breathe; armR.rotation.z -= 0.025 + 0.02 * breathe; }
      break;
    }
    case "talk": {
      head.rotation.x += 0.06 * S(tt * 5.2);
      head.rotation.z += 0.04 * S(tt * 2.3);
      openMouth(S(tt * 11) > 0.15);
      if (!quad) {
        const g = 0.5 + 0.5 * S(tt * 2.4);
        armR.rotation.x += -0.25 - 0.35 * g; armR.rotation.z -= 0.15 * g;
        armL.rotation.x += -0.2 * (0.5 + 0.5 * S(tt * 2.4 + 2)); armL.rotation.z += 0.1;
        body.rotation.y += 0.06 * S(tt * 1.2);
      }
      break;
    }
    case "walk": case "chase": {
      const fast = act === "chase";
      const w = tt * PI * 2 * (fast ? 2.3 : 1.5);
      const amp = fast ? 0.75 : 0.5;
      if (quad) {
        armL.rotation.x += amp * S(w); armR.rotation.x -= amp * S(w);
        legL.rotation.x -= amp * S(w); legR.rotation.x += amp * S(w);
        head.rotation.x += 0.06 * S(w * 2);
      } else {
        legL.rotation.x += amp * S(w); legR.rotation.x -= amp * S(w);
        armL.rotation.x -= amp * 0.9 * S(w); armR.rotation.x += amp * 0.9 * S(w);
        body.rotation.y += 0.05 * S(w); head.rotation.y -= 0.04 * S(w);
        body.rotation.x += fast ? 0.14 : 0.03;
      }
      rig.position.y += (fast ? 0.6 : 0.35) * Math.abs(S(w));
      if (kind === "snake") { body.rotation.z += 0.08 * S(w * 0.5); head.rotation.y += 0.2 * S(w * 0.5); }
      if (fast) openMouth(true);
      break;
    }
    case "dance": {
      const w = tt * PI * 2 * 1.1;
      rig.position.y += 0.7 * Math.abs(S(w));
      body.rotation.z += 0.15 * S(w);
      head.rotation.z -= 0.13 * S(w);
      rig.rotation.y += 0.35 * S(w * 0.5);
      if (quad) { armL.rotation.x -= 0.6 * Math.max(0, S(w)); armR.rotation.x -= 0.6 * Math.max(0, -S(w)); }
      else {
        armL.rotation.z += 2.0 + 0.45 * S(w * 2); armR.rotation.z -= 2.0 + 0.45 * S(w * 2 + PI);
        legL.rotation.z += 0.16 * Math.max(0, S(w)); legR.rotation.z -= 0.16 * Math.max(0, -S(w));
      }
      openMouth(S(w * 0.5) > 0.6);
      break;
    }
    case "fight": {
      const w = tt * PI * 2 * 1.3;
      if (quad) {
        body.rotation.x -= 0.3 * (0.5 + 0.5 * S(w * 0.5));
        armL.rotation.x -= 0.8 + 0.4 * S(w * 2); armR.rotation.x -= 0.8 - 0.4 * S(w * 2);
        break;
      }
      legL.rotation.z += 0.13; legR.rotation.z -= 0.13;
      body.rotation.x += 0.1;
      body.rotation.y += 0.22 * S(w);
      if (holds && SWINGS.has(ud.holding)) {
        armR.rotation.x += -1.6 + 1.3 * (0.5 + 0.5 * S(w * 1.2));
        armL.rotation.x += -0.4;
      } else {
        armR.rotation.x += -1.45 * Math.max(0, S(w)) - 0.3;
        armL.rotation.x += -1.45 * Math.max(0, -S(w)) - 0.3;
      }
      rig.position.y += 0.2 * Math.abs(S(w * 2));
      break;
    }
    case "wave": {
      if (quad) { armR.rotation.x += -0.9 + 0.3 * S(tt * 8); head.rotation.z += 0.1; break; }
      const useL = holds;
      const arm = useL ? armL : armR, sg = useL ? 1 : -1;
      arm.rotation.z += sg * (2.1 + 0.3 * S(tt * PI * 2 * 1.6));
      arm.rotation.x += useL ? 0.6 : 0.35; // raised arm: +x brings the hand forward, clear of hair and head
      head.rotation.z += sg * 0.08;
      body.rotation.z -= sg * 0.03;
      openMouth(true);
      break;
    }
    case "sad": {
      head.rotation.x += 0.36 + 0.03 * S(tt * 0.9);
      head.rotation.z += 0.05 * S(tt * 0.7);
      body.rotation.x += 0.1;
      if (!quad) { armL.rotation.x -= 0.08; armR.rotation.x -= 0.08; armL.rotation.z -= 0.03; armR.rotation.z += 0.03; }
      rig.position.y -= 0.1;
      if (eyes) eyes.scale.y *= 0.7;
      if (P.mouth) P.mouth.scale.x *= 0.7;
      if (tail) tail.rotation.x += 0.4;
      break;
    }
    case "celebrate": {
      const ph = mod(tt * 1.4, 1);
      const jump = 4 * ph * (1 - ph);
      rig.position.y += 3.0 * jump;
      if (quad) { armL.rotation.x -= 0.7 * jump; armR.rotation.x -= 0.7 * jump; legL.rotation.x += 0.5 * jump; legR.rotation.x += 0.5 * jump; }
      else {
        armL.rotation.z += 2.6 + 0.25 * S(tt * 14); armR.rotation.z -= 2.6 + 0.25 * S(tt * 14 + 1);
        legL.rotation.x -= 0.35 * jump; legR.rotation.x += 0.2 * jump;
      }
      head.rotation.x -= 0.15;
      openMouth(true);
      break;
    }
    case "discover": {
      head.rotation.y += 0.5 * S(tt * 1.1);
      head.rotation.x -= 0.1;
      body.rotation.y += 0.15 * S(tt * 1.1);
      if (!quad) armR.rotation.x += -1.25 + 0.05 * S(tt * 3);
      openMouth(S(tt * 0.9) > 0.7);
      break;
    }
    case "rest": {
      const legH = legL.userData.rest.p.y;
      if (quad) { for (const l of [armL, armR]) l.rotation.x -= 1.4; for (const l of [legL, legR]) l.rotation.x += 1.4; rig.position.y -= legH * 0.75; }
      else if (kind !== "snake") {
        legL.rotation.x -= 1.45; legR.rotation.x -= 1.45;
        rig.position.y -= Math.max(0, legH - 0.8);
        armL.rotation.x += 0.15; armR.rotation.x += 0.15;
      }
      body.scale.y *= 1 + 0.01 * S(tt * 1.2);
      head.rotation.z += 0.05 * S(tt * 0.5);
      break;
    }
    default: break;
  }
}

// =================================================================================================
// Studio: lights, grass base, framing
// =================================================================================================

const KEY_DIR = new THREE.Vector3(0.62, 1.0, 0.82).normalize();
const RIM_DIR = new THREE.Vector3(-0.55, 0.65, -1.0).normalize();
const FILL_DIR = new THREE.Vector3(-1.0, 0.35, 0.55).normalize();

function addStudioLights(scene, shadowSize = 1024) {
  const hemi = new THREE.HemisphereLight(0xfff6ea, 0x9a8f80, 1.15);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.5);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.06;
  const rim = new THREE.DirectionalLight(0xe2ecff, 1.5);
  const fill = new THREE.DirectionalLight(0xf3f0ff, 0.45);
  scene.add(hemi, key, key.target, rim, rim.target, fill, fill.target);
  return { hemi, key, rim, fill };
}

function aimLights(L, center, radius) {
  const d = radius * 3;
  L.key.target.position.copy(center);
  L.key.position.copy(center).addScaledVector(KEY_DIR, d);
  const cam = L.key.shadow.camera;
  cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
  cam.near = d - radius * 1.6; cam.far = d + radius * 1.6;
  cam.updateProjectionMatrix();
  L.rim.target.position.copy(center);
  L.rim.position.copy(center).addScaledVector(RIM_DIR, d);
  L.fill.target.position.copy(center);
  L.fill.position.copy(center).addScaledVector(FILL_DIR, d);
}

const BASE_TILE = 5, BASE_DEPTH = 3;

function buildBaseVox(tiles, variant) {
  const T = BASE_TILE, W = tiles * T;
  const v = new Vox(9173 + variant * 31, 0.06);
  const x0 = -Math.floor(W / 2), z0 = -Math.floor(W / 2) + 1;
  const grass = [0x79c25a, 0x70b852, 0x82c862, 0x74bd56];
  const dirt = 0x8d5c3c, dirtDark = 0x734a30, stone = 0x9a8f86;
  for (let x = x0; x < x0 + W; x++) for (let z = z0; z < z0 + W; z++) {
    const tx = Math.floor((x - x0) / T), tz = Math.floor((z - z0) / T);
    const g = grass[(tx + tz * 2 + variant) % 4];
    v.set(x, -1, z, g, MAT_SOLID, 0.07);
    const edge = x === x0 || x === x0 + W - 1 || z === z0 || z === z0 + W - 1;
    for (let y = -BASE_DEPTH; y <= -2; y++) {
      let c = mod(y + x + z, 5) === 0 ? dirtDark : dirt;
      if (y === -2 && edge && hash3(x, y, z, variant) > 0.45) c = shade(g, 0.88);
      if (edge && hash3(x, y, z, variant + 7) > 0.93) c = stone;
      v.set(x, y, z, c, MAT_SOLID, 0.07);
    }
  }
  // tufts & tiny flowers away from the feet
  const s = 400 + variant;
  for (let i = 0; i < 9 + tiles * 4; i++) {
    const x = x0 + Math.floor(hash3(i, 1, 2, s) * W), z = z0 + Math.floor(hash3(i, 3, 4, s) * W);
    if (Math.abs(x + 0.5) < 4.5 && Math.abs(z) < 4) continue;
    const kind = hash3(i, 5, 6, s);
    if (kind < 0.62) {
      const g = shade(0x6fbf4f, 0.85 + hash3(i, 7, 7, s) * 0.3);
      v.det(x + 0.15, 0, z + 0.3, x + 0.4, 0.7, z + 0.55, g);
      v.det(x + 0.5, 0, z + 0.45, x + 0.75, 0.95, z + 0.7, g);
      v.det(x + 0.35, 0, z + 0.05, x + 0.6, 0.55, z + 0.3, g);
    } else if (kind < 0.9) {
      const pc = [0xffffff, 0xffd84a, 0xf48fb1, 0xb39ddb][i % 4];
      v.det(x + 0.42, 0, z + 0.42, x + 0.58, 0.9, z + 0.58, 0x4f9a3f);
      v.det(x + 0.22, 0.85, z + 0.22, x + 0.78, 1.25, z + 0.78, pc);
      v.det(x + 0.38, 1.0, z + 0.38, x + 0.62, 1.32, z + 0.62, 0xffc23a);
    } else {
      v.det(x + 0.1, 0, z + 0.1, x + 0.9, 0.45, z + 0.8, 0xa9a39c);
    }
  }
  return v;
}

function buildBase(tiles, variant) {
  const v = buildBaseVox(tiles, variant);
  const occ = new Set(v.m.keys());
  const g = new THREE.Group();
  g.name = "voxel-base";
  const mats = materials();
  for (const [mat, geo] of meshVox(v, [0, 0, 0], occ)) {
    const m = new THREE.Mesh(geo, mats[mat]);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  g.userData.tiles = tiles;
  return g;
}

/** Base size (in tiles) from the character's standing footprint. */
function tilesFor(group) {
  const ext = group.userData.footprint || 5;
  return clampN(Math.ceil((ext * 2 + 4) / BASE_TILE), 3, 5);
}

/** Invisible floor that only shows the soft shadow of the base. */
function makeCatcher() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.16 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = -BASE_DEPTH - 0.02;
  m.receiveShadow = true;
  return m;
}
function sizeCatcher(m, tiles) {
  const s = tiles * BASE_TILE * 2.6;
  m.scale.set(s, s, 1);
}

const _v = new THREE.Vector3();
/** Fit a perspective camera (looking from azimuth/elevation) around `points`, leaving `margin`. */
function fitCamera(cam, points, center, az, el, margin) {
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const target = center.clone();
  let dist = 60;
  const halfTan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  const right = new THREE.Vector3(), up = new THREE.Vector3();
  for (let it = 0; it < 6; it++) {
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      _v.copy(p).project(cam);
      minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x); minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
    }
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    const halfH = dist * halfTan;
    target.addScaledVector(right, ((minX + maxX) / 2) * halfH * cam.aspect).addScaledVector(up, ((minY + maxY) / 2) * halfH);
    const s = Math.max((maxX - minX) / 2, (maxY - minY) / 2) / (1 - margin);
    dist *= s;
  }
  cam.position.copy(target).addScaledVector(dir, dist);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  return { target, dist };
}

function boxCorners(box) {
  const out = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

function configureRenderer(r) {
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was folded into PCF (+radius) in r180+
}

const STUDIO_TOP = "#ece9e4", STUDIO_BOTTOM = "#d9d4cd";
const PORTRAIT_AZ = -0.5, PORTRAIT_EL = 0.2; // slight 3/4 view from the figure's right (held items face the camera)
const VIEWER_MARGIN = 0.1;

// =================================================================================================
// renderPortrait — one shared offscreen renderer, memoised results
// =================================================================================================

// Memo: key → Promise<dataURL>. Bounded by total data-URL length (studio PNGs are ~0.3 MB each).
const portraitCache = new Map();
const portraitSizes = new Map();
const PORTRAIT_CACHE_MAX = 200;
const PORTRAIT_CACHE_CHARS = 24e6;
let portraitChars = 0;
let studio = null;
let webglFailed = false; // no WebGL at all → straight to the 2D fallback
let queue = Promise.resolve();
let renderCount = 0;

function getStudio() {
  if (studio && !studio.lost) return studio;
  if (studio) { try { studio.renderer.dispose(); } catch { /* context already gone */ } }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  configureRenderer(renderer);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const lights = addStudioLights(scene, 1024);
  const cam = new THREE.PerspectiveCamera(24, 1, 1, 1000);
  const catcher = makeCatcher();
  scene.add(catcher);
  const out = document.createElement("canvas");
  const S = { renderer, scene, lights, cam, catcher, out, bases: new Map(), lost: false };
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); S.lost = true; }, false);
  warmUp(S);
  studio = S;
  return S;
}

/** Compile every material/shadow program once so the first portraits of each kind don't stutter. */
function warmUp(S) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.setAttribute("color", new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count * 3).fill(1), 3));
  const meshes = materials().map((m, i) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.x = i * 1.5;
    mesh.castShadow = mesh.receiveShadow = true;
    S.scene.add(mesh);
    return mesh;
  });
  aimLights(S.lights, new THREE.Vector3(3, 0, 0), 6);
  S.cam.position.set(3, 4, 14);
  S.cam.lookAt(3, 0, 0);
  S.renderer.setSize(16, 16, false);
  S.renderer.render(S.scene, S.cam);
  for (const m of meshes) S.scene.remove(m);
  geo.dispose();
}

function baseFor(S, tiles, variant) {
  const k = tiles + ":" + variant;
  let b = S.bases.get(k);
  if (!b) { b = buildBase(tiles, variant); S.bases.set(k, b); }
  return b;
}

function paintBackground(g, size, background) {
  if (background === "transparent") return;
  if (background === "studio") {
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, STUDIO_TOP);
    grad.addColorStop(1, STUDIO_BOTTOM);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const rg = g.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.42, size * 0.62);
    rg.addColorStop(0, "rgba(255,255,255,0.35)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, size, size);
  } else {
    g.fillStyle = background;
    g.fillRect(0, 0, size, size);
  }
}

function renderPortraitSync(appearance, size, background, pose) {
  const S = getStudio();
  const char = buildCharacter(appearance);
  let base = null;
  try {
    animateCharacter(char, pose === "wave" ? "wave" : "idle", pose === "wave" ? 0.15 : 0);
    if (char.userData.parts.eyes) char.userData.parts.eyes.scale.y = 1; // never catch a blink
    S.scene.add(char);
    char.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(char);
    const withBase = background !== "transparent";
    if (withBase) {
      const tiles = tilesFor(char);
      base = baseFor(S, tiles, hashStr(JSON.stringify(char.userData.appearance)) % 4);
      S.scene.add(base);
      base.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(base));
      sizeCatcher(S.catcher, tiles);
    }
    S.catcher.visible = withBase;
    const center = box.getCenter(new THREE.Vector3());
    aimLights(S.lights, center, (box.getSize(new THREE.Vector3()).length() / 2) * 1.15);
    S.cam.aspect = 1;
    S.cam.updateProjectionMatrix();
    fitCamera(S.cam, boxCorners(box), center, PORTRAIT_AZ, PORTRAIT_EL, 0.08);
    // MSAA handles edges; supersample only small sizes (software GL is fill-rate bound)
    const px = Math.max(16, Math.round(size * (size <= 256 ? 2 : 1)));
    S.renderer.setSize(px, px, false);
    S.renderer.render(S.scene, S.cam);
    const out = S.out;
    out.width = out.height = size;
    const g = out.getContext("2d");
    g.clearRect(0, 0, size, size);
    paintBackground(g, size, background);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(S.renderer.domElement, 0, 0, size, size);
    renderCount++;
    return out.toDataURL("image/png");
  } finally {
    S.scene.remove(char);
    if (base) S.scene.remove(base);
    disposeCharacter(char);
  }
}

const yieldToMain = () => new Promise((resolve) => {
  if (typeof MessageChannel === "function") {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  } else setTimeout(resolve, 0);
});

/**
 * Render a portrait PNG of a character. Results are memoised by the (normalised) arguments.
 * opts: { size = 512, background = "studio" | "transparent" | "#rrggbb", pose = "idle" | "wave" }
 */
export function renderPortrait(appearance, opts = {}) {
  const a = normalizeAppearance(appearance);
  const size = clampN(Math.round(Number(opts.size) || 512), 32, 2048);
  const bgIn = opts.background;
  const background = bgIn === "transparent" ? "transparent" : typeof bgIn === "string" && /^#[0-9a-f]{3,6}$/i.test(bgIn) ? safeColor(bgIn, STUDIO_TOP) : "studio";
  const pose = opts.pose === "wave" ? "wave" : "idle";
  const k = JSON.stringify([a, size, background, pose]);
  const hit = portraitCache.get(k);
  if (hit) { portraitCache.delete(k); portraitCache.set(k, hit); return hit; }
  const job = queue.then(async () => {
    await yieldToMain();
    if (!webglFailed) {
      try {
        return renderPortraitSync(a, size, background, pose);
      } catch {
        if (studio) studio.lost = true; // rebuild the renderer next time
        else webglFailed = true;
      }
    }
    return renderFallback(a, size, background);
  });
  queue = job.catch(() => {});
  job.then((url) => {
    if (portraitCache.get(k) !== job) return;
    portraitSizes.set(k, url.length);
    portraitChars += url.length;
    trimPortraitCache();
  }, () => portraitCache.delete(k));
  portraitCache.set(k, job);
  trimPortraitCache();
  return job;
}

function trimPortraitCache() {
  for (const k of portraitCache.keys()) {
    if (portraitCache.size <= PORTRAIT_CACHE_MAX && portraitChars <= PORTRAIT_CACHE_CHARS) break;
    if (!portraitSizes.has(k)) continue; // still rendering
    portraitChars -= portraitSizes.get(k);
    portraitSizes.delete(k);
    portraitCache.delete(k);
  }
}

/** Diagnostics for tests / dev pages. */
export function portraitStats() {
  const info = studio ? studio.renderer.info : null;
  return {
    renders: renderCount,
    cached: portraitCache.size,
    cachedMB: Math.round(portraitChars / 1e5) / 10,
    geometries: info ? info.memory.geometries : 0,
    textures: info ? info.memory.textures : 0,
    programs: info && info.programs ? info.programs.length : 0,
  };
}

export function clearPortraitCache() { portraitCache.clear(); portraitSizes.clear(); portraitChars = 0; }

// ---- 2D fallback when WebGL is unavailable: painter's-algorithm voxel projection -------------

function renderFallback(a, size, background) {
  const ctx = design(a);
  const out = document.createElement("canvas");
  out.width = out.height = size;
  const g = out.getContext("2d");
  paintBackground(g, size, background);
  // Collect boxes [x0,y0,z0,x1,y1,z1,colour,material] in character space (rest pose, no part rotations).
  const boxes = [];
  const addVox = (vox, dy = 0) => {
    for (const [k, v] of vox.m) {
      const x = kx(k), y = ky(k), z = kz(k);
      if (vox.has(x, y, z + 1) && vox.has(x, y + 1, z) && vox.has(x - 1, y, z)) continue; // fully hidden
      boxes.push([x, y + dy, z, x + 1, y + dy + 1, z + 1, v % MSHIFT, Math.floor(v / MSHIFT)]);
    }
    for (let i = 0; i < vox.d.length; i += 8) {
      const d = vox.d;
      boxes.push([d[i], d[i + 1] + dy, d[i + 2], d[i + 3], d[i + 4] + dy, d[i + 5], d[i + 6], d[i + 7]]);
    }
  };
  for (const p of Object.values(ctx.parts)) if (!p.local && !p.hidden) addVox(p.vox, ctx.float);
  if (background !== "transparent") addVox(buildBaseVox(3, 0));
  const ca = Math.cos(PORTRAIT_AZ), sa = Math.sin(PORTRAIT_AZ), ce = Math.cos(PORTRAIT_EL), se = Math.sin(PORTRAIT_EL);
  const proj = (x, y, z) => {
    const rx = x * ca - z * sa, rz = x * sa + z * ca;
    return [rx, y * ce - rz * se, rz * ce + y * se];
  };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of boxes) for (const [x, y, z] of [[b[0], b[1], b[2]], [b[3], b[4], b[5]], [b[0], b[4], b[5]], [b[3], b[1], b[2]]]) {
    const [px, py] = proj(x, y, z);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  if (!boxes.length) return out.toDataURL("image/png");
  const scale = (size * 0.86) / Math.max(maxX - minX, maxY - minY);
  const ox = size / 2 - ((minX + maxX) / 2) * scale, oy = size / 2 + ((minY + maxY) / 2) * scale;
  const depth = (b) => proj((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2)[2];
  boxes.sort((p, q) => depth(p) - depth(q));
  // visible faces for a camera at front-left-above: +z, +y, -x
  const faces = [
    [(b) => [[b[0], b[1], b[5]], [b[3], b[1], b[5]], [b[3], b[4], b[5]], [b[0], b[4], b[5]]], 0.9],
    [(b) => [[b[0], b[4], b[2]], [b[0], b[4], b[5]], [b[3], b[4], b[5]], [b[3], b[4], b[2]]], 1.06],
    [(b) => [[b[0], b[1], b[2]], [b[0], b[1], b[5]], [b[0], b[4], b[5]], [b[0], b[4], b[2]]], 0.72],
  ];
  g.lineJoin = "round";
  g.lineWidth = Math.max(0.6, scale * 0.04);
  for (const b of boxes) {
    if (b[7] === MAT_GLASS) continue;
    g.globalAlpha = b[7] === MAT_GHOST ? 0.8 : 1;
    for (const [quad, f] of faces) {
      const col = "#" + (b[7] === MAT_GLOW ? b[6] : mul(b[6], f)).toString(16).padStart(6, "0");
      g.fillStyle = col;
      g.strokeStyle = col;
      g.beginPath();
      quad(b).forEach(([x, y, z], i) => {
        const [px, py] = proj(x, y, z);
        if (i) g.lineTo(ox + px * scale, oy - py * scale); else g.moveTo(ox + px * scale, oy - py * scale);
      });
      g.closePath();
      g.fill();
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  return out.toDataURL("image/png");
}

// =================================================================================================
// createViewer — interactive turntable
// =================================================================================================

/**
 * Interactive turntable viewer inside `container` (which provides the size).
 * opts: { background: "studio" | "transparent", action = "idle", autoRotate = true, label }
 * Returns { dispose(), setAppearance(a), setAction(name), renderer }.
 */
export function createViewer(container, appearance, opts = {}) {
  const reduce = prefersReducedMotion();
  const studioBg = opts.background !== "transparent";
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return imageViewer(container, appearance, opts);
  }
  configureRenderer(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = "voxel-viewer";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", opts.label || "3D character — drag to rotate");
  Object.assign(canvas.style, {
    display: "block", width: "100%", height: "100%", touchAction: "pan-y", cursor: "grab", outline: "none",
    background: studioBg ? `radial-gradient(ellipse at 50% 40%, rgba(255,255,255,.35), rgba(255,255,255,0) 62%), linear-gradient(${STUDIO_TOP}, ${STUDIO_BOTTOM})` : "transparent",
  });
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const lights = addStudioLights(scene, 2048);
  const cam = new THREE.PerspectiveCamera(26, 1, 1, 1000);
  const stage = new THREE.Group();
  scene.add(stage);
  const catcher = studioBg ? makeCatcher() : null;
  if (catcher) scene.add(catcher);

  let char = null, base = null, center = new THREE.Vector3(), radius = 20, fitPoints = [];
  let action = opts.action || "idle";
  let yaw = 0, el = PORTRAIT_EL, vel = 0; // stage yaw (turntable) and camera elevation
  const az0 = PORTRAIT_AZ;
  const state = { disposed: false, visible: true, raf: 0, last: 0, t: 0, idleFor: 10, needs: true };

  function setAppearance(a) {
    if (char) disposeCharacter(char);
    if (base) { stage.remove(base); base.traverse((o) => o.isMesh && o.geometry.dispose()); base = null; }
    char = buildCharacter(a);
    stage.add(char);
    char.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(char);
    const figR = Math.max(Math.hypot(box.min.x, box.min.z), Math.hypot(box.max.x, box.max.z), Math.hypot(box.min.x, box.max.z), Math.hypot(box.max.x, box.min.z));
    if (studioBg) {
      const tiles = tilesFor(char);
      base = buildBase(tiles, hashStr(JSON.stringify(char.userData.appearance)) % 4);
      sizeCatcher(catcher, tiles);
      stage.add(base);
      base.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(base));
    }
    // rotation-invariant bounds so the turntable never clips
    const r = Math.max(figR * 0.8, studioBg ? (tilesFor(char) * BASE_TILE) / 2 : 0);
    const top = box.max.y + 1.5; // headroom for jumps
    const bb = new THREE.Box3(new THREE.Vector3(-r, box.min.y, -r), new THREE.Vector3(r, top, r));
    center = bb.getCenter(new THREE.Vector3());
    radius = bb.getSize(new THREE.Vector3()).length() / 2;
    fitPoints = boxCorners(bb);
    aimLights(lights, center, radius * 1.1);
    refit();
    state.needs = true;
  }

  function refit() {
    const w = container.clientWidth || 300, h = container.clientHeight || w;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    fitCamera(cam, fitPoints, center, az0, el, VIEWER_MARGIN);
    state.needs = true;
  }

  // ---- interaction ----
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, t: performance.now() };
    vel = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    canvas.style.cursor = "grabbing";
  }, sig);
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const now = performance.now();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    const dt = Math.max(8, now - drag.t) / 1000;
    yaw += dx * 0.012;
    vel = (dx * 0.012) / dt;
    el = clampN(el + dy * 0.004, 0.02, 0.6);
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    state.idleFor = 0;
    if (dy) fitCamera(cam, fitPoints, center, az0, el, VIEWER_MARGIN);
    state.needs = true;
    wake();
  }, sig);
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    canvas.style.cursor = "grab";
    wake();
  };
  canvas.addEventListener("pointerup", endDrag, sig);
  canvas.addEventListener("pointercancel", endDrag, sig);
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      yaw += e.key === "ArrowLeft" ? -0.3 : 0.3;
      state.idleFor = 0; state.needs = true; wake();
      e.preventDefault();
    }
  }, sig);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); }, sig);

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { refit(); wake(); }) : null;
  if (ro) ro.observe(container); else window.addEventListener("resize", () => { refit(); wake(); }, sig);
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => { state.visible = entries.some((en) => en.isIntersecting); if (state.visible) wake(); })
    : null;
  if (io) io.observe(container);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(state.raf); state.raf = 0; state.lostCtx = true; }, sig);
  canvas.addEventListener("webglcontextrestored", () => { state.lostCtx = false; state.needs = true; wake(); }, sig);
  // visible focus ring for keyboard users (arrow keys rotate)
  canvas.addEventListener("focus", () => { if (canvas.matches(":focus-visible")) canvas.style.boxShadow = "inset 0 0 0 3px #39d6ff"; }, sig);
  canvas.addEventListener("blur", () => { canvas.style.boxShadow = ""; }, sig);

  const animated = () => !reduce || drag || Math.abs(vel) > 0.01;

  function frame(now) {
    state.raf = 0;
    if (state.disposed || state.lostCtx) return;
    const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 0.016;
    state.last = now;
    state.idleFor += dt;
    if (!drag) {
      yaw += vel * dt;
      vel *= Math.exp(-dt * 3.2);
      if (Math.abs(vel) < 0.01) vel = 0;
      if (!reduce && opts.autoRotate !== false && state.idleFor > 2.5) yaw += dt * 0.32;
    }
    stage.rotation.y = yaw;
    if (!reduce) state.t += dt;
    if (char) animateCharacter(char, reduce ? "idle" : action, reduce ? 0 : state.t);
    if (char && reduce && char.userData.parts.eyes) char.userData.parts.eyes.scale.y = 1;
    renderer.render(scene, cam);
    state.needs = false;
    if (state.visible && !document.hidden && (animated() || state.needs)) state.raf = requestAnimationFrame(frame);
    else state.last = 0;
  }
  function wake() {
    if (state.disposed || state.raf || !state.visible || document.hidden) return;
    state.raf = requestAnimationFrame(frame);
  }

  setAppearance(appearance);
  wake();

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    cancelAnimationFrame(state.raf);
    ac.abort();
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    if (char) disposeCharacter(char);
    if (base) base.traverse((o) => o.isMesh && o.geometry.dispose());
    if (catcher) { catcher.geometry.dispose(); catcher.material.dispose(); }
    lights.key.shadow.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch { /* ignore */ }
    canvas.remove();
  }

  return {
    dispose,
    setAppearance(a) { if (!state.disposed) { setAppearance(a); wake(); } },
    setAction(name) { action = typeof name === "string" ? name : "idle"; state.needs = true; wake(); },
    get renderer() { return renderer; },
  };
}

/** Viewer stand-in when WebGL cannot be created: a static portrait image. */
function imageViewer(container, appearance, opts) {
  const img = document.createElement("img");
  img.alt = opts.label || "";
  Object.assign(img.style, { display: "block", width: "100%", height: "100%", objectFit: "contain" });
  container.appendChild(img);
  let alive = true;
  renderPortrait(appearance, { size: 512, background: opts.background === "transparent" ? "transparent" : "studio" })
    .then((url) => { if (alive) img.src = url; })
    .catch(() => {});
  return { dispose() { alive = false; img.remove(); }, setAppearance() {}, setAction() {}, renderer: null };
}
