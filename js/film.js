// BookTrip — the 3D "trip into the book" mini-film (owner: film).
//
// createFilm(container, { book, lang, tts, onScene, onEnd, autoplay, controls })
//   → { play(), pause(), restart(), dispose(), get playing(), seek(i), renderAt(t), get timeline, get duration }
//
// Sequence: intro (a voxel book on a desk opens, pages flip, the camera dives into the page through a burst of
// glowing letters) → one floating voxel diorama per scene of book.film.scenes → outro (the book closes, the film
// title). A DOM overlay inside the container shows title cards, subtitles, progress and controls; narration is
// optionally spoken with speechSynthesis.
//
// Rendering: every segment is its own THREE.Scene with the same light rig (so shader programs are shared). A
// segment renders into an HDR multisampled target; one composite pass then does the page-turn / iris transitions,
// bloom, the mood colour grade, a tilt-shift blur and tone mapping. Static diorama voxels are meshed with culled
// faces + baked AO and merged into one mesh per material, so an island costs about five draw calls.

import * as THREE from "three";
import { buildCharacter, animateCharacter, normalizeAppearance, disposeCharacter } from "./voxel.js";
import { SETTINGS, TIMES, WEATHER, ACTIONS, CAMERAS, MOODS, SCENE_PROPS } from "./enums.js";
import { hashStr, seeded, prefersReducedMotion } from "./util.js";

// =================================================================================================
// Constants & small helpers
// =================================================================================================

const MAX_DPR = 1.75;
const MAX_PIXELS = 2.6e6;        // drawing-buffer budget (big 2560px screens would otherwise get 8 MP)
const CPS = 14;                  // reading / speaking speed, characters per second
const SCENE_MIN = 7;             // seconds
const SPEECH_CAP = 20;           // a scene never waits for speech beyond this many seconds
const TRANS = 1.25;              // page-turn transition length (s)
const IRIS = 1.3;                // intro → first scene reveal (s)
const DIVE = 2.7;                // length of the dive at the end of the intro (s)
const FOV = 30;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const range = (t, a, b) => sat((t - a) / (b - a));
const smooth = (t) => { t = sat(t); return t * t * (3 - 2 * t); };
const easeInOut = (t) => { t = sat(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOut = (t) => 1 - Math.pow(1 - sat(t), 3);
const easeIn = (t) => { t = sat(t); return t * t * t; };
const pick = (v, list, fb) => (typeof v === "string" && list.includes(v) ? v : fb);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Deterministic hash of integer coords → [0, 1). */
function h3(x, y, z, s) {
  let h = (s ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth 2D value noise in [0, 1). */
function noise2(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h3(xi, 0, zi, s), b = h3(xi + 1, 0, zi, s), c = h3(xi, 0, zi + 1, s), d = h3(xi + 1, 0, zi + 1, s);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// --- colours as sRGB integers 0xRRGGBB ---
const cl8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const R8 = (c) => (c >> 16) & 255, G8 = (c) => (c >> 8) & 255, B8 = (c) => c & 255;
const pack = (r, g, b) => (cl8(r) << 16) | (cl8(g) << 8) | cl8(b);
const mixC = (a, b, t) => pack(R8(a) + (R8(b) - R8(a)) * t, G8(a) + (G8(b) - G8(a)) * t, B8(a) + (B8(b) - B8(a)) * t);
const mulC = (c, f) => pack(R8(c) * f, G8(c) * f, B8(c) * f);
const hexC = (s, fb) => (typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s.trim()) ? parseInt(s.trim().slice(1), 16) : fb);
const cssC = (c) => "#" + c.toString(16).padStart(6, "0");
const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const col3 = (c) => new THREE.Color().setRGB(LIN[R8(c)], LIN[G8(c)], LIN[B8(c)]);

// =================================================================================================
// Overlay strings (the film is self-contained; app strings live in i18n.js)
// =================================================================================================

const STR = {
  ru: {
    film: "Мини-фильм", play: "Смотреть фильм", pause: "Пауза", resume: "Продолжить", replay: "Смотреть снова",
    scene: "Сцена {n} из {m}", voiceOn: "Выключить озвучку", voiceOff: "Включить озвучку", full: "Во весь экран",
    exitFull: "Свернуть", end: "Конец", prev: "Предыдущая сцена", next: "Следующая сцена", progress: "Сцены фильма",
    scenes: ["сцена", "сцены", "сцен"], nogl: "3D недоступно на этом устройстве — показываем раскадровку",
  },
  uk: {
    film: "Міні-фільм", play: "Дивитися фільм", pause: "Пауза", resume: "Продовжити", replay: "Дивитися знову",
    scene: "Сцена {n} з {m}", voiceOn: "Вимкнути озвучення", voiceOff: "Увімкнути озвучення", full: "На весь екран",
    exitFull: "Згорнути", end: "Кінець", prev: "Попередня сцена", next: "Наступна сцена", progress: "Сцени фільму",
    scenes: ["сцена", "сцени", "сцен"], nogl: "3D недоступне на цьому пристрої — показуємо розкадрування",
  },
  en: {
    film: "Mini film", play: "Watch the film", pause: "Pause", resume: "Resume", replay: "Watch again",
    scene: "Scene {n} of {m}", voiceOn: "Turn narration off", voiceOff: "Turn narration on", full: "Full screen",
    exitFull: "Exit full screen", end: "The End", prev: "Previous scene", next: "Next scene", progress: "Film scenes",
    scenes: ["scene", "scenes", "scenes"], nogl: "3D is not available on this device — showing a storyboard",
  },
};
function plural(lang, n, forms) {
  if (lang === "en") return n === 1 ? forms[0] : forms[1];
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

// =================================================================================================
// Voxel grid + mesher (culled faces, baked AO, one bucket per material)
// =================================================================================================

const M_SOLID = 0, M_GLOW = 1, M_WATER = 2, M_LEAF = 3, M_GLASS = 4, M_COUNT = 5;
const OPAQUE = [1, 1, 0, 1, 0];
const KB = 2048, KO = 1024, KB2 = KB * KB;
const vkey = (x, y, z) => ((x + KO) * KB + (y + KO)) * KB + (z + KO);

class Grid {
  constructor(size, seed) { this.size = size; this.seed = seed | 0; this.m = new Map(); }
  set(x, y, z, c, mat = M_SOLID, jit = 0.05) {
    if (c == null || c < 0) return this;
    if (jit > 0) c = mulC(c, 1 + (h3(x, y, z, this.seed) - 0.5) * 2 * jit);
    this.m.set(vkey(x, y, z), c * 8 + mat);
    return this;
  }
  get(x, y, z) { const v = this.m.get(vkey(x, y, z)); return v === undefined ? -1 : v >> 3; }
  mat(x, y, z) { const v = this.m.get(vkey(x, y, z)); return v === undefined ? -1 : v & 7; }
  has(x, y, z) { return this.m.has(vkey(x, y, z)); }
  solid(x, y, z) { const v = this.m.get(vkey(x, y, z)); return v !== undefined && OPAQUE[v & 7] === 1; }
  del(x, y, z) { this.m.delete(vkey(x, y, z)); return this; }
  box(x0, x1, y0, y1, z0, z1, c, mat = M_SOLID, jit = 0.05) {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const fn = typeof c === "function";
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const cc = fn ? c(x, y, z) : c;
      if (cc != null && cc >= 0) this.set(x, y, z, cc, mat, jit);
    }
    return this;
  }
}

// Face table: normal + 4 corners (CCW from outside) with the 3 neighbour offsets used for AO.
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
const AO_CURVE = [0.52, 0.7, 0.86, 1];

const newBuckets = () => Array.from({ length: M_COUNT }, () => ({ p: [], n: [], c: [], i: [] }));

/** Mesh a grid into buckets. Generator: yields every few thousand voxels so big builds can be spread over frames. */
function* meshGrid(g, Bk, ox = 0, oy = 0, oz = 0) {
  const s = g.size, m = g.m;
  const ao = [3, 3, 3, 3];
  let count = 0;
  for (const [k, v] of m) {
    if (++count % 3500 === 0) yield;
    const mat = v & 7, col = v >> 3;
    const x = Math.floor(k / KB2) - KO, y = (Math.floor(k / KB) % KB) - KO, z = (k % KB) - KO;
    const r = LIN[(col >> 16) & 255], gg = LIN[(col >> 8) & 255], bb = LIN[col & 255];
    const useAO = mat === M_SOLID || mat === M_LEAF;
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const nv = m.get(vkey(x + F.n[0], y + F.n[1], z + F.n[2]));
      if (nv !== undefined && ((nv & 7) === mat || OPAQUE[nv & 7] === 1)) continue;
      const B = Bk[mat];
      const base = B.p.length / 3;
      for (let ci = 0; ci < 4; ci++) {
        const C = F.cs[ci];
        let sh = 1;
        if (useAO) {
          const o1 = g.solid(x + C.s1[0], y + C.s1[1], z + C.s1[2]) ? 1 : 0;
          const o2 = g.solid(x + C.s2[0], y + C.s2[1], z + C.s2[2]) ? 1 : 0;
          const o3 = g.solid(x + C.cr[0], y + C.cr[1], z + C.cr[2]) ? 1 : 0;
          const lvl = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
          ao[ci] = lvl;
          sh = AO_CURVE[lvl];
        } else ao[ci] = 3;
        B.p.push((x + C.v[0]) * s + ox, (y + C.v[1]) * s + oy, (z + C.v[2]) * s + oz);
        B.n.push(F.n[0], F.n[1], F.n[2]);
        B.c.push(r * sh, gg * sh, bb * sh);
      }
      if (ao[0] + ao[2] > ao[1] + ao[3]) B.i.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      else B.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

function bucketGeometry(B) {
  if (!B.i.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(B.p, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(B.n, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(B.c, 3));
  geo.setIndex(B.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(B.i, 1) : new THREE.Uint16BufferAttribute(B.i, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * A painter draws into a grid in local coordinates around an origin, rotated by rot·90° about Y.
 * Local cell (x, z) maps to a world cell; boxes stay axis-aligned under quarter turns.
 */
function painter(g, ox, oy, oz, rot = 0) {
  rot = ((rot % 4) + 4) % 4;
  const tx = (x, z) => (rot === 0 ? [x, z] : rot === 1 ? [z, -x - 1] : rot === 2 ? [-x - 1, -z - 1] : [-z - 1, x]);
  const P = {
    g, ox, oy, oz, rot,
    set(x, y, z, c, mat, jit) { const [wx, wz] = tx(x, z); g.set(ox + wx, oy + y, oz + wz, c, mat, jit); return P; },
    del(x, y, z) { const [wx, wz] = tx(x, z); g.del(ox + wx, oy + y, oz + wz); return P; },
    has(x, y, z) { const [wx, wz] = tx(x, z); return g.has(ox + wx, oy + y, oz + wz); },
    box(x0, x1, y0, y1, z0, z1, c, mat, jit) {
      if (typeof c === "function") {
        if (x0 > x1) [x0, x1] = [x1, x0];
        if (y0 > y1) [y0, y1] = [y1, y0];
        if (z0 > z1) [z0, z1] = [z1, z0];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          const cc = c(x, y, z);
          if (cc != null && cc >= 0) P.set(x, y, z, cc, mat, jit);
        }
        return P;
      }
      const [ax, az] = tx(x0, z0), [bx, bz] = tx(x1, z1);
      g.box(ox + Math.min(ax, bx), ox + Math.max(ax, bx), oy + y0, oy + y1, oz + Math.min(az, bz), oz + Math.max(az, bz), c, mat, jit);
      return P;
    },
    /** Ellipsoid centred at (cx,cy,cz) (cell units, may be fractional). `shell` > 0 keeps only the outer layer. */
    ball(cx, cy, cz, rx, ry, rz, c, mat, jit, shell = 0) {
      const fn = typeof c === "function";
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
          for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, dz = (z + 0.5 - cz) / rz;
            const d = dx * dx + dy * dy + dz * dz;
            if (d > 1) continue;
            if (shell > 0 && d < Math.pow(1 - shell / Math.min(rx, ry, rz), 2)) continue;
            const cc = fn ? c(x, y, z, dx, dy, dz) : c;
            if (cc != null && cc >= 0) P.set(x, y, z, cc, mat, jit);
          }
      return P;
    },
    /** Vertical cylinder of radius r centred on (cx, cz). */
    cyl(cx, cz, r, y0, y1, c, mat, jit) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
          const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
          if (dx * dx + dz * dz > r * r) continue;
          for (let y = y0; y <= y1; y++) {
            const cc = typeof c === "function" ? c(x, y, z, dx, dz) : c;
            if (cc != null && cc >= 0) P.set(x, y, z, cc, mat, jit);
          }
        }
      return P;
    },
    /** Draw a 1-voxel line (DDA) between two local points. */
    line(x0, y0, z0, x1, y1, z1, c, mat, jit, thick = 0) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t), z = Math.round(z0 + (z1 - z0) * t);
        if (thick) P.box(x, x + thick, y, y + thick, z, z + thick, c, mat, jit);
        else P.set(x, y, z, c, mat, jit);
      }
      return P;
    },
  };
  return P;
}

// =================================================================================================
// Materials (one set per film; voxel buckets are drawn with these)
// =================================================================================================

function makeMaterials(U) {
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  const water = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.86, shininess: 120, specular: new THREE.Color(0.55, 0.62, 0.7) });
  water.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
        if (objectNormal.y > 0.5) {
          vec4 nwp = modelMatrix * vec4(position, 1.0);
          objectNormal = normalize(vec3(0.32 * cos(nwp.x * 0.23 + uTime * 1.5) + 0.12 * sin(nwp.z * 0.7 - uTime * 2.0), 1.0, 0.28 * sin(nwp.z * 0.19 + uTime * 1.1)));
        }`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vec4 bwp = modelMatrix * vec4(transformed, 1.0);
        if (normal.y > 0.5) transformed.y += 0.3 * sin(bwp.x * 0.23 + uTime * 1.5) * cos(bwp.z * 0.19 + uTime * 1.1) + 0.12 * sin(bwp.x * 0.61 - bwp.z * 0.47 + uTime * 2.3);
        transformed.y -= 0.6;`);
  };
  water.customProgramCacheKey = () => "bt-water";
  const leaf = new THREE.MeshLambertMaterial({ vertexColors: true });
  leaf.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.uniforms.uWind = U.wind;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vec4 lwp = modelMatrix * vec4(transformed, 1.0);
        float sway = uWind * (0.55 + 0.45 * sin(uTime * 0.9 + lwp.x * 0.05));
        transformed.x += sway * 0.55 * sin(uTime * 2.1 + lwp.y * 0.21 + lwp.z * 0.13);
        transformed.z += sway * 0.3 * cos(uTime * 1.7 + lwp.y * 0.17 + lwp.x * 0.11);`);
  };
  leaf.customProgramCacheKey = () => "bt-leaf";
  const glass = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.42, shininess: 100, specular: 0xffffff, depthWrite: false });
  return [solid, glow, water, leaf, glass];
}

// =================================================================================================
// Sky dome
// =================================================================================================

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FS = /* glsl */ `
uniform vec3 uTop, uMid, uBot, uSunDir, uSunCol, uMoonDir, uMoonCut;
uniform float uSunSize, uStars, uTime, uMoon, uNebula;
varying vec3 vDir;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h >= 0.0 ? mix(uMid, uTop, pow(clamp(h * 1.15, 0.0, 1.0), 0.6)) : mix(uMid, uBot, pow(clamp(-h * 1.5, 0.0, 1.0), 0.75));
  float sd = max(dot(d, uSunDir), 0.0);
  float sunVis = 1.0 - uMoon;
  col += uSunCol * (pow(sd, 5.0) * 0.16 + pow(sd, 48.0) * 0.5) * sunVis;
  col += uSunCol * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.55, sd) * 5.0 * sunVis;
  float md = dot(d, uMoonDir);
  float disc = smoothstep(0.99935, 0.99965, md) * (1.0 - smoothstep(0.99935, 0.99965, dot(d, uMoonCut)));
  col += vec3(1.0, 0.95, 0.82) * disc * 3.0 * uMoon + vec3(0.55, 0.65, 1.0) * pow(max(md, 0.0), 70.0) * 0.3 * uMoon;
  if (uNebula > 0.0) {
    float n = sin(d.x * 3.1 + 1.3) * sin(d.y * 4.2 + 2.1) * sin(d.z * 3.6 + 0.4) + 0.35 * sin(d.x * 9.0 - d.z * 7.0);
    col += vec3(0.42, 0.12, 0.55) * smoothstep(0.15, 0.95, n) * uNebula * 0.55;
    col += vec3(0.05, 0.28, 0.5) * smoothstep(0.25, 0.95, -n) * uNebula * 0.45;
  }
  if (uStars > 0.0) {
    vec3 q = d * 230.0;
    vec3 cell = floor(q);
    float r = hash13(cell);
    if (r > 0.991) {
      vec3 f = fract(q) - 0.5;
      float s = smoothstep(0.34, 0.0, length(f));
      float tw = 0.6 + 0.4 * sin(uTime * (1.0 + r * 9.0) + r * 70.0);
      col += vec3(0.92, 0.95, 1.0) * s * tw * uStars * (1.2 + 2.6 * fract(r * 97.0)) * smoothstep(-0.45, 0.05, h + uNebula);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uBot: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uSunSize: { value: 0.0012 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonCut: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: 0 },
      uStars: { value: 0 }, uTime: { value: 0 }, uNebula: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

// =================================================================================================
// Particles (weather, moods, emitters) — all motion in the vertex shader, no per-frame CPU work
// =================================================================================================

const PK = { dot: 0, rain: 1, leaf: 2, puff: 3, confetti: 4, sparkle: 5 };
const PART_VS = /* glsl */ `
attribute float aSeed;
attribute float aSize;
attribute vec3 aColor;
uniform float uTime, uScale, uMaxSize, uWob, uSpin;
uniform vec3 uVel, uBox, uCenter;
varying vec3 vColor;
varying float vAlpha, vSeed, vAng;
void main() {
  float sp = 0.65 + 0.7 * fract(aSeed * 7.13);
  vec3 p = position + uVel * uTime * sp;
  p.x += sin(uTime * 1.3 + aSeed * 40.0) * uWob;
  p.z += cos(uTime * 1.1 + aSeed * 31.0) * uWob;
  p.y += sin(uTime * 0.9 + aSeed * 23.0) * uWob * 0.5;
  vec3 rel = mod(p - uCenter + uBox * 0.5, uBox);
  vec3 e = rel / uBox;
  vAlpha = smoothstep(0.0, 0.14, e.y) * smoothstep(1.0, 0.8, e.y) * smoothstep(0.0, 0.1, e.x) * smoothstep(1.0, 0.9, e.x) * smoothstep(0.0, 0.1, e.z) * smoothstep(1.0, 0.9, e.z);
  p = uCenter + rel - uBox * 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 1.0), uMaxSize);
  vColor = aColor;
  vSeed = aSeed;
  vAng = uTime * uSpin * (fract(aSeed * 3.7) - 0.5) * 2.0 + aSeed * 6.28;
}`;
const PART_FS = /* glsl */ `
uniform float uOpacity, uIntensity, uTime;
varying vec3 vColor;
varying float vAlpha, vSeed, vAng;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = 0.0;
#if KIND == 0
  a = smoothstep(0.5, 0.0, length(c)); a *= a;
#elif KIND == 1
  a = smoothstep(0.1, 0.0, abs(c.x)) * smoothstep(0.5, 0.12, abs(c.y));
#elif KIND == 2
  float cs = cos(vAng), sn = sin(vAng);
  vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  a = step(abs(r.x) * 1.9 + abs(r.y), 0.4);
#elif KIND == 3
  a = smoothstep(0.5, 0.0, length(c)); a = a * a * 0.55;
#elif KIND == 4
  float cs = cos(vAng), sn = sin(vAng);
  vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  float fl = abs(sin(uTime * 4.0 + vSeed * 30.0));
  a = step(abs(r.x), 0.3 * fl + 0.05) * step(abs(r.y), 0.17);
#else
  float tw = 0.5 + 0.5 * sin(uTime * 3.2 + vSeed * 50.0);
  float core = smoothstep(0.5, 0.0, length(c));
  float rays = smoothstep(0.07, 0.0, abs(c.x)) * smoothstep(0.5, 0.0, abs(c.y)) + smoothstep(0.07, 0.0, abs(c.y)) * smoothstep(0.5, 0.0, abs(c.x));
  a = (core * core * 0.8 + rays * 0.7) * tw;
#endif
  a *= vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * uIntensity, a);
}`;

/**
 * A particle system that wraps inside a box. spec: { kind, count, center:[x,y,z], box:[x,y,z], vel:[x,y,z],
 * size:[min,max], colors:[int…], wob, spin, opacity, intensity, additive }
 */
function makeParticles(spec, rng, U) {
  const n = spec.count | 0;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n), size = new Float32Array(n), color = new Float32Array(n * 3);
  const [cx, cy, cz] = spec.center, [bx, by, bz] = spec.box;
  const cols = spec.colors && spec.colors.length ? spec.colors : [0xffffff];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = cx + (rng() - 0.5) * bx;
    pos[i * 3 + 1] = cy + (rng() - 0.5) * by;
    pos[i * 3 + 2] = cz + (rng() - 0.5) * bz;
    seed[i] = rng();
    size[i] = lerp(spec.size[0], spec.size[1], rng());
    const c = cols[(rng() * cols.length) | 0];
    color[i * 3] = LIN[R8(c)]; color[i * 3 + 1] = LIN[G8(c)]; color[i * 3 + 2] = LIN[B8(c)];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.hypot(bx, by, bz));
  const mat = new THREE.ShaderMaterial({
    vertexShader: PART_VS, fragmentShader: PART_FS, defines: { KIND: PK[spec.kind] ?? 0 },
    transparent: true, depthWrite: false, fog: false,
    blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uTime: U.time, uScale: U.pscale, uMaxSize: U.pmax,
      uWob: { value: spec.wob || 0 }, uSpin: { value: spec.spin || 0 },
      uVel: { value: new THREE.Vector3(...spec.vel) }, uBox: { value: new THREE.Vector3(bx, by, bz) },
      uCenter: { value: new THREE.Vector3(cx, cy, cz) },
      uOpacity: { value: spec.opacity ?? 1 }, uIntensity: { value: spec.intensity ?? 1 },
    },
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = spec.additive ? 20 : 10;
  pts.frustumCulled = false;
  return pts;
}

// =================================================================================================
// Glowing letters (intro burst / outro return)
// =================================================================================================

const LET_VS = /* glsl */ `
attribute float aSeed, aGlyph, aMode;
uniform float uT, uDive, uScale, uMaxSize;
varying float vA, vHue;
varying vec2 vCell;
void main() {
  float early = step(aMode, 0.5);
  float launch = mix(uDive + aSeed * 1.0, mix(1.8, max(uDive - 0.4, 1.9), aSeed), early);
  float life = mix(2.5, 3.8, early);
  float k = (uT - launch) / life;
  vec3 p = position;
  vA = 0.0;
  if (k > 0.0 && k < 1.0) {
    float ang = aSeed * 40.0 + k * mix(5.5, 1.3, early);
    float rad = mix(2.0 + 26.0 * k * k, 0.8 + 3.0 * k, early);
    float hgt = mix(k * 78.0, k * 15.0, early);
    p += vec3(cos(ang) * rad, hgt, sin(ang) * rad);
    vA = smoothstep(0.0, 0.1, k) * smoothstep(1.0, 0.65, k);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = vA > 0.0 ? min(mix(2.2, 1.5, early) * uScale / max(-mv.z, 0.5), uMaxSize) : 0.0;
  vCell = vec2(mod(aGlyph, 8.0), floor(aGlyph / 8.0));
  vHue = fract(aSeed * 13.7);
}`;
const LET_FS = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uGain;
varying float vA, vHue;
varying vec2 vCell;
void main() {
  vec2 pc = gl_PointCoord;
  float g = texture2D(uAtlas, vec2((vCell.x + pc.x) / 8.0, 1.0 - (vCell.y + pc.y) / 8.0)).a;
  float halo = smoothstep(0.5, 0.0, length(pc - 0.5));
  float a = (g + halo * halo * 0.22) * vA;
  if (a < 0.004) discard;
  vec3 col = mix(vec3(2.6, 1.9, 0.9), vec3(0.9, 2.2, 2.8), step(0.72, vHue));
  gl_FragColor = vec4(col * uGain, a);
}`;

function letterAtlas(chars) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 512;
  const draw = () => {
    const g = cv.getContext("2d");
    g.clearRect(0, 0, 512, 512);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = '600 46px "Playfair Display", Georgia, serif';
    for (let i = 0; i < 64; i++) g.fillText(chars[i % chars.length], (i % 8) * 64 + 32, Math.floor(i / 8) * 64 + 34);
  };
  draw();
  const tex = new THREE.CanvasTexture(cv);
  tex.userData.redraw = () => { draw(); tex.needsUpdate = true; };
  return tex;
}

// =================================================================================================
// Post-processing: transitions, bloom, grade, tilt-shift, tone mapping
// =================================================================================================

const TRI_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const TRANS_GLSL = /* glsl */ `
uniform sampler2D tA;
uniform sampler2D tB;
uniform int uMode;
uniform float uProg, uAspect, uTime;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 sceneAt(vec2 uv) {
  if (uMode == 0) return texture2D(tA, uv).rgb;
  if (uMode == 2) {
    vec3 b = texture2D(tB, uv).rgb;
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p) / (0.5 * length(vec2(uAspect, 1.0)));
    float R = uProg * 1.45;
    float m = smoothstep(R, R - 0.45, r);
    vec3 white = vec3(2.4, 2.05, 1.6);
    float ring = exp(-pow((r - R + 0.16) * 8.0, 2.0)) * (1.0 - uProg);
    return mix(white, b, m) + vec3(1.4, 1.1, 0.6) * ring;
  }
  vec2 dir = normalize(vec2(1.0, 0.24));
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float d = dot(p, dir);
  float dmax = uAspect * dir.x + dir.y;
  float f = mix(dmax, 0.0, uProg);
  float e = 2.0 * f - dmax;
  if (d > f) {
    vec3 b = texture2D(tB, uv).rgb;
    return b * (1.0 - 0.62 * exp(-(d - f) * 13.0) * step(0.0005, uProg));
  }
  if (d > e) {
    float s = (f - d) / max(f - e, 1e-4);
    vec2 mp = p + dir * 2.0 * (f - d);
    vec2 muv = vec2(mp.x / uAspect, mp.y);
    vec3 ghost = texture2D(tA, clamp(muv, 0.0, 1.0)).rgb;
    float shade = 0.7 + 0.32 * sin(min(s * 2.4, 3.14159)) - 0.18 * exp(-s * 30.0);
    vec3 paper = vec3(0.92, 0.83, 0.66) * shade;
    float row = fract(muv.y * 34.0);
    float word = step(0.28, hash12(floor(vec2(muv.x * 15.0, muv.y * 34.0))));
    paper *= 1.0 - 0.09 * step(0.52, row) * step(row, 0.8) * word * step(0.07, muv.x) * step(muv.x, 0.93);
    paper = mix(paper, ghost * 0.5 + paper * 0.5, 0.12);
    float gl = step(0.972, hash12(floor(uv * vec2(240.0, 135.0)) + floor(uTime * 14.0))) * exp(-s * 16.0);
    return paper + vec3(3.2, 2.5, 1.2) * gl;
  }
  vec3 a = texture2D(tA, uv).rgb;
  return a * (1.0 - 0.38 * exp(-(e - d) * 20.0) * step(0.0005, uProg));
}`;
const BRIGHT_FS = TRANS_GLSL + /* glsl */ `
uniform vec2 uTexel;
uniform float uThresh;
varying vec2 vUv;
void main() {
  vec3 c = sceneAt(vUv + uTexel * vec2(-1.2, -1.2)) + sceneAt(vUv + uTexel * vec2(1.2, -1.2))
         + sceneAt(vUv + uTexel * vec2(-1.2, 1.2)) + sceneAt(vUv + uTexel * vec2(1.2, 1.2));
  c *= 0.25;
  float l = max(max(c.r, c.g), c.b);
  float k = max(l - uThresh, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * k, vec3(24.0)), 1.0);
}`;
const BLUR_FS = /* glsl */ `
uniform sampler2D tIn;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tIn, vUv).rgb * 0.2270270270;
  c += (texture2D(tIn, vUv + uDir * 1.3846153846).rgb + texture2D(tIn, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture2D(tIn, vUv + uDir * 3.2307692308).rgb + texture2D(tIn, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;
const COMP_FS = TRANS_GLSL + /* glsl */ `
uniform sampler2D tBloom;
uniform float uBloom, uExposure, uSat, uCon, uVig, uTilt, uFocus, uFlash, uFade, uGrain, uHDR;
uniform vec3 uTint, uLift, uFlashCol;
uniform vec2 uPx, uRes;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 color) {
  const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = I * (color / 0.6);
  color = RRTAndODTFit(color);
  return clamp(O * color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
const vec2 PD[8] = vec2[8](vec2(0.0, 1.0), vec2(0.65, 0.65), vec2(1.0, 0.0), vec2(0.65, -0.65), vec2(0.0, -1.0), vec2(-0.65, -0.65), vec2(-1.0, 0.0), vec2(-0.65, 0.65));
void main() {
  vec2 uv = vUv;
  vec3 col = sceneAt(uv);
  float tb = uTilt * smoothstep(0.14, 0.52, abs(uv.y - uFocus));
  if (tb > 0.05) {
    vec3 acc = col;
    for (int i = 0; i < 8; i++) acc += sceneAt(uv + PD[i] * uPx * tb);
    col = acc / 9.0;
  }
  col += texture2D(tBloom, uv).rgb * uBloom;
  col = col * uTint + uLift;
  col = mix(col, uFlashCol, uFlash);
  col = uHDR > 0.5 ? aces(col * uExposure) : clamp(col * uExposure, 0.0, 1.0);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uCon + 0.5;
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0) / (0.5 * length(vec2(uAspect, 1.0)));
  col *= 1.0 - uVig * smoothstep(0.42, 1.12, length(q));
  col = toSRGB(clamp(col, 0.0, 1.0));
  col += (hash12(uv * uRes + fract(uTime * 7.1) * 61.0) - 0.5) * (2.0 / 255.0) + (hash12(uv * uRes * 0.7 + uTime) - 0.5) * uGrain;
  col *= 1.0 - uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

// =================================================================================================
// Diorama world — a floating chunk of voxel terrain. Coarse grid C (2 units/cell) holds terrain and big
// models, fine grid F (1 unit/cell = one character voxel) holds props and details.
// =================================================================================================

// common colours
const WOOD = 0x8a5a34, WOOD_D = 0x60401f, WOOD_L = 0xb98a52, IRON = 0x34363e, GOLD = 0xf0bd3a, STONE = 0x9c968e;
const STONE_D = 0x7a746d, WHITE = 0xf3efe7, RED = 0xc8343c, LAMP = 0xffcf6e, FLAME = [0xffe08a, 0xffa53a, 0xff6a2a];
const LEAVES = [0x5fb84a, 0x52a843, 0x6cc455, 0x58b04a];
const FLOWERS = [0xff6b8a, 0xffd23f, 0xffffff, 0xb08cff, 0xff8f3f, 0x7fc8ff];

class World {
  constructor(o) {
    this.seed = o.seed >>> 0;
    this.rng = seeded(this.seed);
    this.setting = o.setting; this.time = o.time; this.weather = o.weather; this.mood = o.mood; this.action = o.action;
    this.night = o.time === "night";
    this.dark = o.time === "night" || o.time === "dusk";
    this.snowy = o.setting === "snow" || o.weather === "snow";
    this.C = new Grid(2, this.seed);
    this.F = new Grid(1, this.seed ^ 0x5bd1e995);
    this.cols = new Map();
    this.claims = new Set();
    this.lights = []; this.emitters = []; this.floaters = [];
    this.HX = 26; this.HZ = 20;
    this.stage = { cx: 0, cz: 2, rx: 15, rz: 8 };
    this.interior = false;
    this.leaves = LEAVES;
    this.slots = null;
    this.azRange = [-1.2, 1.4];
  }
  ck(i, k) { return (i + 512) * 1024 + (k + 512); }
  col(i, k) { return this.cols.get(this.ck(i, k)); }
  h(i, k) { const c = this.col(i, k); return c ? c.h : 0; }
  inside(i, k) { return this.cols.has(this.ck(i, k)); }
  water(i, k) { const c = this.col(i, k); return !!(c && c.water); }
  groundU(x, z) { return this.h(Math.floor(x / 2), Math.floor(z / 2)) * 2; }
  inStage(i, k, pad = 0) {
    const s = this.stage;
    const dx = (i + 0.5 - s.cx) / (s.rx + pad), dz = (k + 0.5 - s.cz) / (s.rz + pad);
    return dx * dx + dz * dz <= 1;
  }
  claimed(i, k) { return this.claims.has(this.ck(i, k)); }
  free(i0, i1, k0, k1, o = {}) {
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      if (!this.inside(i, k) || this.claimed(i, k)) return false;
      if (!o.water && this.water(i, k)) return false;
      if (o.stage !== false && this.inStage(i, k, o.pad || 0)) return false;
    }
    return true;
  }
  claim(i0, i1, k0, k1) { for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) this.claims.add(this.ck(i, k)); }
  cp(i, k, rot = 0, h = this.h(i, k)) { return painter(this.C, i, h, k, rot); }
  fp(i, k, rot = 0, h = this.h(i, k)) { return painter(this.F, 2 * i + 1, 2 * h, 2 * k + 1, rot); }
  light(x, y, z, color, intensity, flicker = 0) { this.lights.push({ pos: new THREE.Vector3(x, y, z), color, intensity, flicker }); }
  emit(spec) { this.emitters.push(spec); }
  /** A random free spot of half-size r (blocks), optionally inside region [i0, i1, k0, k1]. */
  spot(r, region = null, o = {}, tries = 40) {
    const rng = this.rng;
    for (let t = 0; t < tries; t++) {
      const i = region ? Math.round(lerp(region[0], region[1], rng())) : Math.round((rng() * 2 - 1) * (this.HX - r - 1));
      const k = region ? Math.round(lerp(region[2], region[3], rng())) : Math.round((rng() * 2 - 1) * (this.HZ - r - 1));
      if (this.free(i - r, i + r, k - r, k + r, o)) return [i, k];
    }
    return null;
  }
  /** Raise every column under a footprint to height h (water columns become land). */
  footing(i0, i1, k0, k1, h) {
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const c = this.col(i, k);
      if (!c) continue;
      if (c.water) {
        for (let j = c.h; j < c.wl; j++) this.C.del(i, j, k);
        c.water = false;
      }
      for (let j = c.h; j < h; j++) this.C.set(i, j, k, j === h - 1 ? c.top : c.soil);
      if (h > c.h) c.h = h;
    }
  }
  maxH(i0, i1, k0, k1) {
    let m = -99;
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const c = this.col(i, k);
      if (c) m = Math.max(m, c.water ? c.wl : c.h);
    }
    return m === -99 ? 0 : m;
  }
  /** Colour from a palette by smooth noise patches. */
  pal(list, i, k, sc = 0.2, s = 0) {
    const n = noise2(i * sc, k * sc, this.seed + 31 + s) * 0.75 + h3(i, 0, k, this.seed + s) * 0.25;
    return list[Math.min(list.length - 1, Math.floor(n * list.length))];
  }
}

/** Build the column map: shape + heights + water. S = setting definition. */
function shapeIsland(W, S) {
  const { HX, HZ } = W;
  const p = S.shapeP ?? 4;
  const en = S.edgeNoise ?? 0.14;
  for (let i = -HX; i < HX; i++) for (let k = -HZ; k < HZ; k++) {
    const nx = (i + 0.5) / HX, nz = (k + 0.5) / HZ;
    const r = Math.pow(Math.pow(Math.abs(nx), p) + Math.pow(Math.abs(nz), p), 1 / p);
    const edge = 0.96 - (noise2(i * 0.3, k * 0.3, W.seed) - 0.5) * en;
    if (r > edge) continue;
    const rr = r / edge;
    const depth = 2 + Math.floor((1 - rr * rr) * (S.depth ?? 9) + noise2(i * 0.45, k * 0.45, W.seed + 3) * 3.2) + (h3(i, 1, k, W.seed) > 0.9 ? 1 : 0);
    const c = { i, k, rr, h: 0, bottom: -depth, water: false, wl: 0 };
    c.h = S.height ? S.height(W, i, k, rr) : 0;
    const wd = S.water ? S.water(W, i, k, rr) : 0;
    if (wd > 0) { c.water = true; c.wl = c.h; c.h = c.h - wd; }
    W.cols.set(W.ck(i, k), c);
  }
}

/** Fill terrain voxels from the column map. */
function fillTerrain(W, S) {
  const soilD = S.soilDepth ?? 2;
  for (const c of W.cols.values()) {
    const { i, k } = c;
    c.top = S.top(W, i, k, c);
    c.soil = S.soil ? (typeof S.soil === "function" ? S.soil(W, i, k, c) : S.soil) : mulC(c.top, 0.8);
    const edge = c.rr > 0.9;
    for (let j = c.bottom; j < c.h; j++) {
      const d = c.h - 1 - j;
      let color;
      if (c.paint) color = c.paint(j, d);
      if (color == null) {
        if (d === 0) color = c.top;
        else if (d <= soilD) color = edge && d === 1 && S.drip !== false && h3(i, j, k, W.seed) > 0.5 ? mulC(c.top, 0.9) : c.soil;
        else {
          const st = S.stone ? (typeof S.stone === "function" ? S.stone(W, i, j, k) : S.stone) : 0x8a837d;
          const deep = clamp((-j - 3) / 10, 0, 1);
          color = mulC(st, (h3(i, j, k, W.seed + 9) > 0.82 ? 0.88 : 1) * (1 - deep * 0.25));
        }
      }
      W.C.set(i, j, k, color, M_SOLID, 0.05);
    }
    if (c.water) {
      const wc = S.waterColor ?? 0x3b9be0;
      for (let j = c.h; j < c.wl; j++) W.C.set(i, j, k, j === c.wl - 1 ? wc : mulC(wc, 0.8), M_WATER, 0.03);
    }
  }
}

/** Little details scattered on free top cells: grass tufts, pebbles, flowers. */
function sprinkle(W, n, kinds) {
  const rng = W.rng;
  for (let t = 0; t < n; t++) {
    const x = Math.round((rng() * 2 - 1) * W.HX * 2), z = Math.round((rng() * 2 - 1) * W.HZ * 2);
    const i = Math.floor(x / 2), k = Math.floor(z / 2);
    if (!W.inside(i, k) || W.water(i, k) || W.claimed(i, k)) continue;
    const c = W.col(i, k);
    if (c.rr > 0.94) continue;
    const y = c.h * 2;
    if (W.F.has(x, y, z) || W.C.has(i, c.h, k)) continue;
    const kind = kinds[(rng() * kinds.length) | 0];
    if (kind === "tuft") {
      const g = mixC(c.top, 0x2f7a2a, 0.2 + rng() * 0.2);
      W.F.set(x, y, z, g); if (rng() < 0.7) W.F.set(x, y + 1, z, mixC(g, 0xd8f0a0, 0.2));
      if (rng() < 0.5) W.F.set(x + 1, y, z, g);
    } else if (kind === "flower") {
      W.F.set(x, y, z, 0x4f9a3f); W.F.set(x, y + 1, z, 0x4f9a3f);
      W.F.set(x, y + 2, z, FLOWERS[(rng() * FLOWERS.length) | 0], M_SOLID, 0.04);
    } else if (kind === "pebble") {
      W.F.set(x, y, z, mixC(STONE, c.top, 0.2), M_SOLID, 0.1);
    } else if (kind === "snow") {
      W.F.set(x, y, z, 0xf7faff, M_SOLID, 0.02);
    } else if (kind === "reed") {
      for (let j = 0; j < 4 + (rng() * 3 | 0); j++) W.F.set(x, y + j, z, 0x6f8f3a);
      W.F.set(x, y + 6, z, 0x6b4a2a);
    } else if (kind === "shell") {
      W.F.set(x, y, z, rng() < 0.5 ? 0xffb38a : 0xf6f0e6);
    } else if (kind === "glowshroom") {
      W.F.set(x, y, z, 0xd8e6e0); W.F.set(x, y + 1, z, 0x6ff0e0, M_GLOW, 0);
    } else if (kind === "bone") {
      W.F.box(x, x + 2, y, y, z, z, 0xf2ead8);
    }
  }
}

// ---------------------------------------------------------------- reusable models (coarse = blocks) ----

function mTree(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, 0, o.h);
  const th = o.trunk ?? 7 + ((r() * 3) | 0);
  const bark = o.bark ?? 0x7a5236;
  P.box(-1, 0, 0, th, -1, 0, (x, y) => (y % 3 === 0 ? mulC(bark, 0.88) : bark));
  P.set(-2, 0, -1, bark); P.set(1, 0, 0, bark); P.set(0, 0, 1, mulC(bark, 0.9));
  const leaves = o.leaves ?? W.leaves;
  const R = o.r ?? 4.8 + r() * 1.5;
  const lc = (x, y, z, dx, dy) => {
    const c = leaves[(h3(x, y, z, 11) * leaves.length) | 0];
    if (dy > 0.5) return W.snowy ? 0xf3f7ff : mixC(c, 0xfff2b0, 0.18);
    return dy < -0.4 ? mulC(c, 0.82) : c;
  };
  const cy = th + R * 0.5;
  P.ball(0, cy, 0, R, R * 0.8, R, lc, M_LEAF, 0.07, 1.8);
  P.ball(R * 0.62, cy - R * 0.28, R * 0.32, R * 0.62, R * 0.55, R * 0.62, lc, M_LEAF, 0.07, 1.8);
  P.ball(-R * 0.58, cy - R * 0.18, -R * 0.38, R * 0.66, R * 0.6, R * 0.66, lc, M_LEAF, 0.07, 1.8);
  if (o.fruit) for (let n = 0; n < 9; n++) {
    const a = r() * TAU;
    P.set(Math.round(Math.cos(a) * R * 0.92), Math.round(cy - 1 + r() * 2), Math.round(Math.sin(a) * R * 0.92), o.fruit, M_SOLID, 0.04);
  }
}

function mPine(W, i, k, o = {}) {
  const P = W.cp(i, k, 0, o.h);
  const green = o.leaves ?? [0x2f7a4a, 0x2a6e43, 0x378a55];
  const s = o.s ?? 1;
  P.box(-1, 0, 0, 3, -1, 0, 0x6b4a30);
  let y = 2;
  const tiers = o.tiers ?? 4;
  for (let t = 0; t < tiers; t++) {
    const rad = (5.4 - t * 1.05) * s;
    for (let l = 0; l < 3; l++) {
      const rr = rad - l * 0.9;
      const yy = y + l;
      const top = l === 2;
      P.cyl(0, 0, Math.max(rr, 1), yy, yy, (x, _, z) => {
        const c = green[(h3(x, yy, z, 5) * green.length) | 0];
        return W.snowy && (top || h3(x, yy, z, 6) > 0.7) ? 0xf3f7ff : top ? mixC(c, 0xcfe8a0, 0.1) : c;
      }, M_LEAF, 0.05);
    }
    y += 2;
  }
  P.box(-1, 0, y + 1, y + 2, -1, 0, W.snowy ? 0xf3f7ff : green[0], M_LEAF);
}

function mPalm(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, 0, o.h);
  const lean = o.lean ?? (r() < 0.5 ? 1 : -1);
  const H = 10 + ((r() * 3) | 0);
  let x = 0;
  for (let y = 0; y < H; y++) { x = Math.round(lean * y * y * 0.03); P.set(x, y, 0, y % 2 ? 0xa8875a : 0x8a6a42); P.set(x - 1, y, 0, y % 2 ? 0x9a7b50 : 0x80603c); }
  const leaf = [0x4fae45, 0x3f9a3c, 0x5cbc4c];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [dx, dz] of dirs) for (let s = 1; s <= 6; s++) {
    const yy = H + 1 - Math.floor(s * s * 0.1);
    const c = leaf[(s + dx + 3) % 3];
    P.set(x + dx * s, yy, dz * s, c, M_LEAF);
    if (s > 1 && s < 6) P.set(x + dx * s + (dz ? 0 : 0), yy, dz * s + (dx && !dz ? 1 : 0), c, M_LEAF);
  }
  P.box(x - 1, x + 1, H, H + 1, -1, 1, leaf[0], M_LEAF);
  P.set(x + 1, H - 1, 0, 0x5c3d20); P.set(x - 1, H - 1, 1, 0x5c3d20); P.set(x, H - 1, -1, 0x6b4a2a);
}

function mRock(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, 0, o.h);
  const R = o.r ?? 1.6 + r() * 1.5;
  const base = o.color ?? W.rockC ?? STONE;
  const moss = o.moss !== undefined ? o.moss : W.snowy ? 0xf2f6fc : W.mossC;
  P.ball(r() - 0.5, R * 0.3, r() - 0.5, R * 1.1, R * 0.85, R, (x, y, z, dx, dy) => (dy > 0.55 && moss ? moss : h3(x, y, z, 3) > 0.8 ? mulC(base, 0.85) : base), M_SOLID, 0.07);
}

function mBush(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, 0, o.h);
  const R = o.r ?? 1.8 + r() * 0.8;
  const leaves = o.leaves ?? W.leaves;
  const dots = o.dots ?? (r() < 0.5 ? FLOWERS[(r() * FLOWERS.length) | 0] : 0xd23c4a);
  P.ball(0, R * 0.55, 0, R * 1.15, R * 0.85, R, (x, y, z, dx, dy) => {
    if (W.snowy && dy > 0.5) return 0xf3f7ff;
    if (h3(x, y, z, 21) > 0.9) return dots;
    return leaves[(h3(x, y, z, 4) * leaves.length) | 0];
  }, M_LEAF, 0.06);
}

function mCactus(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, (r() * 4) | 0, o.h);
  const g = [0x4f9a4a, 0x5aa652];
  const H = 6 + ((r() * 3) | 0);
  const c = (x, y, z) => g[(x + z + y) & 1];
  P.box(-1, 0, 0, H, -1, 0, c);
  P.box(1, 2, 3, 3, -1, 0, c); P.box(2, 2, 3, 5, -1, 0, c);
  if (r() < 0.7) { P.box(-3, -2, 2, 2, -1, 0, c); P.box(-3, -3, 2, 4, -1, 0, c); }
  P.set(0, H + 1, 0, 0xff7fb0); P.set(-1, H + 1, -1, 0xffd23f);
}

function mHouse(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const rot = o.rot || 0;
  const P = W.cp(i, k, rot, o.h);
  const w = o.w ?? 4, d = o.d ?? 3, hh = o.wh ?? 5;
  const style = o.style ?? "cottage";
  const wall = o.wall ?? (style === "town" ? [0xe9d3b0, 0xd9a18a, 0xbfd0e0, 0xe8e0c8][(r() * 4) | 0] : WHITE);
  const trim = o.trim ?? (style === "cottage" ? 0x6e4a2c : 0x8a8178);
  const roof = o.roof ?? (style === "thatch" ? 0xd9b45a : [0xc4473f, 0x9c4a3a, 0x4a6aa8, 0x6a5a8a][(r() * 4) | 0]);
  const lit = W.dark;
  P.box(-w, w - 1, 0, hh - 1, -d, d - 1, (x, y, z) => {
    const corner = (x === -w || x === w - 1) && (z === -d || z === d - 1);
    if (y === 0) return STONE_D;
    if (corner || (style === "cottage" && y === hh - 1)) return trim;
    return wall;
  });
  // windows (front + sides) and door
  const win = lit ? LAMP : 0x9fd3f2;
  const wm = lit ? M_GLOW : M_SOLID;
  for (const x of [-w + 1, w - 2]) { P.box(x, x, 2, 3, d - 1, d - 1, win, wm, 0); P.set(x, 1, d, trim); }
  P.box(-w, -w, 2, 3, -1, 0, win, wm, 0); P.box(w - 1, w - 1, 2, 3, -1, 0, win, wm, 0);
  P.box(-1, 0, 0, 2, d - 1, d - 1, 0x6b3f22); P.set(0, 1, d, 0xf0c040, M_SOLID, 0);
  // stepped gable roof
  for (let t = 0; ; t++) {
    const z0 = -d - 1 + t, z1 = d - t;
    if (z0 > z1) break;
    const rc = (x, y, z) => (W.snowy ? 0xf3f7ff : (x + y) % 3 === 0 ? mulC(roof, 0.9) : roof);
    P.box(-w - 1, w, hh + t, hh + t, z0, z0, rc);
    P.box(-w - 1, w, hh + t, hh + t, z1, z1, rc);
    if (z1 - z0 > 1) { P.box(-w, -w, hh + t, hh + t, z0 + 1, z1 - 1, wall); P.box(w - 1, w - 1, hh + t, hh + t, z0 + 1, z1 - 1, wall); }
  }
  if (o.chimney !== false) {
    const cx = w - 2;
    P.box(cx, cx, hh, hh + d + 2, -2, -2, 0x8a5a4a);
    if (W.dark || r() < 0.6) {
      const [wx, wz] = rotXZ(rot, cx + 0.5, -1.5);
      W.emit({ kind: "puff", count: 14, center: [(i + wx) * 2, (W.h(i, k) + hh + d + 3) * 2 + 12, (k + wz) * 2], box: [8, 26, 8], vel: [1.2, 3, 0], size: [5, 9], colors: [0xdddddd, 0xcfcfcf], wob: 1.2, opacity: 0.55 });
    }
  }
  if (lit) {
    const [wx, wz] = rotXZ(rot, 0, d + 1.5);
    W.light((i + wx) * 2, (W.h(i, k) + 3) * 2, (k + wz) * 2, 0xffb35a, 1);
  }
}
/** Rotate a local offset (blocks) like painter() does, for positions of lights/emitters. */
function rotXZ(rot, x, z) {
  rot = ((rot % 4) + 4) % 4;
  return rot === 0 ? [x, z] : rot === 1 ? [z, -x] : rot === 2 ? [-x, -z] : [-z, x];
}

/** Street lamp (fine). */
function mLamp(W, i, k, o = {}) {
  const P = W.fp(i, k, o.rot || 0, o.h);
  const pole = o.pole ?? 0x2f323a;
  const on = W.dark || o.on;
  P.box(-2, 1, 0, 1, -2, 1, pole);
  P.box(-1, 0, 2, 24, -1, 0, pole);
  P.box(-3, 2, 25, 25, -3, 2, pole);
  P.box(-2, 1, 26, 29, -2, 1, on ? LAMP : 0xfff3d6, on ? M_GLOW : M_SOLID, 0);
  for (const [x, z] of [[-3, -3], [2, -3], [-3, 2], [2, 2]]) P.box(x, x, 26, 29, z, z, pole);
  P.box(-3, 2, 30, 30, -3, 2, pole); P.box(-2, 1, 31, 31, -2, 1, pole); P.box(-1, 0, 32, 33, -1, 0, pole);
  W.light(2 * i + 1, W.h(i, k) * 2 + 28, 2 * k + 1, 0xffc070, on ? 1 : 0.15);
}

/** Wooden fence between two unit points along x or z (fine). */
function mFenceLine(W, x0, z0, x1, z1, o = {}) {
  const c = o.color ?? WOOD_L, cd = mulC(c, 0.82);
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 6));
  const pts = [];
  for (let s = 0; s <= n; s++) pts.push([Math.round(lerp(x0, x1, s / n)), Math.round(lerp(z0, z1, s / n))]);
  for (let s = 0; s <= n; s++) {
    const [x, z] = pts[s];
    const i = Math.floor(x / 2), kk = Math.floor(z / 2);
    if (!W.inside(i, kk)) continue;
    const y = W.groundU(x, z);
    W.F.box(x, x + 1, y, y + 8, z, z + 1, cd);
    W.F.set(x, y + 9, z, cd); W.F.set(x + 1, y + 9, z + 1, cd);
    if (s < n) {
      const [nx, nz] = pts[s + 1];
      for (const ry of [3, 6]) {
        const steps = Math.max(Math.abs(nx - x), Math.abs(nz - z));
        for (let q = 1; q < steps; q++) {
          const xx = Math.round(lerp(x, nx, q / steps)), zz = Math.round(lerp(z, nz, q / steps));
          const gy = W.groundU(xx, zz);
          if (!W.inside(Math.floor(xx / 2), Math.floor(zz / 2))) continue;
          W.F.set(xx, Math.max(y, gy) + ry, zz, c); W.F.set(xx + (nz !== z ? 1 : 0), Math.max(y, gy) + ry, zz + (nx !== x ? 1 : 0), c);
        }
      }
    }
  }
}

/** A cluster of flowers (fine) around block (i,k). */
function mFlowerPatch(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const cols = o.colors ?? FLOWERS;
  const n = o.n ?? 7;
  for (let t = 0; t < n; t++) {
    const x = 2 * i + 1 + Math.round((r() * 2 - 1) * (o.spread ?? 4)), z = 2 * k + 1 + Math.round((r() * 2 - 1) * (o.spread ?? 4));
    if (!W.inside(Math.floor(x / 2), Math.floor(z / 2)) || W.water(Math.floor(x / 2), Math.floor(z / 2))) continue;
    const y = W.groundU(x, z);
    const hgt = 2 + ((r() * 3) | 0);
    const pc = cols[(r() * cols.length) | 0];
    W.F.box(x, x, y, y + hgt - 1, z, z, 0x4f9a3f);
    W.F.set(x + 1, y + 1, z, 0x5aa648);
    W.F.set(x, y + hgt, z, 0xffd23f, M_SOLID, 0);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) W.F.set(x + dx, y + hgt, z + dz, pc, M_SOLID, 0.05);
    W.F.set(x, y + hgt + 1, z, pc, M_SOLID, 0.05);
  }
}

function mMushroom(W, x, z, o = {}) {
  const y = W.groundU(x, z);
  const s = o.s ?? 1;
  const cap = o.cap ?? 0xd8353c;
  const P = painter(W.F, x, y, z, 0);
  const sh = Math.round(4 * s), cr = 3.5 * s;
  P.box(-1, 0, 0, sh, -1, 0, 0xf1e8d8);
  P.ball(0, sh + 1, 0, cr, cr * 0.62, cr, (xx, yy, zz, dx, dy) => (dy < -0.2 ? 0xf3e6cf : h3(xx, yy, zz, 8) > 0.78 && dy > 0.1 ? 0xfdf6ea : cap), o.glow ? M_GLOW : M_SOLID, 0.04);
}

/** Wall torch (fine) at unit position facing +z (or +x when side=true). */
function mTorch(W, x, y, z, side = false) {
  const F = W.F;
  if (side) { F.box(x, x + 2, y, y, z, z, WOOD_D); F.box(x + 2, x + 2, y + 1, y + 2, z, z, WOOD_D); F.set(x + 2, y + 3, z, FLAME[1], M_GLOW, 0); F.set(x + 2, y + 4, z, FLAME[0], M_GLOW, 0); }
  else { F.box(x, x, y, y, z, z + 2, WOOD_D); F.box(x, x, y + 1, y + 2, z + 2, z + 2, WOOD_D); F.set(x, y + 3, z + 2, FLAME[1], M_GLOW, 0); F.set(x, y + 4, z + 2, FLAME[0], M_GLOW, 0); }
  W.light(x + (side ? 3 : 0.5), y + 5, z + (side ? 0.5 : 3), 0xff9a40, 0.8, 1);
}

/** Banner on a pole (fine). */
function mBanner(W, x, z, color, o = {}) {
  const y = W.groundU(x, z);
  const H = o.h ?? 30;
  W.F.box(x, x + 1, y, y + H, z, z + 1, WOOD_D);
  W.F.set(x, y + H + 1, z, GOLD, M_SOLID, 0); W.F.set(x + 1, y + H + 1, z + 1, GOLD, M_SOLID, 0);
  const em = o.emblem ?? GOLD;
  for (let yy = 0; yy < 12; yy++) for (let xx = 0; xx < 8; xx++) {
    if (yy < 2 && (xx === 0 || xx === 7)) continue;
    if (yy === 0 && (xx % 3 === 1)) continue;
    const cy = y + H - 13 + yy;
    const emb = Math.abs(xx - 3.5) + Math.abs(yy - 6) < 2.6;
    W.F.set(x + 2 + xx, cy, z, emb ? em : color, M_SOLID, 0.03);
  }
}

/** Stone column (coarse): base, shaft, capital. */
function mColumn(W, i, k, H, o = {}) {
  const P = W.cp(i, k, 0, o.h);
  const c = o.color ?? WHITE, cap = o.cap ?? c;
  P.box(-2, 1, 0, 0, -2, 1, mulC(c, 0.92));
  P.box(-1, 0, 1, H - 2, -1, 0, (x, y) => (y % 2 ? c : mulC(c, 0.96)));
  P.box(-2, 1, H - 1, H - 1, -2, 1, cap);
}

// ---------------------------------------------------------------- props (SCENE_PROPS) ----
// Each prop draws around block (i, k) on ground height o.h (already levelled by the placer).
// Fine painters: 1 unit = 1 character voxel; a character is ~24 units tall and ~14 wide.

function pTable(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const wood = o.wood ?? WOOD_L, cloth = r() < 0.5 ? [0xf3efe7, 0xd9e8f5, 0xf2d9d9][(r() * 3) | 0] : -1;
  for (const [x, z] of [[-6, -4], [5, -4], [-6, 3], [5, 3]]) P.box(x, x, 0, 8, z, z, mulC(wood, 0.82));
  P.box(-7, 6, 9, 9, -5, 4, cloth >= 0 ? cloth : wood);
  if (cloth >= 0) { P.box(-7, 6, 8, 8, -5, -5, cloth); P.box(-7, 6, 8, 8, 4, 4, cloth); P.box(-7, -7, 8, 8, -5, 4, cloth); P.box(6, 6, 8, 8, -5, 4, cloth); }
  P.box(-4, -3, 10, 11, -1, 0, WHITE); P.set(-4, 12, -1, 0x7a4a2a);
  P.box(1, 4, 10, 10, -2, 1, 0xe8e2d6); P.set(2, 11, -1, 0xd8343c); P.set(3, 11, 0, 0x8ac24a); P.set(2, 11, 0, 0xffb02e);
}

function pChair(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const wood = r() < 0.5 ? WOOD : 0x6e4a2c, cush = [0xc8343c, 0x3a6ea5, 0x4f8a4a][(r() * 3) | 0];
  for (const [x, z] of [[-3, -3], [2, -3], [-3, 2], [2, 2]]) P.box(x, x, 0, 5, z, z, wood);
  P.box(-3, 2, 6, 6, -3, 2, cush);
  P.box(-3, 2, 7, 14, -3, -3, (x, y) => (y === 14 || x === -3 || x === 2 ? wood : mixC(wood, cush, 0.35)));
}

function pBench(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const wood = WOOD_L;
  for (const x of [-8, 7]) { P.box(x, x, 0, 5, -2, -2, IRON); P.box(x, x, 0, 5, 2, 2, IRON); P.box(x, x, 6, 11, -3, -3, IRON); P.box(x, x, 6, 7, -2, 2, IRON); }
  P.box(-9, 8, 5, 5, -2, 2, (x, y, z) => (z % 2 ? wood : mulC(wood, 0.9)));
  P.box(-9, 8, 8, 8, -3, -3, wood); P.box(-9, 8, 10, 10, -3, -3, wood);
}

function pChest(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const body = 0x8a4f2a;
  P.box(-5, 4, 0, 5, -3, 3, (x, y, z) => (x === -5 || x === 4 || y === 0 ? GOLD : z === 3 && (x === -2 || x === 1) ? GOLD : body), M_SOLID, 0.04);
  P.box(-4, 3, 5, 5, -2, 2, 0xffd85a, M_GLOW, 0);
  P.box(-5, 4, 6, 12, -5, -4, (x, y) => (x === -5 || x === 4 || y === 12 ? GOLD : body));
  P.box(-1, 0, 3, 4, 4, 4, 0xe8c040, M_SOLID, 0);
  P.set(-2, 6, 0, 0xffe27a, M_GLOW, 0); P.set(1, 6, -1, 0xff6a8a, M_GLOW, 0); P.set(2, 6, 1, 0x7ad8ff, M_GLOW, 0);
  const [dx, dz] = rotXZ(o.rot, 0, 0);
  W.emit({ kind: "sparkle", count: 18, center: [2 * i + 1 + dx, o.h * 2 + 12, 2 * k + 1 + dz], box: [12, 14, 10], vel: [0, 1.2, 0], size: [2.5, 4.5], colors: [0xffe27a, 0xfff2c0], wob: 0.6, additive: true, intensity: 2.2 });
  W.light(2 * i + 1, o.h * 2 + 9, 2 * k + 1, 0xffc850, 0.6);
}

function pCake(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  P.cyl(0, 0, 1.5, 0, 6, 0xb98a52); P.cyl(0, 0, 6.5, 7, 7, WHITE);
  P.cyl(0, 0, 4.8, 8, 11, (x, y) => (y === 11 ? 0xffe4ec : y === 9 ? 0xff9fb8 : 0xfff3e0));
  P.cyl(0, 0, 3.2, 12, 14, (x, y) => (y === 14 ? 0xffe4ec : 0xffc0d0));
  for (const [x, z] of [[-2, -1], [1, 0], [-1, 1]]) { P.box(x, x, 15, 16, z, z, [0x7ad8ff, 0xffd23f, 0xff7fb0][(x + 3) % 3]); P.set(x, 17, z, FLAME[0], M_GLOW, 0); }
  P.set(3, 12, 2, 0xd8253c); P.set(-4, 12, -2, 0xd8253c); P.set(4, 11, -3, 0xd8253c);
  W.light(2 * i + 1, o.h * 2 + 20, 2 * k + 1, 0xffb050, 0.35, 1);
}

function pCandles(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  P.box(-2, 1, 0, 0, -2, 1, GOLD); P.box(-1, 0, 1, 12, -1, 0, GOLD);
  P.box(-5, 4, 12, 12, -1, 0, GOLD);
  for (const x of [-5, -1, 3]) {
    const hgt = x === -1 ? 6 : 4;
    P.box(x, x + 1, 13, 13 + hgt, -1, 0, 0xfaf3e0);
    P.set(x, 14 + hgt, -1, FLAME[0], M_GLOW, 0); P.set(x + 1, 14 + hgt, 0, FLAME[1], M_GLOW, 0); P.set(x, 15 + hgt, 0, FLAME[0], M_GLOW, 0);
  }
  W.light(2 * i + 1, o.h * 2 + 22, 2 * k + 1, 0xffb050, 0.8, 1);
}

function pRose(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  if (W.setting === "space") {
    // the rose under a glass globe
    P.cyl(0, 0, 4, 0, 0, 0x9a8f86);
    P.box(-1, 0, 1, 7, -1, -1, 0x3f8f3a); P.box(1, 2, 4, 4, -1, -1, 0x4fa040); P.box(-3, -2, 3, 3, -1, -1, 0x4fa040);
    P.ball(-0.5, 9, -0.5, 2.2, 2, 2.2, (x, y) => (y > 9 ? 0xe8303c : 0xc81e30), M_SOLID, 0.05);
    P.ball(0, 6, 0, 5, 7.5, 5, 0xcfe8ff, M_GLASS, 0, 1);
    return;
  }
  for (let n = 0; n < 6; n++) {
    const x = Math.round((r() - 0.5) * 7), z = Math.round((r() - 0.5) * 6), hgt = 4 + ((r() * 5) | 0);
    P.box(x, x, 0, hgt, z, z, 0x3f8f3a);
    P.set(x + 1, hgt - 2, z, 0x4fa040); P.set(x - 1, hgt - 3, z, 0x4fa040);
    P.box(x - 1, x + 1, hgt + 1, hgt + 2, z - 1, z + 1, (xx, yy, zz) => ((xx + zz + yy) % 2 ? 0xd8253c : 0xb81a30), M_SOLID, 0.04);
  }
  P.ball(0, 2, 0, 4.5, 3, 4, (x, y, z) => (h3(x, y, z, 2) > 0.5 ? 0x3f8f3a : 0x4fa040), M_LEAF, 0.05);
}

function pFire(W, i, k, o) {
  const P = W.fp(i, k, 0, o.h);
  for (let a = 0; a < 10; a++) { const x = Math.round(Math.cos(a / 10 * TAU) * 5), z = Math.round(Math.sin(a / 10 * TAU) * 5); P.box(x - 1, x, 0, 1, z - 1, z, a % 2 ? STONE : STONE_D, M_SOLID, 0.1); }
  P.box(-4, 3, 0, 1, -1, 0, WOOD_D); P.box(-1, 0, 0, 1, -4, 3, 0x6b4426); P.box(-3, 2, 2, 2, -2, 1, 0x50301a);
  P.ball(-0.5, 3, -0.5, 2.8, 2.2, 2.8, FLAME[1], M_GLOW, 0);
  P.ball(-0.5, 5.5, -0.5, 1.8, 2.6, 1.8, FLAME[0], M_GLOW, 0);
  P.box(-1, 0, 7, 8, -1, 0, 0xffe9a8, M_GLOW, 0);
  P.set(1, 4, 1, FLAME[2], M_GLOW, 0); P.set(-2, 4, -2, FLAME[2], M_GLOW, 0);
  W.light(2 * i + 1, o.h * 2 + 9, 2 * k + 1, 0xff8a3a, 1.6, 2);
  W.emit({ kind: "dot", count: 26, center: [2 * i + 1, o.h * 2 + 16, 2 * k + 1], box: [8, 24, 8], vel: [0, 7, 0], size: [0.9, 1.6], colors: [0xffb040, 0xff7a2a, 0xffe08a], wob: 1.5, additive: true, intensity: 3 });
}

function pFountain(W, i, k, o) {
  const P = W.cp(i, k, 0, o.h);
  const st = 0xd8d2c8;
  P.cyl(0, 0, 4.6, 0, 0, (x, y, z, dx, dz) => (dx * dx + dz * dz > 3.4 * 3.4 ? st : -1));
  P.cyl(0, 0, 4.6, 1, 1, (x, y, z, dx, dz) => (dx * dx + dz * dz > 3.6 * 3.6 ? mulC(st, 0.95) : -1));
  P.cyl(0, 0, 3.7, 0, 0, (x, y, z, dx, dz) => (dx * dx + dz * dz <= 3.4 * 3.4 ? 0x5fb8e8 : -1), M_WATER);
  const F = W.fp(i, k, 0, o.h);
  F.box(-1, 0, 2, 12, -1, 0, st); F.cyl(0, 0, 3.6, 12, 12, st); F.cyl(0, 0, 3, 13, 13, (x, y, z, dx, dz) => (dx * dx + dz * dz > 4 ? st : 0x7fd0f5), M_SOLID);
  F.box(-1, 0, 14, 16, -1, 0, st); F.set(-1, 17, -1, 0x9fe0ff, M_GLOW, 0);
  W.emit({ kind: "dot", count: 40, center: [2 * i + 1, o.h * 2 + 12, 2 * k + 1], box: [10, 16, 10], vel: [0, -9, 0], size: [0.8, 1.4], colors: [0xcfefff, 0x9fd8ff], wob: 0.4, opacity: 0.85, intensity: 1.2 });
}

function pWell(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  P.cyl(0, 0, 6, 0, 6, (x, y, z, dx, dz) => (dx * dx + dz * dz > 20 ? ((x + y + z) % 3 ? STONE : STONE_D) : y === 5 ? 0x1f3550 : -1), M_SOLID, 0.08);
  P.box(-6, -5, 7, 20, -1, 0, WOOD); P.box(4, 5, 7, 20, -1, 0, WOOD);
  P.box(-6, 5, 15, 15, -1, -1, WOOD_D);
  for (let t = 0; t < 5; t++) P.box(-8 + t, 7 - t, 21 + t, 21 + t, -4 + t, 3 - t, W.snowy ? 0xf3f7ff : 0xb8423a);
  P.box(-1, 0, 9, 11, -1, 0, 0x8a6a4a); P.box(-1, 0, 12, 14, -1, -1, 0x6b4a2a);
}

function pBridge(W, i, k, o) {
  // carve a little stream under the bridge
  for (let dx = -2; dx <= 1; dx++) for (let dz = -6; dz <= 5; dz++) {
    const c = W.col(i + dx, k + dz);
    if (!c || c.water || c.rr > 0.97) continue;
    W.C.del(i + dx, c.h - 1, k + dz);
    W.C.set(i + dx, c.h - 2, k + dz, 0xcdbb8a);
    W.C.set(i + dx, c.h - 1, k + dz, 0x3b9be0, M_WATER, 0.03);
    c.water = true; c.wl = c.h; c.h -= 1;
  }
  const P = W.cp(i, k, 0, o.h);
  const plank = WOOD_L;
  for (let dx = -6; dx <= 5; dx++) {
    const y = Math.round(2.2 * Math.sin(Math.PI * (dx + 6.5) / 13));
    P.box(dx, dx, y, y, -2, 1, (x, yy, z) => (x % 2 ? plank : mulC(plank, 0.88)));
    if (y > 0) P.box(dx, dx, 0, y - 1, -2, -2, -1);
    if (dx % 2 === 0) { P.box(dx, dx, y + 1, y + 2, -2, -2, WOOD); P.box(dx, dx, y + 1, y + 2, 1, 1, WOOD); }
  }
}

function pTent(W, i, k, o) {
  const P = W.cp(i, k, o.rot, o.h);
  const a = [0xd8343c, 0xf3efe7], b = [0x3a6ea5, 0xf3efe7];
  const cols = o.rng() < 0.5 ? a : b;
  for (let y = 0; y <= 5; y++) {
    const hw = 5 - y;
    P.box(-hw - 1, hw, y, y, -4, 3, (x, yy, z) => {
      const inner = x > -hw - 1 && x < hw;
      if (inner && z === 3 && y < 3 && Math.abs(x + 0.5) < 2) return 0x2a1d18;
      if (inner && z > -4 && z < 3) return -1;
      return cols[((x + 20) >> 1) & 1];
    });
  }
  P.box(-1, 0, 6, 8, -1, -1, WOOD_D); P.box(-1, 1, 8, 8, 0, 0, 0xffd23f);
}

function pCrystal(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const cols = r() < 0.5 ? [0x8fe8ff, 0x5fc8ff, 0xc9f4ff] : [0xc89bff, 0xa070ff, 0xe8d0ff];
  const shards = [[0, 0, 16, 2.2], [-4, 2, 10, 1.6], [4, 1, 11, 1.7], [-1, -4, 8, 1.4], [3, -3, 7, 1.3]];
  for (const [x, z, hgt, rad] of shards) {
    for (let y = 0; y < hgt; y++) {
      const rr = y > hgt - 4 ? rad * (hgt - y) / 4 : rad;
      P.cyl(x, z, Math.max(rr, 0.6), y, y, cols[(y + x + 9) % cols.length], M_GLOW, 0.06);
    }
  }
  P.cyl(0, 0, 5, 0, 0, STONE_D);
  W.light(2 * i + 1, o.h * 2 + 10, 2 * k + 1, cols === null ? 0 : cols[1], 0.9);
  W.emit({ kind: "sparkle", count: 14, center: [2 * i + 1, o.h * 2 + 12, 2 * k + 1], box: [14, 18, 14], vel: [0, 1.5, 0], size: [2, 3.5], colors: [cols[2]], wob: 1, additive: true, intensity: 2 });
}

function pClock(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const z0 = o.wall ? -1 : -3;
  const wood = 0x6a3f22;
  P.box(-4, 3, 0, 27, z0, z0 + 5, (x, y, z) => (y === 27 || y === 0 || x === -4 || x === 3 ? mulC(wood, 0.85) : wood));
  P.box(-5, 4, 28, 29, z0, z0 + 5, mulC(wood, 0.8)); P.box(-2, 1, 30, 31, z0 + 1, z0 + 4, mulC(wood, 0.8));
  P.box(-3, 2, 18, 24, z0 + 6, z0 + 6, (x, y) => (x === -3 || x === 2 || y === 18 || y === 24 ? GOLD : 0xfbf6ea));
  P.box(-1, -1, 21, 23, z0 + 7, z0 + 7, 0x222222); P.box(-1, 1, 21, 21, z0 + 7, z0 + 7, 0x222222);
  P.box(-2, 1, 5, 14, z0 + 6, z0 + 6, 0x3a2412); P.box(-1, 0, 6, 12, z0 + 7, z0 + 7, GOLD); P.box(-2, 1, 6, 7, z0 + 7, z0 + 7, GOLD);
}

function pPiano(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const blk = 0x1d1c22;
  for (const [x, z] of [[-7, 3], [6, 3], [5, -6]]) P.box(x, x + 1, 0, 6, z, z + 1, blk);
  P.box(-8, 8, 7, 10, -3, 5, blk, M_SOLID, 0.02);
  P.box(-8, 2, 7, 10, -8, -4, blk, M_SOLID, 0.02); P.box(-8, -3, 7, 10, -10, -9, blk, M_SOLID, 0.02);
  P.box(-8, 8, 8, 8, 6, 7, WHITE, M_SOLID, 0.02);
  for (let x = -7; x <= 7; x += 2) if (x % 6 !== 1) P.set(x, 9, 6, blk);
  for (let t = 0; t < 8; t++) P.box(-8 + Math.floor(t * 0.4), 6 - t, 11 + t, 11 + t, -8 + t, -8 + t, blk);
  P.box(-6, 5, 0, 4, 10, 12, blk); P.box(-6, 5, 5, 5, 10, 12, 0x6a2a3a);
  P.box(-2, 1, 12, 13, 5, 5, 0xf3efe7);
}

function pStatue(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const c = r() < 0.5 ? 0xe8e4dc : 0x6f9a86;
  P.box(-5, 4, 0, 5, -5, 4, STONE); P.box(-6, 5, 6, 6, -6, 5, STONE_D);
  P.box(-3, -1, 7, 13, -1, 1, c); P.box(0, 2, 7, 13, -1, 1, c);
  P.box(-4, 3, 14, 21, -2, 2, c);
  P.box(-6, -5, 15, 21, -1, 1, c); P.box(4, 5, 19, 27, -1, 1, c); P.box(4, 6, 28, 29, -1, 1, c);
  P.box(-3, 2, 22, 27, -3, 2, c);
  P.box(-3, 2, 28, 28, -3, 2, mulC(c, 0.92));
}

function pThrone(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const red = 0xa81e34;
  P.box(-8, 7, 0, 1, -6, 7, 0x8a1a2c); P.box(-7, 6, 2, 2, -5, 6, GOLD);
  P.box(-6, 5, 3, 7, -4, 4, GOLD); P.box(-5, 4, 8, 8, -3, 4, red);
  P.box(-6, 5, 8, 26, -5, -4, (x, y) => (x === -6 || x === 5 || y === 26 ? GOLD : red));
  for (const x of [-6, 5]) { P.box(x, x, 9, 12, -3, 4, GOLD); P.set(x, 27, -5, GOLD); P.set(x, 28, -5, 0xffe08a, M_SOLID, 0); }
  P.box(-2, 1, 27, 29, -5, -5, GOLD); P.set(-1, 30, -5, 0xff3a5a, M_SOLID, 0); P.set(0, 30, -5, 0x3a8aff, M_SOLID, 0);
}

function pBed(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const frame = 0x7a4a2a, blanket = [0x3a6ea5, 0xc8343c, 0x6a9a4a, 0x8a5aa8][(r() * 4) | 0];
  P.box(-7, 6, 0, 3, -9, 8, frame);
  P.box(-6, 5, 4, 5, -8, 7, WHITE);
  P.box(-7, 6, 5, 6, -2, 8, (x, y, z) => ((x + z) % 4 === 0 ? mixC(blanket, WHITE, 0.4) : blanket));
  P.box(-5, 4, 6, 7, -8, -5, 0xfbf8f2);
  P.box(-7, 6, 0, 13, -10, -10, (x, y) => (y === 13 || x === -7 || x === 6 ? mulC(frame, 0.85) : frame));
  P.box(-7, 6, 0, 7, 9, 9, frame);
}

function pDesk(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const wood = 0x7a4a2a;
  P.box(-7, 6, 9, 9, -4, 3, wood);
  P.box(-7, -3, 0, 8, -4, 3, mulC(wood, 0.9)); P.box(4, 6, 0, 8, -4, 3, mulC(wood, 0.9));
  P.set(-5, 6, 4, GOLD); P.set(-5, 3, 4, GOLD);
  P.box(-2, 3, 10, 10, -1, 2, WHITE); P.box(0, 0, 10, 10, -1, 2, 0xd8d0c0);
  P.box(4, 5, 10, 11, -2, -1, 0x1a1a22); P.set(5, 12, -2, WHITE); P.set(6, 13, -2, WHITE);
  P.box(-6, -4, 10, 10, -3, 0, 0x8a2a2a); P.box(-6, -4, 11, 11, -3, 0, 0x2a4a8a); P.box(-6, -4, 12, 12, -2, 0, 0x3a7a4a);
  P.box(-6, -6, 13, 15, 2, 2, 0xfaf3e0); P.set(-6, 16, 2, FLAME[0], M_GLOW, 0);
  W.light(2 * i + 1, o.h * 2 + 18, 2 * k + 1, 0xffb050, 0.5, 1);
}

function pWindow(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const lit = W.dark;
  const glass = lit ? 0xffcf7a : 0xbfe6ff;
  const z = o.wall ? -1 : 0;
  const frame = o.wall ? WHITE : WOOD;
  const y0 = o.wall ? 8 : 3;
  if (!o.wall) { P.box(-5, 4, 0, 2, -2, 1, STONE); }
  for (let y = 0; y <= 15; y++) for (let x = -6; x <= 5; x++) {
    const ax = Math.abs(x + 0.5);
    const arch = y > 11 ? Math.sqrt(Math.max(0, 36 - (y - 11) * (y - 11) * 2.2)) : 6;
    if (ax > arch) continue;
    const edge = ax > arch - 1.2 || y === 0 || ax < 0.6 || y === 8;
    P.set(x, y0 + y, z, edge ? frame : glass, edge ? M_SOLID : M_GLOW, edge ? 0.04 : 0.02);
  }
  if (!o.wall) W.light(2 * i + 1, o.h * 2 + 12, 2 * k + 3, lit ? 0xffb050 : 0xcfe8ff, lit ? 0.6 : 0.2);
}

function pDoor(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const z = o.wall ? -1 : -1;
  if (!o.wall) P.box(-8, 7, 0, 0, -3, 2, STONE_D);
  for (let y = 0; y <= 24; y++) for (let x = -8; x <= 7; x++) {
    const ax = Math.abs(x + 0.5);
    const arch = y > 18 ? Math.sqrt(Math.max(0, 64 - (y - 18) * (y - 18) * 1.6)) : 8;
    if (ax > arch) continue;
    const frame = ax > arch - 2 || (y === 0 && !o.wall);
    if (frame) { P.box(x, x, y, y, z - 1, z + 1, (x + y) % 3 ? STONE : STONE_D); continue; }
    const doorX = x - (-6);
    const open = doorX < 4;
    if (open) P.set(x, y, z, 0xfff0b0, M_GLOW, 0.02);
    else P.set(x, y, z + (doorX < 6 ? 2 : 1), (x % 3 === 0 ? 0x6b3a1e : 0x7d4a26));
  }
  P.set(3, 10, z + 3, GOLD, M_SOLID, 0);
  W.light(2 * i + 1, o.h * 2 + 10, 2 * k + 4, 0xffe0a0, 0.9);
}

function pSign(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  P.box(-1, 0, 0, 15, -1, 0, WOOD_D);
  P.box(-6, 6, 11, 15, 1, 1, (x, y) => (x === -6 || x === 6 || y === 11 || y === 15 ? WOOD : WOOD_L));
  P.set(7, 13, 1, WOOD_L); P.box(-4, 3, 13, 13, 2, 2, 0x4a3020); P.box(-4, 0, 12, 12, 2, 2, 0x4a3020);
  P.box(-7, 4, 6, 9, 1, 1, (x) => (x === -7 ? -1 : WOOD_L)); P.set(-7, 7, 1, WOOD_L); P.set(-7, 8, 1, WOOD_L);
}

function pTelescope(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  P.line(0, 13, 0, -5, 0, 4, WOOD); P.line(0, 13, 0, 5, 0, 4, WOOD); P.line(0, 13, 0, 0, 0, -5, WOOD);
  P.box(-1, 0, 13, 14, -1, 0, GOLD);
  P.line(-4, 11, 4, 5, 20, -5, 0xc89a4a, M_SOLID, 0.02, 1);
  P.line(5, 20, -5, 7, 22, -7, GOLD, M_SOLID, 0, 2);
  P.box(-5, -4, 10, 11, 4, 5, 0x3a3a3a);
}

function pCauldron(W, i, k, o) {
  const P = W.fp(i, k, 0, o.h);
  const iron = 0x2a2a32;
  P.box(-4, -4, 0, 2, -4, -4, iron); P.box(3, 3, 0, 2, -4, -4, iron); P.box(-1, -1, 0, 2, 3, 3, iron);
  P.ball(-0.5, 6, -0.5, 5.6, 4.6, 5.6, (x, y) => (y >= 9 ? -1 : iron), M_SOLID, 0.05);
  P.cyl(-0.5, -0.5, 4.6, 9, 9, (x, y, z, dx, dz) => (dx * dx + dz * dz > 3.6 * 3.6 ? 0x3a3a44 : 0x6dff6a), M_SOLID, 0);
  P.cyl(-0.5, -0.5, 3.6, 9, 9, 0x7dff6a, M_GLOW, 0.05);
  P.set(-2, 1, 1, FLAME[1], M_GLOW, 0); P.set(1, 1, -1, FLAME[0], M_GLOW, 0);
  W.light(2 * i + 1, o.h * 2 + 14, 2 * k + 1, 0x7dff6a, 0.9, 1);
  W.emit({ kind: "dot", count: 22, center: [2 * i + 1, o.h * 2 + 18, 2 * k + 1], box: [7, 16, 7], vel: [0, 5, 0], size: [1, 2], colors: [0x9dff8a, 0x5dff6a], wob: 0.8, additive: true, intensity: 2.2 });
}

function pGraves(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  for (const [x, z, cross] of [[-6, -2, false], [3, -3, true], [-1, 2, false]]) {
    if (cross) { P.box(x, x + 1, 0, 11, z, z + 1, STONE_D); P.box(x - 2, x + 3, 7, 8, z, z + 1, STONE_D); continue; }
    for (let y = 0; y < 10; y++) for (let xx = -3; xx <= 2; xx++) {
      if (y > 7 && Math.abs(xx + 0.5) > 2.5 - (y - 7)) continue;
      P.box(x + xx, x + xx, y, y, z, z + 1, h3(xx, y, z, 3) > 0.85 ? 0x7fa060 : STONE, M_SOLID, 0.06);
    }
    P.box(x - 2, x + 1, 0, 0, z + 2, z + 6, 0x6b4a32);
    if (r() < 0.6) { P.set(x, 1, z + 4, 0xffd23f); P.set(x - 1, 1, z + 5, 0xff6b8a); }
  }
}

function pGate(W, i, k, o) {
  const C = W.cp(i, k, o.rot, o.h);
  for (const x of [-5, 3]) { C.box(x, x + 1, 0, 8, -1, 0, (xx, y) => (y % 3 === 0 ? STONE_D : STONE)); C.box(x, x + 1, 9, 9, -1, 0, STONE_D); }
  const P = W.fp(i, k, o.rot, o.h);
  for (let x = -6; x <= 5; x++) {
    const top = 15 + Math.round(3 * Math.cos((x + 0.5) / 6.5 * Math.PI / 2));
    if (x % 2 === 0) { P.box(x, x, 0, top, -1, -1, IRON); P.set(x, top + 1, -1, GOLD, M_SOLID, 0); }
  }
  P.box(-6, 5, 3, 3, -1, -1, IRON); P.box(-6, 5, 12, 12, -1, -1, IRON);
}

function pBarrels(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const spots = [[-4, 0], [3, -1], [-1, -6]];
  spots.forEach(([x, z], n) => {
    if (n === 2 && r() < 0.3) return;
    P.cyl(x, z, 3.4, 0, 8, (xx, y) => (y === 1 || y === 7 ? 0x3a3a3a : y === 8 ? 0x6b4426 : (xx % 2 ? 0x8a5a34 : 0x7a4e2c)), M_SOLID, 0.05);
  });
  P.box(5, 11, 0, 6, 3, 8, (x, y, z) => (x === 5 || x === 11 || y === 6 || y === 0 ? 0x8a6238 : 0xa87a46));
}

function pCart(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  P.box(-7, 6, 5, 6, -4, 3, WOOD_L);
  P.box(-7, 6, 7, 9, -4, -4, WOOD); P.box(-7, 6, 7, 9, 3, 3, WOOD); P.box(-7, -7, 7, 9, -4, 3, WOOD); P.box(6, 6, 7, 9, -4, 3, WOOD);
  for (const z of [-6, 5]) for (let y = 0; y <= 8; y++) for (let x = -4; x <= 3; x++) {
    const d = Math.hypot(x + 0.5, y - 4);
    if (d > 4.3) continue;
    P.set(x, y, z, d > 3.2 || Math.abs(x + 0.5) < 0.6 || Math.abs(y - 4) < 0.6 ? WOOD_D : -1);
  }
  P.box(7, 14, 6, 6, -3, -3, WOOD); P.box(7, 14, 6, 6, 2, 2, WOOD);
  const hay = r() < 0.5;
  P.ball(-0.5, 9, -0.5, 6.5, 3.5, 3.6, (x, y, z) => (hay ? (h3(x, y, z, 1) > 0.5 ? 0xe8c860 : 0xd8b450) : [0xd8253c, 0x8ac24a, 0xffb02e][(h3(x, y, z, 1) * 3) | 0]), M_SOLID, 0.05);
}

function pCarriage(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const body = [0x2a4a8a, 0xe8853a, 0x7a2a4a, 0xf3efe7][(r() * 4) | 0];
  P.box(-7, 6, 6, 15, -4, 3, (x, y, z) => (y === 6 || y === 15 || x === -7 || x === 6 ? GOLD : body));
  P.box(-6, 5, 16, 16, -3, 2, body); P.box(-4, 3, 17, 17, -2, 1, body); P.box(-1, 0, 18, 19, -1, 0, GOLD);
  const win = W.dark ? LAMP : 0xbfe6ff;
  P.box(-4, 3, 10, 13, 4, 4, win, W.dark ? M_GLOW : M_SOLID, 0); P.box(-0, -1, 10, 13, 4, 4, body);
  P.box(-4, 3, 10, 13, -5, -5, win, W.dark ? M_GLOW : M_SOLID, 0);
  for (const x of [-6, 5]) for (const z of [-6, 5]) for (let y = 0; y <= 8; y++) for (let xx = -4; xx <= 4; xx++) {
    const d = Math.hypot(xx, y - 4);
    if (d > 4.4) continue;
    P.set(x + xx, y, z, d > 3.3 ? 0x2a1d18 : d < 1.2 ? GOLD : (Math.abs(xx) < 0.6 || Math.abs(y - 4) < 0.6 ? 0x5a3a20 : -1));
  }
  P.box(7, 7, 12, 14, 4, 4, IRON); P.set(7, 15, 4, LAMP, M_GLOW, 0);
}

function pBoat(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const hull = 0x9a5a34, stripe = WHITE;
  for (let x = -10; x <= 9; x++) {
    const t = Math.abs(x + 0.5) / 10;
    const half = Math.max(1, Math.round(4.5 * Math.sqrt(1 - t * t)));
    const lift = t > 0.75 ? 1 : 0;
    for (let y = 0; y <= 4 + lift; y++) {
      const w = y === 0 ? Math.max(1, half - 2) : y === 1 ? half - 1 : half;
      for (let z = -w; z < w; z++) {
        const shell = z === -w || z === w - 1 || y === 0 || Math.abs(x + 0.5) > 8.6;
        if (!shell && y > 1) continue;
        P.set(x, y, z, y === 4 + lift ? stripe : y >= 3 ? 0xd8c088 : hull, M_SOLID, 0.05);
      }
    }
  }
  P.box(-2, 1, 3, 3, -3, 2, WOOD_L); P.box(4, 6, 3, 3, -3, 2, WOOD_L);
  P.line(0, 4, -5, -6, 1, -9, WOOD_L); P.line(0, 4, 4, -6, 1, 8, WOOD_L);
}

function pShipModel(W, i, k, o) {
  const P = W.cp(i, k, o.rot, o.h);
  for (let x = -7; x <= 6; x++) {
    const t = Math.abs(x + 0.5) / 7.5;
    const half = Math.max(1, Math.round(3 * Math.sqrt(1 - t * t)));
    for (let y = 0; y <= 3; y++) {
      const w = y === 0 ? Math.max(1, half - 1) : half;
      P.box(x, x, y, y, -w, w - 1, y === 3 ? 0xc89a5a : y === 2 ? 0xf0e0b0 : 0x6b3a20);
    }
  }
  P.box(5, 7, 4, 4, -1, 0, 0x6b3a20); P.box(-8, -6, 4, 5, -2, 1, 0x7a4a2a);
  const F = W.fp(i, k, o.rot, o.h + 4);
  F.box(-1, 0, 0, 26, -1, 0, WOOD_D);
  for (let y = 6; y <= 22; y++) { const hw = y < 14 ? 9 : 7; F.box(-hw, hw - 1, y, y, 1 + Math.round(Math.sin((y - 6) / 16 * Math.PI) * 2), 1 + Math.round(Math.sin((y - 6) / 16 * Math.PI) * 2), WHITE, M_SOLID, 0.03); }
  F.box(0, 6, 24, 26, 0, 0, RED);
}

function pTrainProp(W, i, k, o) {
  const P = W.cp(i, k, o.rot, o.h);
  for (let x = -9; x <= 8; x++) { P.set(x, 0, -2, 0x6b4a30); P.set(x, 0, 1, 0x6b4a30); }
  const F = W.fp(i, k, o.rot, o.h);
  F.box(-18, 17, 1, 1, -4, -4, 0x9aa0a8); F.box(-18, 17, 1, 1, 3, 3, 0x9aa0a8);
  const body = 0x2f6a4a;
  F.box(-10, 4, 4, 13, -4, 3, (x, y) => (y === 8 ? GOLD : body));
  F.box(5, 13, 4, 19, -5, 4, 0x8a2a2a); F.box(4, 14, 20, 20, -6, 5, 0x2a2a2a);
  F.box(6, 12, 13, 17, 5, 5, W.dark ? LAMP : 0xbfe6ff, W.dark ? M_GLOW : M_SOLID, 0);
  F.box(-9, -6, 14, 21, -1, 1, 0x2a2a2a); F.box(-10, -5, 22, 22, -2, 2, 0x2a2a2a);
  F.box(-14, -11, 2, 5, -4, 3, 0xc8343c); F.box(-12, -11, 9, 11, -1, 0, LAMP, M_GLOW, 0);
  for (const x of [-8, -2, 3, 9]) for (const z of [-5, 4]) F.cyl(x, z, 2.6, 2, 2, 0, -1) && F.box(x - 2, x + 1, 1, 4, z, z, 0x1a1a1a);
  W.emit({ kind: "puff", count: 14, center: [2 * i + 1 - 15, o.h * 2 + 34, 2 * k + 1], box: [10, 26, 10], vel: [-2, 4, 0], size: [5, 10], colors: [0xf2f2f2, 0xdcdcdc], wob: 1.5, opacity: 0.6 });
}

function pTower(W, i, k, o) {
  const P = W.cp(i, k, 0, o.h);
  const H = 12;
  P.cyl(0, 0, 3.2, 0, H, (x, y) => ((x + y) % 4 === 0 ? STONE_D : STONE), M_SOLID, 0.06);
  P.cyl(0, 0, 3.8, H + 1, H + 1, STONE_D);
  P.cyl(0, 0, 3.8, H + 2, H + 2, (x, y, z) => ((x + z) % 2 ? STONE : -1));
  for (let t = 0; t < 6; t++) P.cyl(0, 0, 3.6 - t * 0.62, H + 2 + t, H + 2 + t, W.snowy ? 0xf3f7ff : 0x3d5a9a);
  P.box(-1, -1, H + 8, H + 10, -1, -1, WOOD_D);
  const lit = W.dark;
  P.box(-1, 0, 6, 7, 2, 2, lit ? LAMP : 0x2a3040, lit ? M_GLOW : M_SOLID, 0);
  P.box(-1, 0, 0, 2, 2, 2, 0x5a3a20);
  if (lit) W.light(2 * i + 1, (o.h + 7) * 2, 2 * k + 7, 0xffb050, 0.6);
}

function pCastle(W, i, k, o) {
  const P = W.cp(i, k, o.rot, o.h);
  const st = 0xb8b0a4, sd = 0x9a9288;
  P.box(-5, 4, 0, 7, -4, 3, (x, y) => ((x + y) % 5 === 0 ? sd : st));
  for (let x = -5; x <= 4; x++) if (x % 2 === 0) { P.set(x, 8, -4, st); P.set(x, 8, 3, st); }
  P.box(-1, 0, 0, 3, 3, 3, 0x5a3a20); P.box(-2, 1, 4, 4, 3, 3, sd);
  for (const [x, z] of [[-6, -5], [5, -5], [-6, 4], [5, 4]]) {
    P.cyl(x + 0.5, z + 0.5, 1.8, 0, 10, st);
    for (let t = 0; t < 4; t++) P.cyl(x + 0.5, z + 0.5, 2.2 - t * 0.6, 11 + t, 11 + t, W.snowy ? 0xf3f7ff : 0xc4473f);
  }
  const lit = W.dark;
  P.box(-3, -3, 5, 5, 3, 3, lit ? LAMP : 0x2a3040, lit ? M_GLOW : M_SOLID, 0); P.box(2, 2, 5, 5, 3, 3, lit ? LAMP : 0x2a3040, lit ? M_GLOW : M_SOLID, 0);
  const F = W.fp(i, k, o.rot, o.h + 15);
  F.box(-12, -12, 0, 8, -10, -10, WOOD_D); F.box(-11, -6, 5, 8, -10, -10, RED);
}

function pVolcano(W, i, k, o) {
  const P = W.cp(i, k, 0, o.h);
  const rock = W.setting === "space" ? 0x8a7a9a : 0x6a5a52;
  for (let y = 0; y <= 7; y++) {
    const R = 6.2 - y * 0.62;
    P.cyl(0, 0, R, y, y, (x, yy, z, dx, dz) => {
      const d = Math.hypot(dx, dz);
      if (y >= 5 && d < 1.8) return -1;
      if (Math.abs(dx - dz * 0.2) < 0.9 && dz > 0 && y < 7) return 0xff7a2a;
      return h3(x, yy, z, 4) > 0.8 ? mulC(rock, 0.85) : rock;
    }, M_SOLID, 0.06);
  }
  P.cyl(0, 0, 1.8, 5, 5, 0xff8a2a, M_GLOW, 0.05);
  for (let y = 1; y < 7; y++) P.set(Math.round(0.2 * 0), y, Math.round(6.2 - y * 0.62) - 1, 0xff6a1a, M_GLOW, 0);
  W.light(2 * i + 1, (o.h + 7) * 2, 2 * k + 1, 0xff6a2a, 1.2, 1);
  W.emit({ kind: "puff", count: 16, center: [2 * i + 1, (o.h + 8) * 2 + 16, 2 * k + 1], box: [10, 30, 10], vel: [1, 5, 0], size: [6, 12], colors: [0x8a8580, 0x6f6a66], wob: 1.4, opacity: 0.6 });
}

function pMushrooms(W, i, k, o) {
  const r = o.rng;
  const x = 2 * i + 1, z = 2 * k + 1;
  const cap = r() < 0.7 ? 0xd8353c : 0x8a5ad8;
  const glow = W.setting === "cave" || W.setting === "swamp";
  mMushroom(W, x, z, { s: 1.6, cap, glow: glow && false });
  mMushroom(W, x + 6, z + 3, { s: 1, cap, glow });
  mMushroom(W, x - 5, z + 4, { s: 0.75, cap, glow });
}

function pFenceProp(W, i, k, o) {
  // a fence run along the front edge, skipping the stage
  const z = 2 * (k) + 1;
  const half = 9;
  mFenceLine(W, 2 * i - half * 2, z, 2 * i + half * 2, z);
}
