// BookTrip — the 3D "trip into the book" mini-film (owner: film).
//
// createFilm(container, { book, lang, tts, onScene(i), onEnd(), autoplay?, controls?, lowQuality?, preserveDrawingBuffer? })
//   → { play(), pause(), restart(), dispose(), get playing,                     (SPEC §4)
//       seek(sceneIndex), renderAt(seconds), setTts(on),                        (extras)
//       get ended, get duration, get time, get scene, get timeline, get stats }
// `opts.tts` is read on every line (a getter works); setTts(on) overrides it. The container provides the size;
// a canvas and an overlay (.btf-root) are appended to it and removed again by dispose().
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
    nogl: "3D недоступно на этом устройстве — показываем раскадровку",
  },
  uk: {
    film: "Міні-фільм", play: "Дивитися фільм", pause: "Пауза", resume: "Продовжити", replay: "Дивитися знову",
    scene: "Сцена {n} з {m}", voiceOn: "Вимкнути озвучення", voiceOff: "Увімкнути озвучення", full: "На весь екран",
    exitFull: "Згорнути", end: "Кінець", prev: "Попередня сцена", next: "Наступна сцена", progress: "Сцени фільму",
    nogl: "3D недоступне на цьому пристрої — показуємо розкадрування",
  },
  en: {
    film: "Mini film", play: "Watch the film", pause: "Pause", resume: "Resume", replay: "Watch again",
    scene: "Scene {n} of {m}", voiceOn: "Turn narration off", voiceOff: "Turn narration on", full: "Full screen",
    exitFull: "Exit full screen", end: "The End", prev: "Previous scene", next: "Next scene", progress: "Film scenes",
    nogl: "3D is not available on this device — showing a storyboard",
  },
};

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
uniform float uSunSize, uStars, uTime, uMoon, uNebula, uHorizon;
varying vec3 vDir;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y + uHorizon;
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

function makeSky(geo) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uBot: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uSunSize: { value: 0.0012 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonCut: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: 0 },
      uStars: { value: 0 }, uTime: { value: 0 }, uNebula: { value: 0 }, uHorizon: { value: 0.34 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
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
  /** Block region [i0, i1, k0, k1] for a named area around the stage, for an object of half-size r. */
  region(where, r) {
    const { HX, HZ, stage: s } = this;
    const b0 = -HZ + r + 1;
    const sb = Math.floor(s.cz - s.rz);
    switch (where) {
      case "back": return [-HX * 0.7, HX * 0.7, b0, Math.max(b0, sb - r)];
      case "backL": return [-HX + r + 1, -HX * 0.15, b0, Math.max(b0, sb + 2)];
      case "backR": return [HX * 0.15, HX - r - 1, b0, Math.max(b0, sb + 2)];
      case "left": return [-HX + r + 1, Math.max(-HX + r + 1, s.cx - s.rx - r + 2), -HZ * 0.65, HZ * 0.45];
      case "right": return [Math.min(HX - r - 1, s.cx + s.rx + r - 2), HX - r - 1, -HZ * 0.65, HZ * 0.45];
      case "sideL": return [-HX + r + 1, -HX * 0.35, -HZ + r + 1, HZ - r - 1];
      case "sideR": return [HX * 0.35, HX - r - 1, -HZ + r + 1, HZ - r - 1];
      case "front": return [-HX * 0.85, HX * 0.85, Math.ceil(s.cz + s.rz), HZ - r - 1];
      case "frontL": return [-HX + r + 1, -HX * 0.35, s.cz, HZ - r - 1];
      case "frontR": return [HX * 0.35, HX - r - 1, s.cz, HZ - r - 1];
      default: return [-HX + r + 1, HX - r - 1, -HZ + r + 1, HZ - r - 1];
    }
  }
  /** Quarter turn that makes a model's local +z face the stage. */
  faceRot(i, k) {
    const dx = this.stage.cx - i, dz = this.stage.cz - k;
    if (Math.abs(dz) >= Math.abs(dx)) return dz >= 0 ? 0 : 2;
    return dx >= 0 ? 1 : 3;
  }
  /**
   * Find a free spot in a named area, level the ground under the footing, claim it and draw `fn` there.
   * o: { foot (footing half-size), water, pad, h, rot, stage } → [i, k] or null.
   */
  place(where, r, fn, o = {}) {
    const reg = Array.isArray(where) ? where : this.region(where, r);
    const sp = this.spot(r, reg, o, o.tries ?? 40);
    if (!sp) return null;
    const [i, k] = sp;
    const f = o.foot ?? r;
    const h = o.h ?? this.maxH(i - f, i + f, k - f, k + f);
    if (f >= 0) this.footing(i - f, i + f, k - f, k + f, h);
    this.claim(i - r, i + r, k - r, k + r);
    fn(this, i, k, { rng: this.rng, ...o, h, rot: o.rot ?? this.faceRot(i, k) });
    return sp;
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
    const depth = S.flatBottom ? S.flatBottom + (rr > 0.97 ? 0 : 0)
      : 2 + Math.floor((1 - rr * rr) * (S.depth ?? 9) + noise2(i * 0.45, k * 0.45, W.seed + 3) * 3.2) + (h3(i, 1, k, W.seed) > 0.9 ? 1 : 0);
    const c = { i, k, rr, h: 0, bottom: -depth, water: false, wl: 0 };
    c.h = S.height ? S.height(W, i, k, rr) : 0;
    if (S.bottom) c.bottom = S.bottom(W, i, k, rr, c);
    const wd = S.water ? S.water(W, i, k, rr) : 0;
    if (wd > 0) { c.water = true; c.wl = c.h; c.h = c.h - wd; }
    if (S.column) S.column(W, c);
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
  W.light(2 * i + 1, o.h * 2 + 10, 2 * k + 1, cols[1], 0.9);
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
  const z = o.wall ? 0 : -1;
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
  for (const x of [-8, -2, 3, 9]) for (const z of [-5, 4]) {
    F.box(x - 2, x + 1, 1, 4, z, z, 0x1a1a1a);
    F.box(x - 1, x, 2, 3, z + (z < 0 ? -1 : 1), z + (z < 0 ? -1 : 1), GOLD, M_SOLID, 0);
  }
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

const BOOKS = [0x8a2a2a, 0x2a4a8a, 0x3a7a4a, 0xc8a040, 0x6a3a7a, 0xd86a3a, 0x2a6a6a, 0xe8dcc0, 0x9a3a5a];

function pBookshelf(W, i, k, o) {
  const r = o.rng, P = W.fp(i, k, o.rot, o.h);
  const wood = o.wood ?? 0x6e4326, H = o.tall ?? 26, Wd = o.wide ?? 7;
  P.box(-Wd, Wd - 1, 0, H, -3, -3, mulC(wood, 0.78));
  P.box(-Wd, -Wd, 0, H, -3, 2, wood); P.box(Wd - 1, Wd - 1, 0, H, -3, 2, wood);
  P.box(-Wd - 1, Wd, H + 1, H + 2, -3, 3, mulC(wood, 1.08));
  for (let y = 0; y < H; y += 8) {
    P.box(-Wd + 1, Wd - 2, y, y, -2, 2, wood);
    let x = -Wd + 1;
    while (x <= Wd - 2) {
      const bw = r() < 0.3 ? 2 : 1, bh = 4 + ((r() * 3) | 0);
      if (x + bw - 1 > Wd - 2) break;
      if (r() < 0.07) { x += bw; continue; }
      P.box(x, x + bw - 1, y + 1, Math.min(y + bh, y + 7), -2, 1, BOOKS[(r() * BOOKS.length) | 0], M_SOLID, 0.07);
      x += bw;
    }
  }
}

/** Fallen log (fine) along x. */
function mLog(W, i, k, o = {}) {
  const P = W.fp(i, k, o.rot || 0, o.h);
  for (let x = -9; x <= 8; x++) for (let y = 0; y <= 5; y++) for (let z = -3; z <= 2; z++) {
    const d = Math.hypot(y - 2.5, z + 0.5);
    if (d > 3.1) continue;
    const end = x === -9 || x === 8;
    P.set(x, y, z, end ? (d < 1.6 ? 0xd8b080 : 0xb88a5a) : W.snowy && y >= 4 ? 0xf3f7ff : d > 2.3 ? (h3(x, y, z, 2) > 0.8 ? 0x6a8a3a : 0x6b4a30) : 0x7a5638, M_SOLID, 0.06);
  }
  P.set(-3, 6, 0, 0x5aa648); P.set(2, 6, -1, 0x6cc455);
}

/** Bare, twisted dead tree (coarse trunk + fine branches). */
function mDeadTree(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const bark = o.bark ?? 0x6e5c4a;
  const P = W.cp(i, k, 0, o.h);
  const H = 6 + ((r() * 3) | 0);
  let x = 0;
  for (let y = 0; y <= H; y++) {
    if (y > 2 && r() < 0.3) x += r() < 0.5 ? 1 : -1;
    P.set(x, y, 0, h3(x, y, 0, 3) > 0.7 ? mulC(bark, 0.85) : bark);
    if (y < 2) P.set(x - 1, y, 0, mulC(bark, 0.9));
  }
  const F = W.fp(i, k, 0, o.h);
  const top = H * 2 + 2;
  for (let b = 0; b < 5; b++) {
    const a = r() * TAU, len = 6 + r() * 7, y0 = top - 4 - ((r() * 6) | 0);
    const ex = Math.round(x * 2 + Math.cos(a) * len), ez = Math.round(Math.sin(a) * len);
    F.line(x * 2, y0, 0, ex, y0 + 4 + ((r() * 5) | 0), ez, mulC(bark, 0.92), M_SOLID, 0.05, 1);
    if (o.moss) F.box(ex, ex, y0 + 2, y0 + 5, ez, ez, o.moss, M_LEAF, 0.05);
  }
}

/** Box hedge (coarse) between two block corners. */
function mHedge(W, i0, k0, i1, k1, hgt = 2, o = {}) {
  const leaves = o.leaves ?? [0x3f8f3a, 0x46993f, 0x387f34];
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) for (let k = Math.min(k0, k1); k <= Math.max(k0, k1); k++) {
    if (!W.inside(i, k) || W.claimed(i, k) || W.water(i, k)) continue;
    const h = W.h(i, k);
    for (let y = 0; y < hgt; y++) W.C.set(i, h + y, k, W.snowy && y === hgt - 1 ? 0xf3f7ff : leaves[(h3(i, y, k, 9) * leaves.length) | 0], M_LEAF, 0.05);
    W.claims.add(W.ck(i, k));
  }
}

/** Topiary: a clipped ball or cone on a short trunk (fine). */
function mTopiary(W, i, k, o = {}) {
  const P = W.fp(i, k, 0, o.h);
  const g = o.leaves ?? [0x3f9a3f, 0x4aa648];
  P.box(-3, 2, 0, 3, -3, 2, o.pot ?? 0xc8724a); P.box(-4, 3, 4, 4, -4, 3, mulC(o.pot ?? 0xc8724a, 0.9));
  P.box(-1, 0, 5, 8, -1, 0, 0x6b4a30);
  if (o.cone) for (let y = 0; y < 14; y++) P.cyl(-0.5 + 0.5, -0.5 + 0.5, Math.max(0.8, 5.5 - y * 0.38), 7 + y, 7 + y, (x, yy, z) => g[(h3(x, yy, z, 2) * g.length) | 0], M_LEAF, 0.04);
  else P.ball(0, 13, 0, 5.5, 5.5, 5.5, (x, y, z) => (W.snowy && y > 15 ? 0xf3f7ff : g[(h3(x, y, z, 2) * g.length) | 0]), M_LEAF, 0.04);
}

/** Snowman (fine). */
function mSnowman(W, i, k, o = {}) {
  const P = W.fp(i, k, o.rot || 0, o.h);
  const sn = (x, y, z) => (h3(x, y, z, 7) > 0.85 ? 0xe2ecf7 : 0xf8fbff);
  P.ball(0, 5, 0, 6, 5.5, 6, sn, M_SOLID, 0.02);
  P.ball(0, 13.5, 0, 4.5, 4.2, 4.5, sn, M_SOLID, 0.02);
  P.ball(0, 20, 0, 3.4, 3.2, 3.4, sn, M_SOLID, 0.02);
  P.set(-1, 21, 3, 0x1a1a22, M_SOLID, 0); P.set(1, 21, 3, 0x1a1a22, M_SOLID, 0);
  P.box(0, 0, 20, 20, 3, 6, 0xff8a2a, M_SOLID, 0);
  P.box(-4, 3, 17, 17, -4, 3, 0xc8343c); P.box(2, 3, 12, 16, 3, 4, 0xc8343c);
  P.box(-3, 2, 23, 23, -3, 2, 0x22222a); P.box(-2, 1, 24, 27, -2, 1, 0x22222a);
  P.set(0, 14, 4, 0x22222a); P.set(0, 12, 4, 0x22222a);
  P.line(-4, 14, 0, -9, 18, 0, 0x6b4a30); P.line(4, 14, 0, 9, 17, 1, 0x6b4a30);
}

/** Haystack (coarse dome). */
function mHay(W, i, k, o = {}) {
  const P = W.cp(i, k, 0, o.h);
  P.ball(-0.5 + 0.5, 0.2, 0, 2.6, 2.4, 2.4, (x, y, z) => (W.snowy && y >= 2 ? 0xf3f7ff : h3(x, y, z, 5) > 0.5 ? 0xe8c860 : 0xd6b24e), M_SOLID, 0.06);
}

/** Layered sandstone mesa (coarse). */
function mMesa(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, 0, o.h);
  const H = o.H ?? 6 + ((r() * 5) | 0), R = o.r ?? 2.6 + r() * 1.4;
  const bands = [0xd9874e, 0xc8703e, 0xe8a066, 0xb8603a];
  for (let y = 0; y <= H; y++) {
    const rr = R * (1 - 0.06 * y) + (y === H ? 0.5 : 0);
    P.cyl(0.5, 0.5, rr, y, y, (x, yy, z) => (y === H ? 0xe8b070 : bands[(y + (h3(x, y, z, 4) > 0.85 ? 1 : 0)) % bands.length]), M_SOLID, 0.05);
  }
}

/** Tall narrow town house (coarse) with windows on its front (+z local) and a pitched roof. */
function mTownHouse(W, i, k, o = {}) {
  const r = o.rng || W.rng;
  const P = W.cp(i, k, o.rot || 0, o.h);
  const w = o.w ?? 3, d = o.d ?? 3, floors = o.floors ?? 2 + ((r() * 3) | 0);
  const H = floors * 4 + 1;
  const wall = o.wall ?? [0xf0d9b5, 0xe8a98f, 0xb9d4e6, 0xf2e6c8, 0xc9e0b8, 0xe6c2d8][(r() * 6) | 0];
  const trim = 0xf8f4ec, roof = o.roof ?? [0x8a3a32, 0x4a5a7a, 0x6a4a3a, 0x3a4a5a][(r() * 4) | 0];
  const lit = W.dark;
  P.box(-w, w - 1, 0, H - 1, -d, d - 1, (x, y, z) => {
    if (y === 0) return STONE_D;
    if (y % 4 === 0) return trim;
    const front = z === d - 1, side = x === -w || x === w - 1;
    const wy = y % 4 === 2 || y % 4 === 3;
    if (wy && front && (x - -w) % 2 === 1 && x !== w - 1) return lit && h3(x, y, i + k, 3) > 0.25 ? -2 : 0x5a7a9a;
    if (wy && side && (z + d) % 3 === 1) return lit && h3(z, y, i, 4) > 0.4 ? -2 : 0x5a7a9a;
    return wall;
  });
  // glowing windows were marked -2: redo them with the glow material
  P.box(-w, w - 1, 0, H - 1, -d, d - 1, (x, y, z) => {
    const front = z === d - 1, side = x === -w || x === w - 1;
    const wy = y % 4 === 2 || y % 4 === 3;
    if (!lit || !wy || y === 0) return -1;
    if (front && (x - -w) % 2 === 1 && x !== w - 1 && h3(x, y, i + k, 3) > 0.25) return LAMP;
    if (side && (z + d) % 3 === 1 && h3(z, y, i, 4) > 0.4) return LAMP;
    return -1;
  }, M_GLOW, 0.06);
  P.box(-1, 0, 1, 2, d, d, 0x6b3f22);
  for (let t = 0; t <= d; t++) {
    const rc = W.snowy ? 0xf3f7ff : (t % 2 ? mulC(roof, 0.9) : roof);
    P.box(-w - 1, w, H + t, H + t, -d - 1 + t, -d - 1 + t, rc);
    P.box(-w - 1, w, H + t, H + t, d - t, d - t, rc);
    if (d - t - (-d - 1 + t) > 1) { P.box(-w, -w, H + t, H + t, -d + t, d - t - 1, wall); P.box(w - 1, w - 1, H + t, H + t, -d + t, d - t - 1, wall); }
  }
  if (o.awning) P.box(-w, w - 1, 3, 3, d, d + 1, (x) => ((x & 1) ? 0xf3efe7 : o.awning));
}

/** Striped lighthouse on a rock (coarse). */
function mLighthouse(W, i, k, o = {}) {
  const P = W.cp(i, k, 0, o.h);
  P.ball(0.5, -0.5, 0.5, 4.2, 3, 4.2, (x, y, z) => (h3(x, y, z, 2) > 0.7 ? STONE_D : STONE), M_SOLID, 0.08);
  const H = 13;
  for (let y = 1; y <= H; y++) P.cyl(0.5, 0.5, 2.4 - y * 0.06, y, y, Math.floor((y - 1) / 2) % 2 ? 0xf3efe7 : 0xd8343c, M_SOLID, 0.03);
  P.cyl(0.5, 0.5, 2.6, H + 1, H + 1, 0x2a2a32);
  P.cyl(0.5, 0.5, 1.6, H + 2, H + 3, 0xfff0b0, M_GLOW, 0);
  P.cyl(0.5, 0.5, 2.1, H + 4, H + 4, 0xd8343c); P.set(0, H + 5, 0, 0xd8343c);
  W.light(2 * i + 1, (o.h + H + 3) * 2, 2 * k + 1, 0xffe0a0, W.dark ? 1.4 : 0.3);
}

/** Cone of rock (stalagmite up, or stalactite hanging down when dir = -1) on the coarse grid. */
function mSpike(W, i, y0, k, len, dir, color, mat = M_SOLID) {
  for (let t = 0; t < len; t++) {
    const rr = Math.max(0.55, (1 - t / len) * 1.9);
    painter(W.C, i, y0 + dir * t, k, 0).cyl(0.5, 0.5, rr, 0, 0, (x, y, z) => (h3(x, y, z, 6) > 0.8 ? mulC(color, 0.88) : color), mat, 0.06);
  }
}

/** Banner of a side in a battle, a crater, spiky barricades. */
function mCrater(W, i, k, R = 3) {
  for (let di = -R - 1; di <= R + 1; di++) for (let dk = -R - 1; dk <= R + 1; dk++) {
    const c = W.col(i + di, k + dk);
    if (!c || c.water || c.stage) continue;
    const d = Math.hypot(di, dk);
    if (d <= R - 0.5) { W.C.del(i + di, c.h - 1, k + dk); W.C.set(i + di, c.h - 2, k + dk, 0x4a3a2a); c.h -= 1; }
    else if (d <= R + 0.7) W.C.set(i + di, c.h, k + dk, 0x6a5a40, M_SOLID, 0.1);
  }
}
function mBarricade(W, i, k, o = {}) {
  const P = W.fp(i, k, o.rot || 0, o.h);
  P.box(-9, 8, 3, 4, -1, 0, WOOD_D);
  for (const x of [-8, -3, 2, 7]) { P.line(x, 0, -4, x + 2, 9, 4, WOOD, M_SOLID, 0.05); P.line(x, 0, 4, x + 2, 9, -4, WOOD_L, M_SOLID, 0.05); }
}

/** Wooden pier deck with posts (coarse) over every column of the stage. */
function mPier(W, y) {
  for (const c of W.cols.values()) {
    if (!c.stage) continue;
    const { i, k } = c;
    W.C.set(i, y, k, (i + 64) % 3 === 0 ? 0xa8784a : (k & 1 ? 0xb88a56 : 0xc29a62), M_SOLID, 0.05);
    if ((i & 3) === 0 && (k & 3) === 0) for (let j = c.h; j < y; j++) W.C.set(i, j, k, 0x5a3a20);
  }
}

// ---------------------------------------------------------------- sky props & floaters ----

/** Register a free-floating model: its own little grid, bobbing in the sky. */
function addFloater(W, pos, draw, o = {}) {
  const g = new Grid(o.size ?? 1, W.seed + 977 * (W.floaters.length + 1));
  draw(painter(g, 0, 0, 0, 0), g);
  W.floaters.push({ grid: g, pos, rot: o.rot ?? [0, 0, 0], bob: o.bob ?? 1.6, spin: o.spin ?? 0, phase: W.rng() * TAU, drift: o.drift ?? 0, castShadow: o.castShadow ?? false });
}
const SKY_SLOTS = [[-44, 34, -74], [46, 40, -70], [4, 50, -92], [-78, 26, -40], [80, 30, -36]];

function skyProp(W, name, n) {
  const base = SKY_SLOTS[(n + W.skyUsed++) % SKY_SLOTS.length];
  const lift = W.interior ? 18 : 0;
  const pos = [base[0], base[1] + lift + W.stageH * 2, base[2]];
  if (name === "star") {
    addFloater(W, pos, (P) => {
      for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) {
        const a = Math.atan2(y, x), d = Math.hypot(x, y);
        const R = 4 + 5 * Math.pow(Math.abs(Math.cos(2.5 * (a - Math.PI / 2))), 3);
        if (d > R) continue;
        P.box(x, x, y, y, -1, 0, d < R - 1.5 ? 0xffe27a : 0xffc83a, M_GLOW, 0.03);
      }
    }, { bob: 2, spin: 0.35 });
    W.light(pos[0], pos[1], pos[2] + 10, 0xffd870, 0.8);
  } else if (name === "moon") {
    addFloater(W, pos, (P) => {
      for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) {
        if (Math.hypot(x, y) > 10 || Math.hypot(x - 5, y - 3) < 8.5) continue;
        P.box(x, x, y, y, -2, 1, h3(x, y, 0, 3) > 0.85 ? 0xf0e0a8 : 0xfff3c8, M_GLOW, 0.03);
      }
    }, { bob: 1.4, rot: [0, -0.3, 0.2] });
  } else {
    const kind = (W.seed >>> 3) % 3;
    const bands = [[0xe8a060, 0xf0c890, 0xd88850], [0x7ab8e8, 0x9ad0f0, 0x5a98d8], [0xc890e0, 0xe0b8f0, 0xa870c8]][kind];
    addFloater(W, pos, (P) => {
      P.ball(0, 0, 0, 8, 8, 8, (x, y) => bands[((y + 20) >> 1) % 3], M_SOLID, 0.04);
      for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) {
        const d = Math.hypot(x + 0.5, z + 0.5);
        if (d < 10.5 || d > 14.5) continue;
        P.set(x, 0, z, d > 12.5 ? 0xf2e2c0 : 0xd8c0a0, M_SOLID, 0.05);
      }
    }, { bob: 1.2, spin: 0.12, rot: [0.35, 0, -0.32] });
  }
}

/** Puffy voxel cloud floating behind the island. */
function addCloud(W, pos, s = 1) {
  const r = W.rng;
  const col = W.night ? 0x7a86b0 : W.time === "dusk" ? 0xffc2b0 : W.time === "dawn" ? 0xffe0d0 : 0xffffff;
  addFloater(W, pos, (P) => {
    const n = 3 + ((r() * 3) | 0);
    for (let b = 0; b < n; b++) {
      const x = (b - n / 2) * 4.5 * s, rr = (3.5 + r() * 2.5) * s;
      P.ball(x, rr * 0.4, (r() - 0.5) * 3, rr * 1.2, rr * 0.8, rr, (xx, y) => (y < 0 ? mulC(col, 0.86) : col), M_SOLID, 0.02);
    }
  }, { size: 2, bob: 0.8, drift: 1.2 + r() });
}

/** Little floating rock with grass on top (space: plain asteroid). */
function addRockFloater(W, pos, s = 1) {
  const r = W.rng, space = W.setting === "space";
  const top = space ? 0xb8a8c8 : W.snowy ? 0xf3f7ff : W.leaves[0];
  addFloater(W, pos, (P) => {
    const R = (2.2 + r() * 1.5) * s;
    P.ball(0, 0, 0, R * 1.2, R, R, (x, y, z, dx, dy) => (dy > 0.45 ? top : dy > 0.1 ? 0x8d5c3c : h3(x, y, z, 2) > 0.7 ? STONE_D : STONE), M_SOLID, 0.07);
  }, { size: 2, bob: 2.2, spin: space ? 0.2 : 0.04 });
}

// ---------------------------------------------------------------- scene props: table & placement ----
// r / rx,rz = footprint half-size in blocks; far = how far behind the cast it prefers to stand;
// wall = hangs on a wall indoors; sky = floats in the sky; water = may stand on water.

const PROPS = {
  tree: { r: 5, foot: 1, far: 1, fn: (W, i, k, o) => mTree(W, i, k, o) },
  pine: { r: 4, foot: 1, far: 1, fn: (W, i, k, o) => mPine(W, i, k, o) },
  palm: { r: 4, foot: 1, far: 1, fn: (W, i, k, o) => mPalm(W, i, k, o) },
  house: { r: 6, far: 2, fn: (W, i, k, o) => mHouse(W, i, k, { ...o, style: W.setting === "village" ? "thatch" : W.setting === "city" || W.setting === "street" ? "town" : "cottage" }) },
  tower: { r: 4, far: 2, fn: pTower },
  castle: { r: 7, far: 3, fn: pCastle },
  lamp: { r: 1, fn: (W, i, k, o) => mLamp(W, i, k, o) },
  rose: { r: 2, fn: pRose },
  flower: { r: 2, fn: (W, i, k, o) => mFlowerPatch(W, i, k, { ...o, n: 10 }) },
  rock: { r: 2, foot: 0, fn: (W, i, k, o) => mRock(W, i, k, o) },
  volcano: { r: 6, far: 2, fn: pVolcano },
  star: { sky: true }, moon: { sky: true }, planet: { sky: true },
  boat: { r: 5, rx: 6, rz: 3, water: true, fn: pBoat },
  ship: { r: 8, rx: 8, rz: 4, far: 3, water: true, fn: pShipModel },
  table: { r: 4, fn: pTable },
  chair: { r: 2, fn: pChair },
  bookshelf: { r: 4, wall: true, wallOff: 1, fn: pBookshelf },
  fire: { r: 3, fn: pFire },
  fountain: { r: 5, far: 1, fn: pFountain },
  bench: { r: 4, rx: 5, rz: 2, fn: pBench },
  fence: { line: true },
  well: { r: 3, fn: pWell },
  carriage: { r: 5, far: 1, fn: pCarriage },
  chest: { r: 3, fn: pChest },
  door: { r: 4, wall: true, fn: pDoor },
  bridge: { r: 6, rx: 7, rz: 6, far: 1, fn: pBridge },
  tent: { r: 6, far: 1, fn: pTent },
  crystal: { r: 3, fn: pCrystal },
  clock: { r: 2, wall: true, fn: pClock },
  piano: { r: 5, fn: pPiano },
  statue: { r: 3, fn: pStatue },
  cake: { r: 3, fn: pCake },
  barrel: { r: 4, fn: pBarrels },
  cart: { r: 5, fn: pCart },
  throne: { r: 4, fn: pThrone },
  bed: { r: 5, fn: pBed },
  desk: { r: 4, fn: pDesk },
  window: { r: 3, wall: true, fn: pWindow },
  mushroom: { r: 3, fn: pMushrooms },
  bush: { r: 2, foot: 0, fn: (W, i, k, o) => mBush(W, i, k, o) },
  sign: { r: 2, fn: pSign },
  telescope: { r: 3, fn: pTelescope },
  cauldron: { r: 3, fn: pCauldron },
  candles: { r: 2, fn: pCandles },
  gate: { r: 4, rx: 5, rz: 2, far: 1, fn: pGate },
  grave: { r: 4, fn: pGraves },
  train: { r: 10, rx: 10, rz: 4, far: 3, fn: pTrainProp },
};

// Angles around the stage centre (x = cos, z = sin; −π/2 is straight behind the cast).
const SLOT_ANGLES = [-2.2, -0.95, -1.57, -2.75, -0.4, 3.05, 0.1, -1.25, -1.9];

function placeSceneProps(W, list) {
  const names = [];
  for (const p of Array.isArray(list) ? list : []) if (typeof p === "string" && PROPS[p] && names.length < 6) names.push(p);
  const ground = names.filter((n) => !PROPS[n].sky && !PROPS[n].line);
  ground.sort((a, b) => (PROPS[b].far || 0) - (PROPS[a].far || 0) || (PROPS[b].r - PROPS[a].r));
  let slot = 0;
  for (const name of ground) {
    const def = PROPS[name];
    if (def.wall && W.walls) { wallProp(W, name, def); continue; }
    placeAround(W, name, def, slot++);
  }
  names.filter((n) => PROPS[n].sky).forEach((n, idx) => skyProp(W, n, idx));
  if (names.includes("fence")) fenceArc(W);
}

function placeAround(W, name, def, slot) {
  const s = W.stage, rng = W.rng;
  for (let t = 0; t < 48; t++) {
    const a = SLOT_ANGLES[(slot + Math.floor(t / 4)) % SLOT_ANGLES.length] + (rng() - 0.5) * 0.45;
    const rot0 = Math.abs(Math.sin(a)) > 0.6 ? (Math.sin(a) < 0 ? 0 : 2) : Math.cos(a) < 0 ? 1 : 3;
    const swap = rot0 === 1 || rot0 === 3;
    const rx = (swap ? def.rz : def.rx) ?? def.r, rz = (swap ? def.rx : def.rz) ?? def.r;
    const grow = 1 + (def.far || 0) * 0.18 + (t % 4) * 0.08 + Math.floor(t / 16) * 0.15;
    const i = Math.round(s.cx + Math.cos(a) * (s.rx * grow + rx + 1));
    const k = Math.round(s.cz + Math.sin(a) * (s.rz * grow + rz + 1));
    if (!W.free(i - rx, i + rx, k - rz, k + rz, { water: def.water, pad: 0.5 })) continue;
    const f = def.foot ?? Math.max(rx, rz);
    const fx = Math.min(f, rx), fz = Math.min(f, rz);
    const h = W.maxH(i - fx, i + fx, k - fz, k + fz);
    if (fx >= 0 && !(def.water && W.water(i, k))) W.footing(i - fx, i + fx, k - fz, k + fz, h);
    W.claim(i - rx, i + rx, k - rz, k + rz);
    def.fn(W, i, k, { rng, h: def.water && W.water(i, k) ? W.col(i, k).wl : h, rot: rot0 });
    return true;
  }
  return false;
}

/** Indoors, wall props hang on the back or left wall, spaced along it. */
function wallProp(W, name, def) {
  const back = W.wallSlots.back, left = W.wallSlots.left;
  const useBack = back.length && (W.wallTurn++ % 3 !== 2 || !left.length);
  const list = useBack ? back : left;
  if (!list.length) { placeAround(W, name, def, W.wallTurn); return; }
  const [i0, k0] = list.shift();
  const off = def.wallOff || 0;
  const i = useBack ? i0 : i0 + off, k = useBack ? k0 + off : k0;
  const r = def.r;
  W.claim(i - (useBack ? r : 0), i + (useBack ? r : 2), k - (useBack ? 0 : r), k + (useBack ? 2 : r));
  def.fn(W, i, k, { rng: W.rng, h: W.h(i, k), rot: useBack ? 0 : 1, wall: true });
}

/** Fence arc behind the cast. */
function fenceArc(W) {
  const s = W.stage, pts = [];
  for (let a = -2.75; a <= -0.35; a += 0.24) pts.push([Math.round((s.cx + Math.cos(a) * (s.rx + 3)) * 2), Math.round((s.cz + Math.sin(a) * (s.rz + 3)) * 2)]);
  for (let n = 0; n + 1 < pts.length; n++) {
    const [x0, z0] = pts[n], [x1, z1] = pts[n + 1];
    const mi = Math.floor((x0 + x1) / 4), mk = Math.floor((z0 + z1) / 4);
    if (W.claimed(mi, mk) || W.water(mi, mk) || !W.inside(mi, mk)) continue;
    mFenceLine(W, x0, z0, x1, z1);
  }
}

// =================================================================================================
// Settings — each one is a recipe for its diorama: island shape, terrain, colours and signature models.
// =================================================================================================

const GRASS = [0x7ccf55, 0x6fc24b, 0x86d65e, 0x74c650];
const SAND = [0xf3d79a, 0xecc986, 0xf7e2ae, 0xe6c27c];
const SNOWC = [0xf7fbff, 0xebf2fa, 0xffffff, 0xe2ecf7];
const DIRT = 0x8d5c3c;
/** 0 in the front half of the island → 1 at its back edge. */
const back = (W, k) => clamp((-(k + 0.5) / W.HZ - 0.2) / 0.8, 0, 1);
const hill = (W, i, k, sc, s = 0) => noise2(i * sc, k * sc, W.seed + 101 + s);

/** Carve a pond (or freeze one: o.ice) into already-filled terrain. */
function pond(W, ci, ck, R, o = {}) {
  const rz = o.rz ?? R;
  for (let i = Math.floor(ci - R - 1); i <= Math.ceil(ci + R + 1); i++) for (let k = Math.floor(ck - rz - 1); k <= Math.ceil(ck + rz + 1); k++) {
    const c = W.col(i, k);
    if (!c || c.water || c.stage || (!o.any && W.claimed(i, k)) || c.rr > 0.93) continue;
    const d = Math.hypot((i + 0.5 - ci) / R, (k + 0.5 - ck) / rz) + (noise2(i * 0.5, k * 0.5, W.seed + 5) - 0.5) * 0.3;
    if (d > 1) continue;
    const h = c.h;
    if (o.ice) W.C.set(i, h - 1, k, h3(i, 0, k, W.seed) > 0.78 ? 0xeef9ff : 0xbfe4f4, M_SOLID, 0.02);
    else {
      W.C.set(i, h - 2, k, o.bed ?? 0x7a6a4a);
      W.C.set(i, h - 1, k, o.color ?? 0x3b9be0, M_WATER, 0.03);
      c.water = true; c.wl = h; c.h = h - 1;
    }
    W.claims.add(W.ck(i, k));
  }
}

/** Interior cut-away: walls along the back (−z) and left (−x) edges of a square slab. */
function interiorShell(W, o) {
  const { HX, HZ } = W;
  const H = o.wallH ?? 14;
  W.walls = true;
  W.wallH = H;
  const wall = (side, a, y) => (y === 0 ? o.base ?? 0x5a3a24 : y === H - 1 ? o.crown ?? 0xf3efe7 : o.wall(side, a, y));
  for (let i = -HX; i < HX; i++) for (let y = 0; y < H; y++) W.C.set(i, y, -HZ, wall("back", i, y), M_SOLID, 0.04);
  for (let k = -HZ + 1; k < HZ; k++) for (let y = 0; y < H; y++) W.C.set(-HX, y, k, wall("left", k, y), M_SOLID, 0.04);
  W.claim(-HX, HX - 1, -HZ, -HZ);
  W.claim(-HX, -HX, -HZ, HZ - 1);
  W.wallSlots = { back: [], left: [] };
  for (let i = -HX + 6; i <= HX - 6; i += 9) W.wallSlots.back.push([i, -HZ + 1]);
  for (let k = -HZ + 7; k <= HZ - 7; k += 9) W.wallSlots.left.push([-HX + 1, k]);
  // shuffle deterministically so scene props spread out
  for (const l of [W.wallSlots.back, W.wallSlots.left]) for (let n = l.length - 1; n > 0; n--) { const m = (W.rng() * (n + 1)) | 0; [l[n], l[m]] = [l[m], l[n]]; }
}
/** Take a wall slot (for a setting's own wall decorations). */
function takeWall(W, side) {
  const l = W.wallSlots[side];
  return l && l.length ? l.shift() : null;
}

function mWardrobe(W, i, k, o) {
  const P = W.fp(i, k, o.rot, o.h);
  const wood = o.wood ?? 0x8a5a34;
  P.box(-7, 6, 0, 26, -4, 1, (x, y, z) => (y === 26 || y === 0 ? mulC(wood, 0.8) : z === 1 && (x === -1 || x === 0) ? mulC(wood, 0.75) : wood));
  P.box(-8, 7, 27, 28, -5, 2, mulC(wood, 0.85));
  P.set(-2, 13, 2, GOLD, M_SOLID, 0); P.set(1, 13, 2, GOLD, M_SOLID, 0);
}
function mPicture(W, x, y, z, w, h, side, colors) {
  // a framed painting on the inside of a wall (fine coords); side "back" faces +z, "left" faces +x
  for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) {
    const edge = a === 0 || b === 0 || a === w - 1 || b === h - 1;
    const c = edge ? GOLD : colors[(b * 2 + (a > w / 2 ? 1 : 0)) % colors.length];
    if (side === "back") W.F.set(x + a, y + b, z, c, M_SOLID, 0.05); else W.F.set(x, y + b, z + a, c, M_SOLID, 0.05);
  }
}
function wallFine(W, side, slot) {
  // fine coords of the inner face for a wall slot [i, k]
  const [i, k] = slot;
  return side === "back" ? [2 * i + 1, 2 * k] : [2 * i, 2 * k + 1];
}
function mHangingLight(W, x, y, z, o = {}) {
  const F = W.F;
  F.box(x, x, y + 6, y + 40, z, z, 0x3a3a3a);
  if (o.chandelier) {
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * TAU, rx = Math.round(Math.cos(t) * 9), rz = Math.round(Math.sin(t) * 9);
      F.set(x + rx, y, z + rz, GOLD, M_SOLID, 0);
      if (a % 2 === 0) { F.set(x + rx, y + 1, z + rz, 0xfaf3e0); F.set(x + rx, y + 2, z + rz, FLAME[0], M_GLOW, 0); }
    }
    const P = painter(F, 0, 0, 0, 0);
    for (let a = 0; a < 8; a++) { const t = (a / 8) * TAU; P.line(x, y + 6, z, x + Math.round(Math.cos(t) * 9), y, z + Math.round(Math.sin(t) * 9), GOLD, M_SOLID, 0); }
    P.ball(x + 0.5, y + 3, z + 0.5, 2.2, 3, 2.2, 0xcfefff, M_GLASS, 0);
    for (let a = 0; a < 10; a++) { const t = (a / 10) * TAU; F.set(x + Math.round(Math.cos(t) * 6), y - 2, z + Math.round(Math.sin(t) * 6), 0xdff4ff, M_GLOW, 0); }
    W.light(x, y - 2, z, 0xffd8a0, 2.2);
  } else {
    F.box(x - 2, x + 2, y, y + 4, z - 2, z + 2, (xx, yy, zz) => (Math.abs(xx - x) === 2 || Math.abs(zz - z) === 2 ? 0x3a2a1a : -1));
    F.box(x - 1, x + 1, y + 1, y + 3, z - 1, z + 1, LAMP, M_GLOW, 0);
    F.box(x - 2, x + 2, y + 5, y + 5, z - 2, z + 2, 0x3a2a1a);
    W.light(x, y + 2, z, 0xffb060, 1.1, 1);
  }
}
function mRails(W, k0, k1, y) {
  // two rails along x between fine z rows; sleepers every 4 units
  const { HX } = W;
  for (let x = -HX * 2 + 1; x < HX * 2 - 1; x++) {
    if (!W.inside(Math.floor(x / 2), Math.floor(k0 / 2))) continue;
    if (x % 4 === 0) W.F.box(x, x + 1, y, y, k0 - 2, k1 + 2, 0x6b4a30);
    W.F.set(x, y + 1, k0, 0xb8bcc4, M_SOLID, 0.03); W.F.set(x, y + 1, k1, 0xb8bcc4, M_SOLID, 0.03);
  }
}
/** Steam locomotive + carriage on the rails (fine). x0 = rear of the engine. */
function mTrain(W, x0, z, y) {
  const F = painter(W.F, x0, y, z, 0);
  const body = 0x2f6a4a, red = 0xa82a2a, blk = 0x22222a, lit = W.dark;
  // engine: boiler, cab, chimney
  F.box(0, 40, 2, 4, -6, 5, blk);
  for (let x = 12; x <= 40; x++) for (let yy = 0; yy <= 12; yy++) for (let zz = -6; zz <= 5; zz++) {
    if (Math.hypot(yy - 6, zz + 0.5) > 6.2) continue;
    F.set(x, 5 + yy, zz, x === 40 ? 0x3a3a42 : (x % 7 === 0 ? GOLD : body), M_SOLID, 0.03);
  }
  F.box(38, 40, 9, 12, -2, 1, LAMP, M_GLOW, 0);
  F.box(28, 31, 17, 26, -2, 1, blk); F.box(27, 32, 27, 28, -3, 2, blk);
  F.box(20, 23, 17, 19, -2, 1, GOLD);
  F.box(0, 13, 5, 26, -7, 6, (x, yy, zz) => (yy >= 15 && yy <= 21 && (zz === -7 || zz === 6) && x > 2 && x < 11 ? (lit ? -1 : 0x9fd3f2) : red));
  if (lit) { F.box(3, 10, 15, 21, -7, -7, LAMP, M_GLOW, 0); F.box(3, 10, 15, 21, 6, 6, LAMP, M_GLOW, 0); }
  F.box(-1, 14, 27, 28, -8, 7, blk);
  F.box(41, 43, 2, 6, -6, 5, red);
  for (const x of [5, 18, 30, 38]) for (const zz of [-7, 6]) {
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) { const d = Math.hypot(a - 4, b - 4); if (d <= 4.4) F.set(x - 4 + a, 1 + b, zz + (zz < 0 ? -1 : 1), d > 3.3 ? blk : d < 1.3 ? GOLD : 0x8a2020); }
  }
  W.emit({ kind: "puff", count: 18, center: [x0 + 29.5, y + 44, z], box: [12, 34, 12], vel: [-2.5, 6, 0], size: [6, 12], colors: [0xf4f4f4, 0xdedede], wob: 1.6, opacity: 0.7 });
  W.light(x0 + 42, y + 10, z, 0xffd090, lit ? 1.2 : 0.2);
  // carriage
  const C = painter(W.F, x0 - 42, y, z, 0);
  C.box(0, 38, 2, 4, -6, 5, blk);
  C.box(0, 38, 5, 23, -7, 6, (x, yy, zz) => {
    const win = yy >= 13 && yy <= 19 && (zz === -7 || zz === 6) && x % 8 >= 2 && x % 8 <= 6;
    if (win) return lit ? -1 : 0x9fd3f2;
    return yy === 11 || yy === 23 ? GOLD : 0x7a2a3a;
  });
  if (lit) C.box(0, 38, 13, 19, -7, 6, (x, yy, zz) => ((zz === -7 || zz === 6) && x % 8 >= 2 && x % 8 <= 6 ? LAMP : -1), M_GLOW, 0);
  C.box(-1, 39, 24, 25, -8, 7, 0x3a3a42);
  for (const x of [6, 32]) for (const zz of [-7, 6]) for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) { const d = Math.hypot(a - 3, b - 3); if (d <= 3.4) C.set(x - 3 + a, 1 + b, zz + (zz < 0 ? -1 : 1), d > 2.4 ? blk : GOLD); }
}

/** Ship hull shape: half-width (blocks) at block i, or 0 outside the hull. */
function hullW(i) {
  const x = (i + 0.5) / 23;
  if (x <= -1 || x >= 1) return 0;
  return 8.4 * (x < 0 ? Math.sqrt(1 - Math.pow(-x, 5)) : Math.sqrt(1 - x * x) * (1 - 0.2 * x));
}

const INTERIOR = { interior: true, HX: 20, HZ: 16, shapeP: 14, edgeNoise: 0, flatBottom: 4, soilDepth: 1, drip: false, stage: { cx: 2, cz: 3, rx: 11, rz: 6 }, azRange: [0.22, 1.0], height: () => 0 };
const rug = (W, i, k, border, a, b) => {
  const s = W.stage;
  const dx = Math.abs(i + 0.5 - s.cx) / (s.rx + 1), dz = Math.abs(k + 0.5 - s.cz) / (s.rz + 1);
  const m = Math.max(dx, dz);
  if (m > 1) return null;
  if (m > 0.86) return border;
  return ((Math.abs(i - s.cx) + Math.abs(k - s.cz)) % 4 < 2) ? a : b;
};

const DEF = {
  meadow: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.1) * 2.4 + back(W, k) * 3),
    top: (W, i, k) => W.pal(GRASS, i, k, 0.16),
    sprinkle: [200, ["tuft", "tuft", "tuft", "flower", "flower", "pebble"]],
    clouds: true,
    deco(W) {
      W.place("backL", 5, mTree, { foot: 1, fruit: W.rng() < 0.5 ? 0xff5a4a : 0 });
      W.place("backR", 5, mTree, { foot: 1 });
      for (let n = 0; n < 3; n++) W.place("any", 2, mBush, { foot: -1 });
      for (let n = 0; n < 7; n++) W.place("any", 2, mFlowerPatch, { foot: -1, n: 8 });
      W.place("front", 2, mRock, { foot: -1 });
      if (!W.dark) W.emit({ kind: "confetti", count: 16, center: [0, 16, 4], box: [90, 20, 60], vel: [2, 0.5, 1], size: [1.6, 2.4], colors: [0xffd23f, 0xffffff, 0xff8fb1, 0x8fd0ff], wob: 5, spin: 1 });
    },
  },
  forest: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.13) * 3 + back(W, k) * 2),
    top: (W, i, k) => W.pal([0x5aa648, 0x4f9a3f, 0x63b04e, 0x6e9440], i, k, 0.22),
    leaves: [0x3f8f3a, 0x4a9a40, 0x357a32, 0x52a843],
    mossC: 0x5a9a3a,
    sprinkle: [170, ["tuft", "tuft", "tuft", "pebble", "flower"]],
    deco(W) {
      const areas = ["backL", "backR", "back", "sideL", "sideR", "backL", "backR", "sideL", "sideR", "back"];
      areas.forEach((a, n) => W.place(a, 4, n % 3 === 1 ? mPine : mTree, { foot: 1, tries: 30, leaves: n % 2 ? [0x3f8f3a, 0x4a9a40, 0x52a843] : undefined }));
      W.place("sideL", 5, mLog, { foot: 0, rot: 0 });
      for (let n = 0; n < 3; n++) W.place(n ? "any" : "frontR", 3, pMushrooms, { foot: -1 });
      for (let n = 0; n < 2; n++) W.place("any", 2, mRock, { foot: -1 });
      for (let n = 0; n < 3; n++) W.place("any", 2, mBush, { foot: -1, dots: 0xd23c4a });
    },
  },
  garden: {
    shapeP: 6, edgeNoise: 0.06,
    height: () => 0,
    top: (W, i, k, c) => {
      if (c.stage) return h3(i, 1, k, W.seed) > 0.5 ? 0xe4d8bc : 0xd8caa8;
      const s = W.stage;
      if (Math.abs(i - s.cx) <= 1 && k > s.cz) return h3(i, 1, k, W.seed) > 0.5 ? 0xe4d8bc : 0xd8caa8;
      return ((i + 64) >> 1) & 1 ? 0x7ccf55 : 0x6cc04a;
    },
    sprinkle: [60, ["tuft", "flower"]],
    clouds: true,
    deco(W) {
      const { HX, HZ } = W;
      mHedge(W, -HX + 3, -HZ + 3, HX - 4, -HZ + 4, 3);
      mHedge(W, -HX + 3, -HZ + 5, -HX + 4, HZ - 7, 2);
      mHedge(W, HX - 4, -HZ + 5, HX - 3, HZ - 7, 2);
      const beds = [0xd8253c, 0xffd23f, 0xb08cff, 0xff8fb1, 0xffffff];
      for (let i = -HX + 7, n = 0; i < HX - 7; i += 3, n++) mFlowerPatch(W, i, -HZ + 6, { n: 3, spread: 1, colors: [beds[(n >> 1) % beds.length]] });
      for (let k = -HZ + 8, n = 0; k < HZ - 8; k += 3, n++) { mFlowerPatch(W, -HX + 6, k, { n: 3, spread: 1, colors: [beds[(n + 2) % beds.length]] }); mFlowerPatch(W, HX - 7, k, { n: 3, spread: 1, colors: [beds[(n + 1) % beds.length]] }); }
      W.place([-14, -12, -12, -10], 2, mTopiary, { foot: -1 });
      W.place([12, 14, -12, -10], 2, mTopiary, { foot: -1, cone: true });
      W.place("frontL", 2, mTopiary, { foot: -1, cone: true });
      W.place("frontR", 2, mTopiary, { foot: -1 });
      if (!W.dark) W.emit({ kind: "confetti", count: 12, center: [0, 14, 0], box: [80, 16, 60], vel: [1.5, 0.4, 1], size: [1.6, 2.2], colors: [0xffffff, 0xffd23f, 0xff8fb1], wob: 5, spin: 1 });
    },
  },
  village: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.1) * 2 + back(W, k) * 2),
    top: (W, i, k) => {
      const s = W.stage, zc = s.cz + s.rz + 1.5 + Math.sin(i * 0.17) * 1.5;
      if (Math.abs(k - zc) < 1.4 && !W.inStage(i, k)) return h3(i, 2, k, W.seed) > 0.5 ? 0xb8905e : 0xa8804e;
      return W.pal(GRASS, i, k, 0.16);
    },
    sprinkle: [140, ["tuft", "tuft", "flower", "pebble"]],
    clouds: true,
    deco(W) {
      const r = W.rng;
      W.place("backL", 6, mHouse, { style: "thatch", tries: 40 });
      W.place("backR", 6, mHouse, { style: "thatch", tries: 40 });
      W.place("sideL", 5, mHouse, { style: "cottage", w: 3, d: 3, tries: 30 });
      W.place("sideR", 2, mHay, {});
      W.place("back", 2, mHay, {});
      W.place("sideR", 5, mTree, { foot: 1, fruit: 0xff5a4a });
      const s = W.stage;
      mFenceLine(W, (s.cx + s.rx + 4) * 2, (s.cz - 8) * 2, (s.cx + s.rx + 4) * 2, (s.cz + 4) * 2);
      for (let n = 0; n < 4; n++) W.place("any", 2, mFlowerPatch, { foot: -1 });
      if (r() < 0.7) W.place("frontL", 4, pBarrels, { foot: 3 });
    },
  },
  city: {
    shapeP: 8, edgeNoise: 0.04,
    height: () => 0,
    top: (W, i, k, c) => {
      if (c.stage) return ((i + k) & 1) ? 0xd2ccc2 : 0xc2bcb2;
      return W.pal([0x9a958e, 0xa6a19a, 0x8e8983], i, k, 0.5) - ((i + 64) % 5 === 0 ? 0x080808 : 0);
    },
    soil: 0x7a746d, stone: 0x6f6a64,
    deco(W) {
      const { HX, HZ } = W;
      for (let i = -HX + 4; i <= HX - 4; i += 7) {
        const kk = -HZ + 4 + ((W.rng() * 2) | 0);
        if (!W.free(i - 3, i + 3, kk - 3, kk + 3, { stage: false })) continue;
        W.claim(i - 3, i + 3, kk - 3, kk + 3);
        mTownHouse(W, i, kk, { floors: 3 + ((W.rng() * 3) | 0), h: 0 });
      }
      for (let k = -HZ + 11; k <= HZ - 6; k += 7) {
        if (!W.free(-HX + 1, -HX + 7, k - 3, k + 3, { stage: false })) continue;
        W.claim(-HX + 1, -HX + 7, k - 3, k + 3);
        mTownHouse(W, -HX + 4, k, { rot: 1, floors: 2 + ((W.rng() * 3) | 0), h: 0 });
      }
      const s = W.stage;
      for (const [a, rr] of [[-2.6, 1.3], [-0.5, 1.3], [2.5, 1.25], [0.6, 1.25]]) {
        const i = Math.round(s.cx + Math.cos(a) * s.rx * rr), k = Math.round(s.cz + Math.sin(a) * s.rz * rr);
        if (W.free(i, i, k, k, { stage: false })) { W.claim(i, i, k, k); mLamp(W, i, k, {}); }
      }
      W.place("sideR", 5, pFountain, { foot: 5 });
      W.place("right", 3, mTree, { foot: 1, r: 3.6, trunk: 6 });
      W.place("frontR", 4, pBench, { foot: -1 });
    },
  },
  street: {
    shapeP: 9, edgeNoise: 0.03, HZ: 18,
    reserve: (W) => W.claim(-W.HX, W.HX - 1, -W.HZ, -W.HZ + 7),
    stage: { cx: 0, cz: 3, rx: 16, rz: 5 },
    height: (W, i, k) => (k < -4 || k > 9 ? 1 : 0),
    top: (W, i, k) => {
      if (k < -4 || k > 9) return k === -5 || k === 10 ? 0xd8d2c8 : ((i + 64) & 1) ? 0xc4bdb2 : 0xb8b1a6;
      return W.pal([0x6e6a66, 0x7a7672, 0x625e5a, 0x86817b], i, k, 0.9);
    },
    soil: 0x7a746d, stone: 0x6a655f,
    deco(W) {
      const { HX, HZ } = W;
      const aw = [0xd8343c, 0x2f7a5a, 0x3a5aa8, 0xe8a030];
      for (let i = -HX + 4, n = 0; i <= HX - 4; i += 7, n++) {
        W.claim(i - 3, i + 3, -HZ + 1, -HZ + 7);
        mTownHouse(W, i, -HZ + 4, { floors: 2 + ((W.rng() * 2) | 0), h: 1, awning: aw[n % aw.length] });
      }
      for (const i of [-18, 0, 18]) { W.claim(i, i, 11, 11); mLamp(W, i, 11, { h: 1 }); }
      for (const i of [-10, 10]) { W.claim(i, i, -6, -6); mLamp(W, i, -6, { h: 1 }); }
      W.place([10, 18, 12, 14], 2, pSign, { foot: -1, h: 1, rot: 0 });
      W.place([-20, -14, 12, 15], 3, pBarrels, { foot: -1, h: 1, rot: 0 });
    },
  },
  castle: {
    reserve: (W) => W.claim(-W.HX, W.HX - 1, -W.HZ, -W.HZ + 6),
    height: (W, i, k) => Math.round(hill(W, i, k, 0.1) * 2 + (k < -10 ? 1 : 0)),
    water: (W, i, k) => (k >= -10 && k <= -8 ? 2 : 0),
    top: (W, i, k) => (k >= -10 && k <= -8 ? 0x8a7a5a : W.pal(GRASS, i, k, 0.16)),
    sprinkle: [120, ["tuft", "tuft", "flower", "pebble"]],
    clouds: true,
    deco(W) {
      const { HX, HZ } = W;
      const st = (x, y, z) => (h3(x, y, z, 3) > 0.84 ? STONE_D : (y % 3 === 0 ? 0xa8a096 : 0xb8b0a4));
      const k0 = -HZ + 3, k1 = -HZ + 5, top = 10;
      for (let i = -HX + 5; i <= HX - 6; i++) {
        const gate = Math.abs(i + 0.5) < 3;
        const h = W.h(i, k0);
        for (let k = k0; k <= k1; k++) for (let y = 0; y < top; y++) {
          if (gate && y < 6) continue;
          W.C.set(i, h + y, k, st(i, y, k), M_SOLID, 0.05);
        }
        if (i % 2 === 0) W.C.set(i, h + top, k1, st(i, top, k1));
        if (i % 2 === 0) W.C.set(i, h + top, k0, st(i, top, k0));
        W.claim(i, i, k0, k1);
      }
      // gate: portcullis + bridge
      const gh = W.h(0, k0);
      const G = painter(W.F, 0, gh * 2, 2 * k1 + 2, 0);
      for (let x = -6; x <= 5; x++) if (x % 2 === 0) G.box(x, x, 2, 11, -1, -1, IRON);
      G.box(-6, 5, 7, 7, -1, -1, IRON);
      for (let k = -10; k <= -8; k++) for (let i = -2; i <= 1; i++) { const c = W.col(i, k); if (c && c.water) W.C.set(i, c.wl - 1, k, (k & 1) ? WOOD_L : WOOD, M_SOLID, 0.05); }
      // towers with cone roofs
      for (const ti of [-HX + 4, HX - 5]) {
        const h = W.h(ti, k0 + 1);
        const P = painter(W.C, ti, h, k0 + 1, 0);
        P.cyl(0.5, 0.5, 3.4, 0, 14, (x, y, z) => st(x, y, z), M_SOLID, 0.05);
        P.cyl(0.5, 0.5, 3.9, 15, 15, STONE_D);
        P.cyl(0.5, 0.5, 3.9, 16, 16, (x, y, z) => ((x + z) & 1 ? STONE : -1));
        for (let t = 0; t < 7; t++) P.cyl(0.5, 0.5, 3.6 - t * 0.52, 16 + t, 16 + t, W.snowy ? 0xf3f7ff : 0x3d5a9a);
        P.box(0, 0, 23, 25, 0, 0, WOOD_D);
        P.box(0, 0, 8, 9, 4, 4, W.dark ? LAMP : 0x2a3040, W.dark ? M_GLOW : M_SOLID, 0);
        W.claim(ti - 4, ti + 4, k0 - 3, k0 + 5);
        if (W.dark) W.light(ti * 2 + 1, (h + 9) * 2, (k0 + 5) * 2, 0xffb050, 0.7);
      }
      for (const bx of [-14, 12]) mBanner(W, bx * 2, (k1 + 1) * 2 + 1, bx < 0 ? 0xc8343c : 0x3a5aa8, { h: 26 });
      W.place("sideL", 4, mPine, { foot: 1 });
      W.place("sideR", 5, mTree, { foot: 1 });
      W.place("front", 2, mRock, { foot: -1 });
    },
  },
  palace: {
    shapeP: 7, edgeNoise: 0.04,
    reserve: (W) => { W.claim(-19, 18, -W.HZ, -W.HZ + 8); W.claim(-2, 1, -W.HZ + 8, W.stage.cz); },
    height: () => 0,
    top: (W, i, k, c) => {
      const s = W.stage;
      if (Math.abs(i + 0.5) < 2 && k < s.cz && k > -W.HZ + 7) return Math.abs(i + 0.5) < 1 ? 0xb8283c : GOLD;
      if (c.stage) return ((i + k) & 1) ? 0xf4efe6 : 0xe4c8c0;
      return Math.abs(i) > 14 && k > -6 ? W.pal(GRASS, i, k, 0.2) : ((i + k) & 1) ? 0xece6dc : 0xe0d8cc;
    },
    soil: 0xd8d0c4, stone: 0xb8b0a4,
    clouds: true,
    deco(W) {
      const { HZ } = W;
      const k0 = -HZ + 2, k1 = -HZ + 6, H = 8;
      const wall = 0xf6efe2, trim = GOLD, lit = W.dark;
      for (let i = -18; i <= 17; i++) for (let k = k0; k <= k1; k++) for (let y = 0; y < H; y++) {
        const front = k === k1;
        const win = front && y >= 2 && y <= 4 && (i + 64) % 3 === 1 && Math.abs(i + 0.5) > 3;
        const door = front && y < 5 && Math.abs(i + 0.5) < 2;
        if (door) { if (y < 4) W.C.set(i, y, k, lit ? 0xffcf7a : 0x5a2a1a, lit ? M_GLOW : M_SOLID, 0); else W.C.set(i, y, k, trim); continue; }
        W.C.set(i, y, k, win ? (lit ? LAMP : 0x8ab8d8) : y === H - 1 || y === 0 ? trim : wall, win && lit ? M_GLOW : M_SOLID, win ? 0 : 0.03);
      }
      for (let i = -18; i <= 17; i += 2) W.C.set(i, H, k1, trim);
      W.claim(-19, 18, k0, k1 + 2);
      for (let i = -17; i <= 16; i += 4) if (Math.abs(i + 0.5) > 3) mColumn(W, i, k1 + 2, H + 1, { color: 0xfffaf2, cap: GOLD, h: 0 });
      const dome = (ci, R, y0) => {
        const P = painter(W.C, ci, y0, (k0 + k1) >> 1, 0);
        P.cyl(0.5, 0.5, R * 0.8, 0, 2, wall);
        P.ball(0.5, 2, 0.5, R, R * 0.9, R, (x, y, z, dx, dy) => (dy < 0 ? -1 : h3(x, y, z, 2) > 0.8 ? 0xf7d36a : GOLD), M_SOLID, 0.04);
        P.box(0, 0, Math.round(2 + R * 0.9), Math.round(4 + R * 0.9), 0, 0, GOLD);
      };
      dome(0, 5, H); dome(-14, 2.6, H); dome(13, 2.6, H);
      if (lit) W.light(1, 6, (k1 + 2) * 2, 0xffc070, 1.2);
      for (const [i, k] of [[-8, -6], [7, -6], [-8, 0], [7, 0]]) if (W.free(i - 1, i + 1, k - 1, k + 1, { stage: false })) { W.claim(i - 1, i + 1, k - 1, k + 1); mTopiary(W, i, k, { cone: true, pot: 0xe8e0d0 }); }
      W.place("sideL", 5, pFountain, { foot: 5 });
      W.place("sideR", 5, pFountain, { foot: 5 });
    },
  },
  desert: {
    height: (W, i, k) => Math.max(0, Math.round(Math.sin(i * 0.2 + hill(W, i, k, 0.08) * 4) * 1.4 + hill(W, i, k, 0.12) * 2 + back(W, k) * 3.5)),
    top: (W, i, k) => SAND[((i + Math.round(k * 0.5) + 64) % 3 === 0 ? 1 : 0) + (h3(i, 0, k, W.seed) > 0.8 ? 2 : 0)],
    soil: 0xe0b46a, soilDepth: 3,
    stone: (W, i, j) => [0xd9874e, 0xc8703e, 0xe8a066][(j + 30) % 3],
    rockC: 0xc8865a,
    sprinkle: [70, ["pebble", "bone", "pebble"]],
    deco(W) {
      W.place("backL", 4, mMesa, { foot: 3, H: 9 });
      W.place("backR", 3, mMesa, { foot: 2, H: 6 });
      for (let n = 0; n < 4; n++) W.place(n < 2 ? "sideL" : "sideR", 3, mCactus, { foot: 1 });
      W.place("sideR", 2, mRock, { foot: -1, color: 0xc8865a });
      W.place("front", 2, mRock, { foot: -1, color: 0xd89a6a });
      const sp = W.place("sideL", 4, (w, i, k) => { pond(w, i, k, 2.6, { color: 0x3fb8d8, bed: 0xd8b070, any: true }); }, { foot: -1 });
      if (sp) { mPalm(W, sp[0] + 3, sp[1] - 2, { h: W.h(sp[0] + 3, sp[1] - 2) }); }
    },
  },
  sea: {
    shapeP: 4, edgeNoise: 0.12, depth: 6,
    stageH: 1,
    stageKeep: () => true,
    height: (W, i, k) => (Math.hypot((i - 15) / 5, (k + 11) / 4.2) < 1 ? 1 : 0),
    water: (W, i, k, rr) => (Math.hypot((i - 15) / 5, (k + 11) / 4.2) < 1 ? 0 : 3 + (rr > 0.6 ? 1 : 0)),
    waterColor: 0x2f8fd8,
    top: (W, i, k, c) => (c.h > 0 ? W.pal(SAND, i, k, 0.3) : 0xe2cf9a),
    soil: 0xd8c08a, stone: 0x8a8580,
    clouds: true,
    deco(W) {
      mPier(W, 0);
      W.claim(14, 16, -12, -10);
      mLighthouse(W, 15, -11, { h: 1 });
      W.place("sideL", 5, pBoat, { water: true, foot: -1, h: 0, rot: 1 });
      for (let n = 0; n < 3; n++) W.place("any", 1, (w, i, k) => mRock(w, i, k, { h: w.col(i, k).wl - 1, r: 1.6 + w.rng() }), { water: true, foot: -1 });
      if (!W.dark) W.emit({ kind: "sparkle", count: 40, center: [0, 1.5, 0], box: [100, 2, 80], vel: [0, 0, 0], size: [1.2, 2.4], colors: [0xffffff], additive: true, intensity: 1.6, opacity: 0.8 });
      W.emit({ kind: "leaf", count: 6, center: [0, 46, -20], box: [140, 20, 60], vel: [9, 0, 2], size: [3, 3.6], colors: [0xffffff, 0xeeeeee], wob: 3, spin: 0.5 });
    },
  },
  ship: {
    shapeP: 4, edgeNoise: 0.1, depth: 5,
    stageH: 3, stageKeep: () => true,
    stage: { cx: -1, cz: 1, rx: 12, rz: 4.6 },
    reserve: (W) => { W.claim(-23, 22, -9, -5); W.claim(-24, -16, -3, 3); },
    height: () => 0,
    water: () => 3,
    waterColor: 0x2a86d0,
    column(W, c) {
      const w = hullW(c.i);
      if (!(w > 0 && Math.abs(c.k + 0.5) < w)) return;
      const stern = c.i < -17;
      c.water = false; c.wl = 0; c.h = stern ? 4 : 3; c.bottom = -2; c.hull = true;
      c.paint = (j, d) => (d === 0 ? undefined : j >= 3 ? 0x8a5530 : j === 2 ? 0x7a4a2a : j === 1 ? 0xf0e6d0 : j === 0 ? 0x5a3520 : 0x3a2a22);
    },
    top: (W, i, k, c) => (c.hull ? ((i + 64) % 6 === 0 ? 0xa07848 : (k & 1) ? 0xc8a06a : 0xbb935c) : 0xd8c08a),
    soil: 0x7a4a2a, stone: 0x5a3a24, soilDepth: 1, drip: false,
    deco(W) {
      // rails along the hull edge
      for (const c of W.cols.values()) {
        if (!c.hull) continue;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !(W.col(c.i + a, c.k + b) || {}).hull);
        if (!edge) continue;
        const x = 2 * c.i, z = 2 * c.k, y = c.h * 2;
        W.F.box(x, x + 1, y, y + 5, z, z + 1, (x + z) % 4 === 0 ? 0x5a3520 : -1);
        W.F.box(x, x + 1, y + 6, y + 6, z, z + 1, 0x6b4426);
      }
      W.claim(-23, 22, -9, -5);
      for (const mx of [-8, 9]) {
        const F = painter(W.F, mx * 2, 6, -12, 0);
        F.box(0, 1, 0, 86, 0, 1, 0x6b4426);
        F.box(-1, 2, 70, 73, -1, 2, 0x5a3520);
        for (const [y0, y1, hw] of [[30, 50, 16], [54, 68, 12]]) {
          F.box(-hw, hw + 1, y1 + 1, y1 + 1, 0, 1, 0x5a3520);
          for (let y = y0; y <= y1; y++) {
            const bulge = Math.round(Math.sin(((y - y0) / (y1 - y0)) * Math.PI) * 3);
            F.box(-hw + 1, hw, y, y, 2 + bulge, 2 + bulge, h3(y, mx, 0, 2) > 0.9 ? 0xeae2d0 : 0xf8f4ea, M_SOLID, 0.02);
          }
        }
        F.box(2, 12, 80, 85, 0, 0, RED);
      }
      // wheel at the stern, bowsprit
      const S = painter(W.F, -36, 10, 0, 0);
      S.box(0, 0, 0, 8, -1, 0, WOOD_D);
      for (let a = 0; a < 8; a++) { const t = (a / 8) * TAU; S.line(1, 12, 0, 1, 12 + Math.round(Math.sin(t) * 5), Math.round(Math.cos(t) * 5), 0x8a5530); }
      painter(W.F, 44, 8, 0, 0).line(0, 0, 0, 18, 8, 0, WOOD_D, M_SOLID, 0, 1);
      for (const [x, z] of [[-26, -5], [-24, 6], [26, -4]]) painter(W.F, x, 6, z, 0).cyl(0, 0, 3, 0, 7, (xx, y) => (y === 1 || y === 6 ? 0x3a3a3a : 0x8a5a34), M_SOLID, 0.05);
      W.emit({ kind: "leaf", count: 6, center: [0, 70, -20], box: [140, 20, 60], vel: [9, 0, 2], size: [3, 3.6], colors: [0xffffff], wob: 3, spin: 0.5 });
    },
  },
  island: {
    shapeP: 3, edgeNoise: 0.1, depth: 6,
    stage: { cx: 0, cz: 1, rx: 13, rz: 6.5 },
    height: (W, i, k) => { const d = Math.hypot((i + 0.5) / 19, (k + 0.5) / 12.5); return d < 1 ? 1 + (d < 0.55 ? 1 : 0) : 0; },
    water: (W, i, k) => (Math.hypot((i + 0.5) / 19, (k + 0.5) / 12.5) < 1 ? 0 : 2),
    stageH: 2,
    waterColor: 0x2fc8d8,
    top: (W, i, k, c) => (c.water ? 0xf0e0b0 : W.pal(SAND, i, k, 0.3)),
    soil: 0xe6c27c, stone: 0x9a8f86,
    sprinkle: [60, ["shell", "pebble", "shell"]],
    clouds: true,
    deco(W) {
      for (const a of [-2.5, -1.6, -0.6, 2.7, 0.4]) {
        const i = Math.round(Math.cos(a) * 16), k = Math.round(Math.sin(a) * 10);
        if (W.free(i - 1, i + 1, k - 1, k + 1, { stage: false }) && !W.inStage(i, k, 1)) { W.claim(i - 2, i + 2, k - 2, k + 2); mPalm(W, i, k, { lean: i < 0 ? -1 : 1 }); }
      }
      W.place("backL", 4, mHouse, { style: "thatch", w: 3, d: 3, tries: 30, chimney: false });
      for (let n = 0; n < 3; n++) W.place("any", 1, (w, i, k) => { const c = w.col(i, k); mRock(w, i, k, { h: c.water ? c.wl - 1 : c.h, r: 1.4 + w.rng() }); }, { water: true, foot: -1 });
      W.place("frontR", 2, mBush, { foot: -1, dots: 0xff6b8a });
    },
  },
  snow: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.12) * 2.5 + back(W, k) * 4),
    top: (W, i, k) => W.pal(SNOWC, i, k, 0.3),
    soil: 0xdfe8f2, stone: 0x8a96a8, rockC: 0x9aa4b4,
    sprinkle: [90, ["snow", "snow", "pebble"]],
    clouds: true,
    deco(W) {
      for (const a of ["backL", "backR", "back", "sideL", "sideR", "backL", "sideR"]) W.place(a, 4, mPine, { foot: 1, tries: 30 });
      W.place("frontL", 3, mSnowman, { foot: 1 });
      W.place("sideR", 5, (w, i, k) => pond(w, i, k, 3.6, { ice: true, rz: 2.6, any: true }), { foot: -1 });
      W.place("sideL", 3, pCrystal, { foot: 1 });
      for (let n = 0; n < 2; n++) W.place("any", 2, mRock, { foot: -1 });
    },
  },
  mountains: {
    height: (W, i, k) => {
      const b = back(W, k);
      const ridge = Math.pow(b, 1.3) * (13 + hill(W, i, k, 0.16) * 9) * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.16 + 1.3)));
      const side = Math.pow(clamp((Math.abs(i + 0.5) / W.HX - 0.6) / 0.4, 0, 1), 1.5) * 7 * (k < 6 ? 1 : 0.3);
      return Math.round(Math.max(ridge, side) + hill(W, i, k, 0.22, 3) * 1.5);
    },
    top: (W, i, k, c) => (c.h >= 11 ? W.pal(SNOWC, i, k, 0.4) : c.h >= 6 ? W.pal([0x9a958e, 0x8a857e, 0xa8a39c], i, k, 0.5) : W.pal([0x6cb850, 0x5fa848, 0x76c058], i, k, 0.2)),
    soil: (W, i, k, c) => (c.h >= 6 ? 0x8a857e : DIRT),
    stone: 0x7f7a74,
    sprinkle: [120, ["tuft", "tuft", "pebble", "flower"]],
    clouds: true,
    deco(W) {
      for (let n = 0; n < 9; n++) W.place(["sideL", "sideR", "backL", "backR", "back"][n % 5], 3, mPine, { foot: 1, tries: 20, s: 0.85 });
      for (let n = 0; n < 3; n++) W.place("any", 2, mRock, { foot: -1 });
      W.emit({ kind: "leaf", count: 4, center: [0, 70, -30], box: [120, 16, 40], vel: [7, 0, 0], size: [4, 5], colors: [0x3a2a20], wob: 4, spin: 0.4 });
    },
  },
  cave: {
    shapeP: 3, edgeNoise: 0.1, depth: 7,
    alwaysDark: true,
    height: (W, i, k) => {
      const b = back(W, k), sd = clamp((Math.abs(i + 0.5) / W.HX - 0.62) / 0.38, 0, 1);
      const wall = Math.max(b > 0.45 ? 9 + b * 9 : 0, sd > 0 && k < 8 ? 6 + sd * 10 : 0);
      return Math.round(wall + hill(W, i, k, 0.25) * (wall > 0 ? 4 : 1.2));
    },
    top: (W, i, k, c) => (c.h > 4 ? W.pal([0x5a5550, 0x645f59, 0x524d48], i, k, 0.4) : W.pal([0x6f6a64, 0x625d58, 0x7a756e, 0x6a6058], i, k, 0.35)),
    soil: 0x55504b, stone: (W, i, j, k) => (h3(i, j, k, 4) > 0.9 ? 0x6a5a7a : 0x4f4a45), rockC: 0x5f5a55,
    sprinkle: [90, ["pebble", "glowshroom", "pebble", "bone"]],
    deco(W) {
      const { HX, HZ } = W;
      // overhanging ceiling with stalactites
      for (let i = -HX; i < HX; i++) for (let k = -HZ; k < -HZ + 11; k++) {
        const c = W.col(i, k);
        if (!c || c.h < 8) continue;
        const reach = 7 + Math.round(noise2(i * 0.3, 0, W.seed + 8) * 5);
        for (let kk = k; kk < Math.min(k + reach, -2); kk++) {
          const cc = W.col(i, kk);
          if (!cc || cc.h >= 15) continue;
          for (let y = 15; y <= 16; y++) W.C.set(i, y, kk, 0x4f4a45, M_SOLID, 0.08);
          if (kk === k + reach - 1 && h3(i, 3, kk, W.seed) > 0.55) mSpike(W, i, 14, kk, 2 + ((h3(i, 4, kk, W.seed) * 4) | 0), -1, 0x6a645e);
        }
        break;
      }
      for (let n = 0; n < 3; n++) W.place(["backL", "backR", "sideL"][n], 3, pCrystal, { foot: 1 });
      for (let n = 0; n < 4; n++) W.place("any", 1, (w, i, k, o) => mSpike(w, i, o.h, k, 3 + ((w.rng() * 4) | 0), 1, 0x6a645e), { foot: 0 });
      W.place("sideR", 3, pMushrooms, { foot: -1 });
      W.place("sideR", 4, (w, i, k) => pond(w, i, k, 3, { color: 0x1f7a8a, bed: 0x3a3a40, any: true }), { foot: -1 });
      for (const i of [-8, 8]) { const c = W.col(i, -HZ + 7); if (c) mTorch(W, 2 * i, c.h * 2 + 12, 2 * (-HZ + 7) + 2); }
      W.emit({ kind: "dot", count: 50, center: [0, 22, 0], box: [90, 34, 70], vel: [0, 0.6, 0], size: [0.6, 1.1], colors: [0x9ff4ff, 0xc8a0ff], wob: 2, additive: true, intensity: 2.4 });
    },
  },
  swamp: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.14) * 1.6 + back(W, k) * 1.5),
    water: (W, i, k) => (hill(W, i, k, 0.17, 9) > 0.6 ? 1 : 0),
    waterColor: 0x55703a,
    top: (W, i, k) => W.pal([0x5f7038, 0x56663a, 0x6b7a40, 0x4f5f30], i, k, 0.3),
    soil: 0x4a3a28, stone: 0x4a4a42,
    leaves: [0x4a6a2a, 0x5a7a30, 0x3f5a24], mossC: 0x6a8a3a,
    sprinkle: [170, ["reed", "reed", "tuft", "pebble"]],
    alwaysFog: true,
    deco(W) {
      for (const a of ["backL", "backR", "sideL", "sideR", "back"]) W.place(a, 3, mDeadTree, { foot: 1, moss: 0x7a9a4a, bark: 0x5e5446 });
      W.place("sideR", 3, pMushrooms, { foot: -1 });
      for (const c of W.cols.values()) if (c.water && h3(c.i, 7, c.k, W.seed) > 0.8) {
        const x = 2 * c.i + 1, z = 2 * c.k + 1, y = c.wl * 2 - 1;
        W.F.box(x - 1, x + 1, y, y, z - 1, z + 1, 0x4f9a3f, M_SOLID, 0.08);
        if (h3(c.i, 8, c.k, W.seed) > 0.6) W.F.set(x, y + 1, z, 0xff9ab8);
      }
      W.place("frontL", 3, mLog, { foot: 0, rot: 1 });
      W.emit({ kind: "dot", count: 36, center: [0, 14, 0], box: [100, 24, 80], vel: [0, 0.5, 0], size: [0.8, 1.3], colors: [0xd8ff7a, 0xb8ff6a], wob: 4, additive: true, intensity: W.dark ? 3 : 1.2 });
    },
  },
  battlefield: {
    height: (W, i, k) => Math.round(hill(W, i, k, 0.12) * 2.2 + back(W, k) * 2),
    top: (W, i, k) => (hill(W, i, k, 0.25, 5) > 0.55 ? W.pal([0x6b5a3e, 0x7a6a4a, 0x5f4f36], i, k, 0.5) : W.pal([0x7a9a4a, 0x6f8f42, 0x86a050], i, k, 0.3)),
    sprinkle: [90, ["pebble", "tuft", "pebble"]],
    deco(W) {
      for (let n = 0; n < 3; n++) W.place("any", 3, (w, i, k) => mCrater(w, i, k, 2.4), { foot: -1 });
      W.place("backL", 5, mBarricade, { foot: 1, rot: 0 });
      W.place("backR", 5, mBarricade, { foot: 1, rot: 0 });
      const s = W.stage;
      for (const [side, col, em] of [[-1, 0xc8343c, GOLD], [1, 0x2f5aa8, 0xf3efe7]]) for (const dz of [-6, 2]) {
        const i = Math.round(s.cx + side * (s.rx + 3)), k = s.cz + dz;
        if (!W.inside(i, k) || W.claimed(i, k)) continue;
        W.claim(i, i + 4, k, k);
        mBanner(W, 2 * i, 2 * k, col, { emblem: em, h: 28 });
      }
      W.place("sideL", 3, pFire, { foot: 1 });
      W.place("back", 5, pCart, { foot: 2, rot: 1 });
      for (let n = 0; n < 5; n++) {
        const x = Math.round((W.rng() - 0.5) * 80), z = Math.round((W.rng() - 0.5) * 60);
        const i = Math.floor(x / 2), k = Math.floor(z / 2);
        if (!W.inside(i, k) || W.inStage(i, k, 1) || W.claimed(i, k)) continue;
        painter(W.F, x, W.groundU(x, z), z, 0).line(0, 0, 0, Math.round((W.rng() - 0.5) * 6), 16, 3, WOOD, M_SOLID, 0.04);
      }
      W.emit({ kind: "puff", count: 22, center: [-30, 30, -24], box: [16, 50, 16], vel: [2, 6, 0], size: [8, 16], colors: [0x5a5550, 0x6a6560], wob: 2, opacity: 0.55 });
      W.emit({ kind: "dot", count: 30, center: [0, 20, 0], box: [100, 40, 70], vel: [2, 5, 0], size: [0.7, 1.2], colors: [0xffa040, 0xff7020], wob: 2.5, additive: true, intensity: 3 });
    },
  },
  space: {
    HX: 18, HZ: 18, shapeP: 2, edgeNoise: 0.03, frame: 1.32, camY: -13,
    stage: { cx: 0, cz: 1, rx: 10, rz: 6 },
    stageH: 4,
    height: (W, i, k, rr) => Math.round(Math.sqrt(Math.max(0, 1 - rr * rr)) * 9.5) - 5,
    bottom: (W, i, k, rr) => -Math.round(Math.sqrt(Math.max(0, 1 - rr * rr)) * 15) - 5,
    top: (W, i, k) => W.pal([0xe2c4a8, 0xd4b496, 0xeccfb4, 0xc9a98c], i, k, 0.3),
    soil: 0xb08a70, stone: (W, i, j, k) => (h3(i, j, k, 2) > 0.85 ? 0x9a7aa0 : 0x8a7a8a), rockC: 0xa898a8,
    sprinkle: [50, ["pebble", "pebble", "tuft"]],
    space: true,
    deco(W) {
      for (let n = 0; n < 2; n++) W.place("any", 2, (w, i, k) => mCrater(w, i, k, 1.8), { foot: -1 });
      for (let n = 0; n < 2; n++) W.place(n ? "backR" : "backL", 2, (w, i, k, o) => {
        const P = w.fp(i, k, 0, o.h);
        for (let y = 0; y < 7; y++) P.cyl(0, 0, 4.6 - y * 0.55, y, y, (x, yy, z, dx, dz) => (y > 4 && Math.hypot(dx, dz) < 1.4 ? (y === 5 ? 0xff7a2a : -1) : 0x8a7a8a), y === 5 ? M_SOLID : M_SOLID, 0.06);
        P.cyl(0, 0, 1.2, 5, 5, 0xff8a3a, M_GLOW, 0);
        w.emit({ kind: "puff", count: 8, center: [2 * i + 1, o.h * 2 + 14, 2 * k + 1], box: [5, 14, 5], vel: [0, 3, 0], size: [3, 5], colors: [0xb0a8b8], opacity: 0.5, wob: 0.6 });
      }, { foot: 1 });
      W.place("sideL", 2, (w, i, k, o) => { const P = w.fp(i, k, 0, o.h); P.box(-1, 0, 0, 5, -1, 0, 0x6b4a30); P.ball(0, 8, 0, 3.4, 3, 3.4, 0x4f9a4a, M_LEAF, 0.06); }, { foot: 0 });
      W.place("sideR", 2, pCrystal, { foot: 1 });
      for (const p of [[-62, 6, -30], [64, 18, -44], [-40, 34, -70], [30, -12, -40], [-70, -20, 20], [74, -6, 26]]) addRockFloater(W, p, 0.8 + W.rng() * 0.8);
    },
  },
  room: {
    ...INTERIOR,
    top: (W, i, k) => rug(W, i, k, 0xa83a3a, 0xe8c87a, 0xc04a4a) ?? (((i + 64) & 1) ? 0xc8945a : 0xb8844e) - (((k + (i & 1) * 3 + 64) % 6 === 0) ? 0x101008 : 0),
    soil: 0x7a5236, stone: 0xb8b0a4,
    wall: { wallH: 13, base: 0xf3efe7, wall: (side, a, y) => (((a + 64) & 1) ? 0xbfdccc : 0xcde6d8) },
    deco(W) {
      const b = takeWall(W, "back"); if (b) pWindow(W, b[0], b[1], { rot: 0, h: 0, wall: true });
      const l = takeWall(W, "left"); if (l) pWindow(W, l[0], l[1], { rot: 1, h: 0, wall: true });
      W.place([-15, -11, -11, -9], 5, pBed, { rot: 0, foot: -1, h: 0 });
      W.place([8, 12, -13, -13], 2, mWardrobe, { rot: 0, foot: -1, h: 0 });
      W.place([-18, -18, 3, 8], 1, pBookshelf, { rot: 1, foot: -1, h: 0, wide: 5 });
      W.place("frontR", 2, mTopiary, { foot: -1, h: 0 });
      const pic = takeWall(W, "back");
      if (pic) { const [fx, fz] = wallFine(W, "back", pic); mPicture(W, fx - 4, 12, fz, 9, 7, "back", [0x5a8ad8, 0x7ac05a, 0xf0d070]); }
      const lamp = W.place([15, 17, -6, -2], 1, (w, i, k) => { const P = w.fp(i, k, 0, 0); P.box(-1, 0, 0, 18, -1, 0, 0x3a3a3a); P.box(-3, 2, 19, 23, -3, 2, 0xf6d9a0, M_GLOW, 0); w.light(2 * i + 1, 22, 2 * k + 1, 0xffc070, 1.3); }, { foot: -1, h: 0 });
      void lamp;
    },
  },
  library: {
    ...INTERIOR,
    top: (W, i, k) => rug(W, i, k, 0x2a3a6a, 0x8a2a2a, 0x7a2424) ?? ((((i + k + 64) >> 1) & 1) ? 0x6a4228 : 0x7a4e30),
    soil: 0x4a2e1c, stone: 0x6f6a64,
    wall: { wallH: 18, base: 0x4a2e1c, crown: 0x5a3a24, wall: (side, a, y) => (y < 5 ? 0x6a4428 : 0x2f5a4a) },
    deco(W) {
      for (const side of ["back", "left"]) {
        for (let n = 0; n < 2; n++) {
          const s = takeWall(W, side);
          if (!s) continue;
          const [i, k] = side === "back" ? [s[0], s[1] + 1] : [s[0] + 1, s[1]];
          W.claim(i - 4, i + 4, k - 4, k + 4);
          pBookshelf(W, i, k, { rng: W.rng, rot: side === "back" ? 0 : 1, h: 0, tall: 33, wide: 8 });
        }
      }
      W.place([10, 14, 8, 11], 4, pDesk, { foot: -1, h: 0, rot: 3 });
      W.place([-14, -10, 9, 11], 2, pChair, { foot: -1, h: 0, rot: 1 });
      W.place("frontL", 2, (w, i, k, o) => { const P = w.fp(i, k, 0, 0); P.box(-1, 0, 0, 6, -1, 0, GOLD); P.ball(0, 11, 0, 4.5, 4.5, 4.5, (x, y, z) => (h3(x, y, z, 6) > 0.55 ? 0x4aa0d8 : 0x6ac060), M_SOLID, 0.04); }, { foot: -1, h: 0 });
      for (let n = 0; n < 7; n++) {
        const x = Math.round((W.rng() - 0.3) * 50), z = Math.round((W.rng() - 0.4) * 34), y = 30 + Math.round(W.rng() * 10);
        W.F.box(x, x, y, y + 2, z, z, 0xfaf3e0); W.F.set(x, y + 3, z, FLAME[0], M_GLOW, 0);
      }
      W.light(0, 36, 0, 0xffc070, 1.2, 1);
    },
  },
  school: {
    ...INTERIOR,
    reserve: (W) => {
      W.claim(W.stage.cx - 8, W.stage.cx + 7, -W.HZ + 1, -W.HZ + 2);
      W.wallSlots.back = W.wallSlots.back.filter(([i]) => i < W.stage.cx - 11 || i > W.stage.cx + 11);
    },
    top: (W, i, k) => (((i + k) & 1) ? 0xd8d0c0 : 0xc4bcac),
    soil: 0x8a7a6a, stone: 0xb8b0a4,
    wall: { wallH: 14, base: 0x5a6a5a, wall: (side, a, y) => (y < 5 ? 0x7aa88a : y === 5 ? 0x5a8a6a : 0xf0e8d4) },
    deco(W) {
      const HZ = W.HZ;
      const bx = 2 * W.stage.cx - 14, bz = 2 * (-HZ + 1);
      for (let x = 0; x < 30; x++) for (let y = 0; y < 14; y++) {
        const edge = x === 0 || y === 0 || x === 29 || y === 13;
        const chalk = !edge && y > 3 && y < 11 && h3(x, y, 1, W.seed) > (y % 3 === 0 ? 0.4 : 0.93);
        W.F.set(bx + x, 9 + y, bz, edge ? WOOD : chalk ? 0xe8efe8 : 0x2a4a3a, M_SOLID, 0.04);
      }
      W.F.box(bx, bx + 29, 8, 8, bz, bz + 1, WOOD_L);
      for (const [i, k] of [[-14, 6], [-14, 11], [16, 6], [16, 11]]) {
        if (!W.free(i - 2, i + 2, k - 2, k + 2, { stage: false })) continue;
        W.claim(i - 2, i + 2, k - 2, k + 2);
        const P = W.fp(i, k, 0, 0);
        for (const [x, z] of [[-5, -2], [4, -2], [-5, 2], [4, 2]]) P.box(x, x, 0, 8, z, z, 0x8a8a92);
        P.box(-6, 5, 9, 9, -3, 3, WOOD_L);
        P.box(-3, 1, 10, 10, -1, 1, W.rng() < 0.5 ? WHITE : 0xd8e8ff);
        pChair(W, i, k + 3, { rng: W.rng, rot: 2, h: 0 });
      }
      const l = takeWall(W, "left"); if (l) pWindow(W, l[0], l[1], { rot: 1, h: 0, wall: true });
      const l2 = takeWall(W, "left"); if (l2) pWindow(W, l2[0], l2[1], { rot: 1, h: 0, wall: true });
      const ck = takeWall(W, "back");
      if (ck) pClock(W, ck[0], ck[1], { h: 0, wall: true, rot: 0 });
    },
  },
  tavern: {
    ...INTERIOR,
    lampsDay: true,
    reserve: (W) => {
      W.claim(-3, 15, -W.HZ + 1, -W.HZ + 6); W.claim(-W.HX + 1, -W.HX + 4, -4, 8);
      W.wallSlots.back = W.wallSlots.back.filter(([i]) => i < -6 || i > 18);
      W.wallSlots.left = W.wallSlots.left.filter(([, k]) => k < -6 || k > 10);
    },
    top: (W, i, k) => W.pal([0x6a4a30, 0x5e402a, 0x765236], i, k + (i >> 2) * 7, 0.9),
    soil: 0x4a3020, stone: 0x6f6a64,
    wall: { wallH: 13, base: 0x7a746d, crown: 0x4a3020, wall: (side, a, y) => ((a + 64) % 5 === 0 || y === 6 ? 0x4a3020 : 0xe8dcc4) },
    deco(W) {
      const { HX, HZ } = W;
      // bar counter + shelves of bottles along the back wall
      const P = painter(W.F, 2 * 6, 0, 2 * (-HZ + 1), 0);
      P.box(-16, 15, 0, 13, 4, 9, (x, y, z) => (y === 13 ? 0x8a5a34 : y === 0 ? 0x3a2416 : (x % 4 === 0 ? 0x4a3020 : 0x6a4428)));
      for (const y of [16, 24]) {
        P.box(-16, 15, y, y, 0, 3, 0x5a3a24);
        for (let x = -15; x <= 14; x += 2) { const c = [0x2a8a4a, 0x8a2a2a, 0xc8a040, 0x2a4a8a][(x + y + 64) % 4]; P.box(x, x, y + 1, y + 4, 1, 1, c, M_SOLID, 0.05); P.set(x, y + 5, 1, 0x3a2a1a); }
      }
      // fireplace on the left wall
      const fk = 2;
      const F = painter(W.F, 2 * (-HX + 1), 0, 2 * fk, 1);
      F.box(-9, 8, 0, 22, -1, 4, (x, y, z) => (Math.abs(x + 0.5) < 5 && y < 12 && z >= 0 ? -1 : (x + y) % 3 ? 0x8a837d : 0x7a746d));
      F.box(-10, 9, 22, 23, -1, 6, 0x5a3a24);
      F.box(-3, 2, 0, 1, 0, 3, WOOD_D);
      F.ball(-0.5, 3, 1.5, 3.2, 3, 2, FLAME[1], M_GLOW, 0); F.ball(-0.5, 5, 1.5, 2, 2.5, 1.4, FLAME[0], M_GLOW, 0);
      W.light(2 * (-HX + 1) + 6, 8, 2 * fk, 0xff8a3a, 1.8, 2);
      W.place([-12, -9, -10, -7], 4, pBarrels, { foot: -1, h: 0, rot: 0 });
      for (const [i, k] of [[13, 8], [-11, 11]]) {
        if (!W.free(i - 3, i + 3, k - 3, k + 3, { stage: false })) continue;
        W.claim(i - 3, i + 3, k - 3, k + 3);
        const T = W.fp(i, k, 0, 0);
        T.box(-1, 0, 0, 8, -1, 0, WOOD_D); T.cyl(0, 0, 5.5, 9, 9, 0x8a5a34);
        T.box(-2, -1, 10, 12, -2, -1, 0xd8c8a0); T.box(2, 3, 10, 12, 1, 2, 0xd8c8a0);
        T.box(0, 0, 10, 12, 2, 2, 0xfaf3e0); T.set(0, 13, 2, FLAME[0], M_GLOW, 0);
        W.light(2 * i + 1, 16, 2 * k + 1, 0xffb050, 0.6, 1);
      }
      for (const [x, z] of [[-8, -6], [16, 6], [-16, 18]]) mHangingLight(W, x, 34, z);
    },
  },
  ballroom: {
    ...INTERIOR,
    lampsDay: true,
    top: (W, i, k) => ((((i + 64) >> 1) + ((k + 64) >> 1)) & 1 ? 0xf4efe6 : 0x2f2a36),
    soil: 0xd8c8a8, stone: 0xb8b0a4,
    wall: { wallH: 19, base: GOLD, crown: GOLD, wall: (side, a, y) => ((a + 64) % 6 === 0 ? 0xfffaf0 : y === 9 ? GOLD : 0xf2e2d2) },
    deco(W) {
      for (let n = 0; n < 2; n++) { const b = takeWall(W, "back"); if (b) { pWindow(W, b[0], b[1], { rot: 0, h: 0, wall: true }); curtains(W, "back", b); } }
      const l = takeWall(W, "left"); if (l) { pWindow(W, l[0], l[1], { rot: 1, h: 0, wall: true }); curtains(W, "left", l); }
      mHangingLight(W, 2 * W.stage.cx + 1, 40, 2 * W.stage.cz + 1, { chandelier: true });
      W.place([-13, -12, -10, -9], 5, pPiano, { foot: -1, h: 0, rot: 0 });
      for (const [i, k] of [[16, -12], [-17, 13]]) { if (W.free(i - 1, i + 1, k - 1, k + 1, { stage: false })) { W.claim(i - 1, i + 1, k - 1, k + 1); mColumn(W, i, k, 18, { color: 0xfffaf0, cap: GOLD, h: 0 }); } }
      W.emit({ kind: "sparkle", count: 30, center: [4, 30, 6], box: [70, 30, 50], vel: [0, -1, 0], size: [1.2, 2.2], colors: [0xffe8b0, 0xffffff], additive: true, intensity: 2 });
    },
  },
  church: {
    ...INTERIOR,
    lampsDay: true,
    reserve: (W) => {
      W.claim(W.stage.cx - 6, W.stage.cx + 6, -W.HZ + 1, -W.HZ + 6);
      W.wallSlots.back = W.wallSlots.back.filter(([i]) => Math.abs(i - W.stage.cx) > 9);
    },
    top: (W, i, k) => W.pal([0x9a958e, 0x8a857e, 0xa6a19a], i, k, 0.9) - (((i + 64) % 3 === 0 || (k + 64) % 3 === 0) ? 0x0c0c0c : 0),
    soil: 0x7a746d, stone: 0x6f6a64,
    wall: { wallH: 21, base: 0x8a837d, crown: 0x9a938a, wall: (side, a, y) => ((a + y * 3 + 64) % 7 === 0 ? 0xa8a096 : (y & 1) ? 0xbab2a6 : 0xb2aa9e) },
    deco(W) {
      const HZ = W.HZ;
      // rose window
      const cx = 2 * W.stage.cx + 1, cy = 30, z = 2 * (-HZ + 1);
      const glass = [0xd83a4a, 0x3a6ad8, 0xf0c040, 0x3ab86a, 0xa84ad8];
      for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) {
        const d = Math.hypot(x, y);
        if (d > 10.4) continue;
        const ring = d > 9.2 || (d > 3.6 && d < 4.6) || (Math.abs(Math.atan2(y, x) * 8 / Math.PI % 2) < 0.18 && d > 4);
        W.F.set(cx + x, cy + y, z, ring ? 0xd8d0c4 : glass[Math.floor((Math.atan2(y, x) + Math.PI) / TAU * 8 + (d > 4 ? 0 : 3)) % glass.length], ring ? M_SOLID : M_GLOW, 0.05);
      }
      W.light(cx, cy, z + 10, 0xb090ff, 1.2);
      W.claim(W.stage.cx - 6, W.stage.cx + 6, -HZ + 1, -HZ + 1);
      // altar
      const A = W.fp(W.stage.cx, -HZ + 3, 0, 0);
      A.box(-8, 7, 0, 2, -3, 3, 0xd8d0c4); A.box(-7, 6, 3, 9, -2, 2, WHITE); A.box(-7, 6, 9, 9, 3, 3, GOLD);
      for (const x of [-5, 4]) { A.box(x, x, 10, 14, 0, 0, 0xfaf3e0); A.set(x, 15, 0, FLAME[0], M_GLOW, 0); }
      W.light(2 * W.stage.cx + 1, 18, 2 * (-HZ + 3) + 6, 0xffc070, 0.9, 1);
      W.claim(W.stage.cx - 5, W.stage.cx + 5, -HZ + 1, -HZ + 6);
      for (const side of ["left"]) for (let n = 0; n < 2; n++) {
        const s = takeWall(W, side);
        if (!s) continue;
        const [fx, fz] = wallFine(W, side, s);
        for (let a = -4; a <= 4; a++) for (let y = 0; y < 22; y++) {
          const arch = y > 17 ? Math.abs(a) <= 4 - (y - 17) : true;
          if (!arch) continue;
          const edge = Math.abs(a) === 4 || y === 0 || (y > 17 && Math.abs(a) === 4 - (y - 17));
          W.F.set(fx, 10 + y, fz + a, edge ? 0xd8d0c4 : glass[(Math.floor(y / 4) + (a > 0 ? 1 : 0) + n) % glass.length], edge ? M_SOLID : M_GLOW, 0.05);
        }
      }
      for (const [i, k] of [[-12, 4], [-12, 9], [15, 4], [15, 9]]) {
        if (!W.free(i - 4, i + 4, k - 1, k + 1, { stage: false })) continue;
        W.claim(i - 4, i + 4, k - 1, k + 1);
        pBench(W, i, k, { rot: 2, h: 0 });
      }
      W.place([12, 16, -12, -9], 2, pCandles, { foot: -1, h: 0 });
      W.place([-16, -13, -12, -9], 2, pCandles, { foot: -1, h: 0 });
    },
  },
  train: {
    shapeP: 9, edgeNoise: 0.04, HX: 28, HZ: 18,
    reserve: (W) => W.claim(-W.HX, W.HX - 1, -9, 0),
    stage: { cx: 0, cz: 6, rx: 15, rz: 4.5 },
    stageH: 1,
    height: (W, i, k) => (k >= 1 ? 1 : k < -9 ? Math.round(hill(W, i, k, 0.15) * 1.5) : 0),
    top: (W, i, k) => {
      if (k === 1) return 0xf0c840;
      if (k > 1) return ((i + 64) % 4 === 0 || (k + 64) % 4 === 0) ? 0xb8b2a8 : 0xc8c2b8;
      if (k >= -9) return W.pal([0x8a8580, 0x7a756f, 0x96918b], i, k, 0.9);
      return W.pal(GRASS, i, k, 0.2);
    },
    soil: (W, i, k) => (k >= 1 ? 0xa8a296 : DIRT), stone: 0x7a746d,
    clouds: true,
    deco(W) {
      mRails(W, -10, -3, 0);
      W.claim(-W.HX, W.HX - 1, -8, 0);
      mTrain(W, -6, -6, 1);
      for (const i of [-20, 20]) { W.claim(i, i, 3, 3); mLamp(W, i, 3, { h: 1 }); }
      W.place([10, 16, 12, 14], 4, pBench, { foot: -1, h: 1, rot: 2 });
      W.place([-16, -12, 12, 14], 2, pSign, { foot: -1, h: 1, rot: 0 });
      W.place([-24, -20, 4, 8], 3, pChest, { foot: -1, h: 1, rot: 1 });
      for (let n = 0; n < 4; n++) W.place([-24, 24, -17, -12], 4, n % 2 ? mTree : mPine, { foot: 1, tries: 20 });
    },
  },
};

function curtains(W, side, slot) {
  const [fx, fz] = wallFine(W, side, slot);
  for (const off of [-9, 8]) for (let y = 4; y < 34; y++) for (let a = 0; a < 2; a++) {
    const c = (y + a) % 3 ? 0xa81e34 : 0x8a1a2c;
    if (side === "back") W.F.set(fx + off + a, y, fz + (y % 4 === 0 ? 1 : 0), c, M_SOLID, 0.04);
    else W.F.set(fx + (y % 4 === 0 ? 1 : 0), y, fz + off + a, c, M_SOLID, 0.04);
  }
}

// =================================================================================================
// Scene recipe → World (voxels, lights, emitters)
// =================================================================================================

const CLOUD_SLOTS = [[-78, 30, -62], [60, 44, -88], [-10, 58, -120], [106, 26, -24], [-112, 22, -6]];

/** Mark the stage columns and level them (the cast stands on a flat floor at W.stageH blocks). */
function markStage(W, S) {
  const st = [];
  for (const c of W.cols.values()) if (W.inStage(c.i, c.k)) { c.stage = true; st.push(c); }
  let h = S.stageH;
  if (h == null) {
    const hs = st.filter((c) => !c.water).map((c) => c.h).sort((a, b) => a - b);
    h = hs.length ? hs[hs.length >> 1] : 0;
  }
  W.stageH = h;
  if (!S.stageKeep) for (const c of st) { c.h = h; c.water = false; c.wl = 0; }
}

/** Build the voxel world of one scene. spec = normalised scene. */
function buildWorld(spec, seed) {
  const S = DEF[spec.setting] || DEF.meadow;
  const W = new World({ seed, setting: spec.setting, time: spec.time, weather: spec.weather, mood: spec.mood, action: spec.action });
  if (S.HX) W.HX = S.HX;
  if (S.HZ) W.HZ = S.HZ;
  if (S.stage) W.stage = { ...S.stage };
  if (S.interior) { W.interior = true; W.snowy = spec.setting === "snow"; }
  if (S.azRange) W.azRange = S.azRange;
  if (S.leaves) W.leaves = S.leaves;
  W.mossC = S.mossC;
  W.rockC = S.rockC;
  if (S.lampsDay || S.alwaysDark) W.dark = true;
  W.skyUsed = 0; W.wallTurn = 0; W.stageH = 0;
  shapeIsland(W, S);
  markStage(W, S);
  fillTerrain(W, S);
  if (S.wall) interiorShell(W, S.wall);
  if (S.reserve) S.reserve(W);
  placeSceneProps(W, spec.props);
  S.deco(W);
  if (S.sprinkle) sprinkle(W, S.sprinkle[0], S.sprinkle[1]);
  if (S.clouds) {
    const n = spec.weather === "rain" || spec.weather === "snow" ? 5 : 3 + (W.seed % 2);
    for (let c = 0; c < n; c++) {
      const p = CLOUD_SLOTS[(c + W.seed) % CLOUD_SLOTS.length];
      addCloud(W, [p[0], p[1] + W.stageH * 2, p[2]], 0.9 + W.rng() * 0.6);
    }
  }
  return W;
}

// =================================================================================================
// Looks: time of day × weather × setting → sky + lights; mood → colour grade
// =================================================================================================

const TIME_LOOK = {
  dawn: { top: 0x5d7fd2, mid: 0xffbca2, bot: 0x8c6f92, sun: 0xffc9a0, sunI: 2.5, sunEl: 0.3, sunAz: -1.0, sky: 0xffd8c8, ground: 0x6a5468, hemiI: 1.25, fog: 0xffcbb5, glow: 1.5, exposure: 1.0 },
  day: { top: 0x3d8de6, mid: 0xc4e6ff, bot: 0x9ab8d4, sun: 0xfff2da, sunI: 3.0, sunEl: 0.95, sunAz: 0.55, sky: 0xd4ecff, ground: 0x8a7a62, hemiI: 1.35, fog: 0xcfe7ff, glow: 1.25, exposure: 1.0 },
  dusk: { top: 0x37388a, mid: 0xff9d6c, bot: 0x6a3a5c, sun: 0xffa466, sunI: 2.3, sunEl: 0.24, sunAz: 1.05, sky: 0xffb59a, ground: 0x4a3252, hemiI: 1.1, fog: 0xec9a82, glow: 1.9, exposure: 1.02 },
  night: { top: 0x070c26, mid: 0x1c2a5e, bot: 0x090d20, sun: 0xa8c0ff, sunI: 1.15, sunEl: 0.75, sunAz: -0.55, sky: 0x6c7cbc, ground: 0x24243a, hemiI: 0.95, fog: 0x18224a, glow: 2.6, exposure: 1.1, moon: 1, stars: 1 },
};

const MOOD_LOOK = {
  calm: { tint: [1.0, 1.0, 0.98], lift: [0, 0, 0], sat: 1.05, con: 1.0, bloom: 0.5, vig: 0.26 },
  magical: { tint: [1.0, 0.96, 1.08], lift: [0.01, 0, 0.026], sat: 1.12, con: 1.02, bloom: 0.9, vig: 0.32 },
  tense: { tint: [0.97, 1.0, 0.98], lift: [0, 0.006, 0.004], sat: 0.86, con: 1.12, bloom: 0.4, vig: 0.46 },
  joyful: { tint: [1.05, 1.02, 0.95], lift: [0.01, 0.006, 0], sat: 1.18, con: 1.02, bloom: 0.6, vig: 0.22 },
  melancholic: { tint: [0.93, 0.97, 1.08], lift: [0, 0.004, 0.016], sat: 0.74, con: 0.97, bloom: 0.45, vig: 0.4 },
  epic: { tint: [1.06, 0.99, 0.92], lift: [0.008, 0.002, 0], sat: 1.08, con: 1.13, bloom: 0.75, vig: 0.38 },
  mysterious: { tint: [0.92, 0.98, 1.07], lift: [0.004, 0.008, 0.02], sat: 0.9, con: 1.06, bloom: 0.75, vig: 0.48 },
  romantic: { tint: [1.06, 0.96, 1.0], lift: [0.018, 0.004, 0.012], sat: 1.06, con: 0.98, bloom: 0.85, vig: 0.3 },
};

function sunDir(az, el) { return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize(); }

/** Sky + light parameters for a scene. Returns plain numbers/ints (colours as 0xRRGGBB). */
function lookFor(spec, W, S) {
  const L = { ...TIME_LOOK[spec.time] || TIME_LOOK.day };
  L.moon = L.moon || 0; L.stars = L.stars || 0; L.nebula = 0; L.horizon = 0.34;
  L.fogNear = 1.15; L.fogFar = 4.4; L.wind = 0.25; // fog distances are multiples of the camera distance
  const w = spec.weather;
  if (w === "rain") {
    for (const k of ["top", "mid", "bot", "fog"]) L[k] = mixC(L[k], spec.time === "night" ? 0x101420 : 0x7d8898, 0.6);
    L.sunI *= 0.42; L.hemiI *= 0.95; L.fogNear = 0.8; L.fogFar = 3.3; L.exposure *= 0.98; L.wind = 0.6; L.stars = 0; L.moon *= 0.3;
  } else if (w === "snow") {
    for (const k of ["top", "mid", "fog"]) L[k] = mixC(L[k], spec.time === "night" ? 0x2a3456 : 0xdfe7f2, 0.42);
    L.sun = mixC(L.sun, 0xdfeaff, 0.5); L.sunI *= 0.72; L.fogNear = 0.9; L.fogFar = 3.5;
  } else if (w === "fog") {
    L.fog = mixC(L.mid, 0xc8ccd4, spec.time === "night" ? 0.15 : 0.45);
    L.mid = mixC(L.mid, L.fog, 0.6); L.top = mixC(L.top, L.fog, 0.35);
    L.fogNear = 0.62; L.fogFar = 2.5; L.sunI *= 0.65;
  } else if (w === "stars") {
    L.stars = 1;
    if (spec.time !== "night") { L.top = mixC(L.top, 0x1a1f5a, spec.time === "day" ? 0.25 : 0.5); }
  } else if (w === "wind") L.wind = 1;
  if (S.space) {
    Object.assign(L, { top: 0x04050e, mid: 0x161b40, bot: 0x05060f, fog: 0x10142e, stars: 1, nebula: 1, horizon: 0.05, sky: 0xc4c8e6, ground: 0x4a4258, fogNear: 1.6, fogFar: 6 });
    if (spec.time === "day") { L.sun = 0xfff4e6; L.sunI = 2.9; L.hemiI = 1.2; L.moon = 0; }
    else if (spec.time === "night") { L.sun = 0xe6ecff; L.sunI = 2.1; L.hemiI = 1.05; }
    else { L.sunI = 2.4; L.hemiI = 1.1; }
  }
  if (S.alwaysDark) {
    Object.assign(L, { top: 0x0b0a14, mid: 0x231c30, bot: 0x0a0910, fog: 0x1a1626, sky: 0x6a6090, ground: 0x2a2028, stars: 0, moon: 0, nebula: 0.25, horizon: 0.2 });
    L.sunI = spec.time === "day" ? 1.1 : 0.7; L.sun = 0xb8a8ff; L.hemiI = 0.8; L.glow = 2.6;
  }
  if (S.alwaysFog) { L.fog = mixC(L.fog, 0x8a9a7a, 0.35); L.fogNear = Math.min(L.fogNear, 0.75); L.fogFar = Math.min(L.fogFar, 2.9); }
  if (W.interior) { L.fogNear = 1.8; L.fogFar = 7; L.hemiI *= 1.12; }
  L.sunDir = sunDir(L.sunAz + (W.interior ? 0.35 : 0), L.sunEl);
  return L;
}

const DESK_LOOK = {
  top: 0x0c0b10, mid: 0x261d1a, bot: 0x0a0807, sun: 0xffe6c8, sunI: 2.3, sunEl: 0.85, sunAz: -0.75, sky: 0xfff0dc, ground: 0x4a3a30,
  hemiI: 0.62, fog: 0x1a120e, glow: 2.2, exposure: 1.06, moon: 0, stars: 0, nebula: 0, horizon: 0.25, fogNear: 260, fogFar: 760, wind: 0,
};
DESK_LOOK.sunDir = sunDir(DESK_LOOK.sunAz, DESK_LOOK.sunEl);
const DESK_GRADE = { tint: [1.02, 1.0, 0.97], lift: [0.008, 0.006, 0.004], sat: 0.98, con: 1.04, bloom: 0.9, vig: 0.5 };

// =================================================================================================
// Segments — one THREE.Scene per intro / scene / outro, all with the same light rig
// =================================================================================================

const N_POINT = 4;           // point lights per segment (same count everywhere → shared shader programs)
const LK = 34;               // world light units → point light intensity

/** Turn mesher buckets into meshes (one per material) under `parent`. */
function addBuckets(ctx, seg, Bk, parent, shadow = true) {
  for (let m = 0; m < M_COUNT; m++) {
    const geo = bucketGeometry(Bk[m]);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, ctx.mats[m]);
    mesh.castShadow = shadow && (m === M_SOLID || m === M_LEAF);
    mesh.receiveShadow = m !== M_GLOW && m !== M_GLASS;
    if (m === M_WATER) mesh.renderOrder = 2;
    if (m === M_GLASS) mesh.renderOrder = 4;
    seg.geos.push(geo);
    parent.add(mesh);
  }
}

function setSky(mat, L) {
  const u = mat.uniforms;
  u.uTop.value.copy(col3(L.top)); u.uMid.value.copy(col3(L.mid)); u.uBot.value.copy(col3(L.bot));
  // the visible sun / moon hangs low behind the island, where the camera can see it
  const side = L.sunAz < 0 ? -1 : 1;
  const d = sunDir(Math.PI - side * 0.55, clamp(L.sunEl * 0.32, 0.07, 0.3));
  u.uSunDir.value.copy(d);
  u.uMoonDir.value.copy(d);
  u.uMoonCut.value.copy(sunDir(Math.PI - side * 0.55 + 0.012, clamp(L.sunEl * 0.32, 0.07, 0.3) + 0.012));
  u.uSunCol.value.copy(col3(L.sun)).multiplyScalar(L.sunSky ?? 1);
  u.uMoon.value = L.moon;
  u.uStars.value = L.stars;
  u.uNebula.value = L.nebula;
  u.uHorizon.value = L.horizon;
}

function newSegment(ctx, kind, idx, L, grade, center, radius) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, ctx.aspect, 1, 3000);
  const seg = { kind, idx, scene, camera, look: L, grade, geos: [], own: [], cast: [], floaters: [], points: [], flick: [], parts: [], dur: 8, tilt: 1, focusY: 0.5 };
  const sky = makeSky(ctx.skyGeo);
  sky.material.uniforms.uTime = ctx.U.time;
  setSky(sky.material, L);
  seg.own.push(sky.material);
  scene.add(sky);
  seg.sky = sky;
  scene.fog = new THREE.Fog(col3(L.fog), L.fogNear, L.fogFar);
  const hemi = new THREE.HemisphereLight(col3(L.sky), col3(L.ground), L.hemiI);
  const sun = new THREE.DirectionalLight(col3(L.sun), L.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(ctx.shadowSize, ctx.shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.45;
  sun.shadow.radius = 2.5;
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -radius; sc.right = sc.top = radius; sc.near = 20; sc.far = 220 + radius * 2;
  sun.position.copy(L.sunDir).multiplyScalar(200 + radius).add(center);
  sun.target.position.copy(center);
  scene.add(hemi, sun, sun.target);
  for (let n = 0; n < N_POINT; n++) {
    const p = new THREE.PointLight(0xffffff, 0, 110, 1.15);
    p.position.copy(center);
    scene.add(p);
    seg.points.push(p);
  }
  seg.hemi = hemi; seg.sun = sun;
  return seg;
}

/** Use the strongest / nearest world lights for the point light rig. */
function assignLights(seg, lights, center) {
  const ranked = lights.map((l) => ({ l, s: l.intensity / (1 + l.pos.distanceTo(center) / 70) })).sort((a, b) => b.s - a.s);
  for (let n = 0; n < N_POINT; n++) {
    const p = seg.points[n], r = ranked[n];
    if (!r) { p.intensity = 0; continue; }
    p.position.copy(r.l.pos);
    p.color.copy(col3(r.l.color));
    p.intensity = r.l.intensity * LK;
    if (r.l.flicker) seg.flick.push({ light: p, base: p.intensity, f: r.l.flicker, ph: n * 1.7 });
  }
}

function addParticles(ctx, seg, spec, rng) {
  if (!spec || !(spec.count > 0)) return;
  const n = Math.max(4, Math.round(spec.count * (ctx.lowQ ? 0.6 : 1)));
  const pts = makeParticles({ ...spec, count: n }, rng, ctx.U);
  seg.parts.push(pts);
  seg.geos.push(pts.geometry);
  seg.own.push(pts.material);
  seg.scene.add(pts);
}

const FIREFLY_SETTINGS = new Set(["meadow", "forest", "garden", "swamp", "village", "island", "mountains"]);

function ambientEmitters(spec, W, C, L, extra) {
  const out = [], inside = W.interior, x = C.x, y = C.y, z = C.z;
  switch (spec.weather) {
    case "rain":
      if (!inside) out.push({ kind: "rain", count: 760, center: [x, y + 46, z], box: [160, 104, 130], vel: [-5, -92, 0], size: [3, 5.5], colors: [0xd0e2ff, 0xaac4f0], opacity: 0.36 });
      break;
    case "snow":
      if (!inside) out.push({ kind: "dot", count: 520, center: [x, y + 42, z], box: [170, 104, 140], vel: [2.5, -8.5, 0.6], size: [0.9, 1.9], colors: [0xffffff, 0xeef4ff], wob: 3, opacity: 0.95, intensity: 1.2 });
      break;
    case "fog":
      out.push({ kind: "puff", count: inside ? 14 : 34, center: [x, y + 7, z], box: [inside ? 80 : 180, 16, inside ? 60 : 140], vel: [2.5, 0, 0.6], size: [36, 66], colors: [L.fog, mixC(L.fog, 0xffffff, 0.3)], opacity: inside ? 0.14 : 0.22, wob: 3 });
      break;
    case "stars":
      out.push({ kind: "sparkle", count: 34, center: [x, y + (inside ? 34 : 56), z - 26], box: [inside ? 80 : 210, 50, 80], vel: [0, 0, 0], size: [2.4, 4.6], colors: [0xffffff, 0xfff0b0, 0xbfe0ff], additive: true, intensity: 2.2 });
      break;
    case "wind": {
      if (inside) break;
      const cols = spec.setting === "desert" ? [0xe8c890, 0xd8b070, 0xf0d8a8] : W.snowy ? [0xffffff, 0xe8f0fa] : spec.setting === "space" ? [0xb8a8c8] : [0x7cc456, 0xe8a83a, 0xd8643a, 0xf0c84a];
      out.push({ kind: "leaf", count: 64, center: [x, y + 20, z], box: [180, 44, 130], vel: [26, -1.5, 5], size: [2.6, 3.6], colors: cols, wob: 4, spin: 3 });
      break;
    }
    default: break;
  }
  if ((spec.time === "night" || spec.time === "dusk") && FIREFLY_SETTINGS.has(spec.setting))
    out.push({ kind: "dot", count: 30, center: [x, y + 8, z], box: [110, 14, 80], vel: [0, 0.4, 0], size: [0.9, 1.5], colors: [0xe8ff8a, 0xc8ff6a], wob: 4, additive: true, intensity: 3.2 });
  switch (spec.mood) {
    case "magical": out.push({ kind: "sparkle", count: 40, center: [x, y + 16, z], box: [80, 30, 60], vel: [0, 1.4, 0], size: [1.6, 3.2], colors: [0xbfe8ff, 0xffe6a8, 0xf0c0ff], additive: true, intensity: 2.4, wob: 2 }); break;
    case "romantic": out.push({ kind: "leaf", count: 28, center: [x, y + 26, z], box: [90, 44, 70], vel: [3, -3.5, 1], size: [2.2, 3.2], colors: [0xff9ab8, 0xffc0d0, 0xff7a9a], wob: 3, spin: 2 }); break;
    case "mysterious": out.push({ kind: "dot", count: 34, center: [x, y + 12, z], box: [100, 24, 80], vel: [0, 0.6, 0], size: [0.7, 1.3], colors: [0x7af0e8, 0x9ab8ff], wob: 3, additive: true, intensity: 2.4 }); break;
    case "epic": out.push({ kind: "dot", count: 30, center: [x, y + 20, z], box: [110, 40, 80], vel: [1.5, 4.5, 0], size: [0.8, 1.4], colors: [0xffb04a, 0xff7a2a], wob: 2, additive: true, intensity: 3 }); break;
    case "melancholic": out.push({ kind: "dot", count: 30, center: [x, y + 22, z], box: [110, 44, 80], vel: [0.5, -1.6, 0], size: [0.7, 1.2], colors: [0xc8d4ea], wob: 2, opacity: 0.55 }); break;
    default: break;
  }
  switch (spec.action) {
    case "celebrate": out.push({ kind: "confetti", count: 90, center: [x, y + 30, z], box: [64, 52, 50], vel: [0, -10, 0], size: [1.8, 2.8], colors: [0xffd23f, 0xff5a8a, 0x5ad0ff, 0x7aff9a, 0xffffff], wob: 2.5, spin: 3 }); break;
    case "fight": out.push({ kind: "puff", count: 16, center: [x, y + 4, z], box: [30, 8, 18], vel: [0, 2, 0], size: [8, 14], colors: [0xcbbc9e, 0xb8a888], opacity: 0.32, wob: 1.5 }); break;
    case "dance": out.push({ kind: "sparkle", count: 30, center: [x, y + 10, z], box: [40, 20, 30], vel: [0, 1.5, 0], size: [1.5, 2.8], colors: [0xfff0b0, 0xffb8e0], additive: true, intensity: 2.4, wob: 3 }); break;
    case "discover": if (extra) out.push({ kind: "sparkle", count: 30, center: [extra.x, extra.y + 7, extra.z], box: [9, 14, 9], vel: [0, 2.2, 0], size: [1.4, 2.8], colors: [0xfff4c0, 0xbfefff], additive: true, intensity: 3.2, wob: 1 }); break;
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------- cast staging ----

const ROW_TURN = { talk: 0.5, sad: 0.22, celebrate: 0.14, rest: 0.3, discover: 0, fight: 0, walk: 0, travel: 0, dance: 0, chase: 0 };

function stageCast(ctx, seg, W, spec) {
  const s = W.stage;
  const C = new THREE.Vector3(2 * s.cx, W.stageH * 2, 2 * s.cz);
  seg.C = C; seg.RX = 2 * s.rx; seg.RZ = 2 * s.rz;
  const ids = [];
  for (const id of spec.cast) if (ctx.chars.has(id) && !ids.includes(id)) ids.push(id);
  for (const id of ids.slice(0, 4)) {
    const g = ctx.acquire(id);
    if (!g) continue;
    seg.scene.add(g);
    seg.cast.push({ id, g, h: g.userData.height || 20, j: seg.cast.length });
  }
  const az0 = seg.az0;
  seg.fwd = new THREE.Vector3(Math.sin(az0), 0, Math.cos(az0));
  seg.right = new THREE.Vector3(Math.cos(az0), 0, -Math.sin(az0));
  const n = seg.cast.length;
  seg.spacing = n > 1 ? clamp((seg.RX * 1.15) / n, 10, 17) : 0;
  if (spec.action === "discover") seg.spot = C.clone().addScaledVector(seg.right, seg.RX * 0.42).addScaledVector(seg.fwd, seg.RZ * 0.25);
  seg.speaker = spec.line ? Math.max(0, seg.cast.findIndex((c) => c.id === spec.line.speaker)) : 0;
}

/** Ground height (units) under a world point; the stage is flat. */
function groundAt(W, C, x, z) {
  const i = Math.floor(x / 2), k = Math.floor(z / 2);
  if (W.inStage(i, k)) return C.y;
  const c = W.col(i, k);
  if (!c) return C.y;
  return (c.water ? c.wl : c.h) * 2;
}

const _v = new THREE.Vector3();

function poseCast(seg, spec, l, a, lineOn) {
  const n = seg.cast.length;
  if (!n) return;
  const { C, fwd, right, W } = seg;
  const act = spec.action;
  const camA = seg.az0;
  const dur = seg.dur || 8;
  for (const c of seg.cast) {
    const j = c.j, g = c.g;
    const off = j - (n - 1) / 2;
    let x, z, rot, anim = act, ts = 1;
    if (act === "walk" || act === "chase") {
      const w = act === "chase" ? 0.8 : 0.42, gap = act === "chase" ? 0.95 : 0.55;
      const al = 1.9 + l * w - j * gap;
      const rx = seg.RX * 0.52, rz = seg.RZ * 0.56;
      x = C.x + Math.cos(al) * rx; z = C.z + Math.sin(al) * rz;
      rot = Math.atan2(-Math.sin(al) * rx, Math.cos(al) * rz);
      anim = act === "chase" ? "chase" : "walk"; ts = act === "chase" ? 1.35 : 1;
    } else if (act === "travel") {
      const lead = lerp(-0.62, 0.62, sat(l / dur)) * seg.RX;
      const s = Math.max(-seg.RX * 0.92, lead - j * 9);
      _v.copy(C).addScaledVector(right, s).addScaledVector(fwd, j % 2 ? -3 : 1.5);
      x = _v.x; z = _v.z;
      rot = camA + Math.PI / 2 - 0.25;
      anim = s > lead - j * 9 + 0.01 ? "idle" : "walk";
    } else if (act === "dance") {
      const R = n > 1 ? 4 + 2.6 * n : 0, al = (j / n) * TAU + a * 0.5;
      x = C.x + Math.cos(al) * R; z = C.z + Math.sin(al) * R * 0.8;
      rot = n > 1 ? Math.atan2(C.x - x, C.z - z) + 0.5 : camA + 0.4 * Math.sin(a);
    } else if (act === "fight") {
      const nA = Math.ceil(n / 2), side = j < nA ? -1 : 1, row = j < nA ? j - (nA - 1) / 2 : j - nA - (n - nA - 1) / 2;
      const lunge = 2.4 * Math.pow(Math.max(0, Math.sin(a * 2.6 + j * 1.7)), 3);
      if (n === 1) { _v.copy(C); rot = camA + 0.6; }
      else {
        _v.copy(C).addScaledVector(right, side * (8.5 - lunge)).addScaledVector(fwd, row * 8);
        rot = camA + (side < 0 ? Math.PI / 2 - 0.4 : -Math.PI / 2 + 0.4);
      }
      x = _v.x; z = _v.z;
    } else {
      // standing row on a shallow arc, everybody turned a little inward
      const base = act === "discover" ? C.clone().addScaledVector(right, -seg.RX * 0.12) : C;
      _v.copy(base).addScaledVector(right, off * seg.spacing).addScaledVector(fwd, 2 - Math.abs(off) * 2.6);
      x = _v.x; z = _v.z;
      const k = act === "talk" && n === 2 ? 0.9 : ROW_TURN[act] ?? 0.3;
      rot = camA - Math.sign(off) * k;
      if (act === "discover" && seg.spot) rot = lerp(Math.atan2(seg.spot.x - x, seg.spot.z - z), camA, 0.25);
      if (act === "talk") {
        const talker = lineOn ? seg.speaker : Math.floor(l / 2.7) % n;
        anim = j === talker ? "talk" : "idle";
      }
    }
    if (lineOn && j === seg.speaker && (act === "sad" || act === "rest" || act === "discover")) anim = "talk";
    g.position.set(x, groundAt(W, C, x, z), z);
    g.rotation.set(0, rot, 0);
    animateCharacter(g, anim, a * ts + j * 0.37);
  }
}

// ---------------------------------------------------------------- cameras ----

function fitDistance(ctx, half) {
  const tanV = Math.tan((FOV * Math.PI) / 360), tanH = tanV * ctx.aspect;
  return Math.max((half * 1.34) / tanH, (half * 0.78) / tanV);
}

function placeSceneCamera(ctx, seg, spec, l, a, lineK) {
  const W = seg.W, C = seg.C, cam = seg.camera;
  const d = seg.dur || 8;
  let u = easeInOut(l / d);
  if (ctx.reduced) u = 0.5 + (u - 0.5) * 0.35;
  const half = Math.max(W.HX, W.HZ * 0.9) * 2;
  const S = DEF[spec.setting] || DEF.meadow;
  const Dw = fitDistance(ctx, half) * (S.frame || 1);
  const az0 = seg.az0;
  let az = az0, el = 0.44, dist = Dw * 0.95, fov = FOV;
  switch (spec.camera) {
    case "dolly_in": az = az0 + (0.5 - u) * 0.32; el = lerp(0.46, 0.3, u); dist = Dw * lerp(1.0, 0.42, u); break;
    case "pan": az = az0 - 0.08; el = 0.36; dist = Dw * 0.68; break;
    case "crane": az = az0 + 0.18 * (u - 0.5); el = lerp(0.14, 0.8, u); dist = Dw * lerp(0.62, 1.0, u); break;
    case "fly_over": az = az0 + lerp(-1.05, 0.22, u); el = lerp(1.0, 0.4, u); dist = Dw * lerp(1.18, 0.82, u); break;
    case "close_up": az = az0 + (u - 0.5) * 0.36; el = 0.22; dist = Math.max(84, Dw * lerp(0.6, 0.52, u)); fov = 28; break;
    default: az = az0 + (u - 0.5) * 0.95; el = 0.42 + 0.04 * Math.sin(u * Math.PI); break; // orbit
  }
  if (W.interior) { az = clamp(az, W.azRange[0], W.azRange[1]); el = Math.max(el, 0.3); }
  // aim at the cast when close, lower (at the island's middle) when wide so the floating chunk sits in frame
  const near = sat((Dw * 0.9 - dist) / (Dw * 0.55));
  const tgt = _cTg.set(C.x, C.y + lerp(4 + (S.camY || 0), 9.5, near), C.z);
  if (spec.camera === "pan") { const s = lerp(-0.3, 0.3, u) * half; tgt.x += Math.cos(az) * s; tgt.z -= Math.sin(az) * s; }
  if (spec.camera === "close_up" && seg.cast.length) {
    let cx = 0, cz = 0, cy = 0;
    for (const c of seg.cast) { cx += c.g.position.x; cz += c.g.position.z; cy += c.g.position.y + c.h * 0.62; }
    const n = seg.cast.length;
    cx /= n; cz /= n; cy /= n;
    const sp = seg.cast[seg.speaker] || seg.cast[0];
    const k = smooth(lineK) * 0.75;
    tgt.set(lerp(cx, sp.g.position.x, k), lerp(cy, sp.g.position.y + sp.h * 0.72, k), lerp(cz, sp.g.position.z, k));
  }
  cam.position.set(tgt.x + Math.sin(az) * Math.cos(el) * dist, tgt.y + Math.sin(el) * dist, tgt.z + Math.cos(az) * Math.cos(el) * dist);
  if (!ctx.reduced) {
    tgt.x += Math.sin(a * 0.63) * 0.3; tgt.y += Math.sin(a * 0.81 + 1) * 0.2;
    cam.position.x += Math.sin(a * 0.47 + 2) * 0.5; cam.position.y += Math.sin(a * 0.39) * 0.35;
    if (spec.action === "fight") { const s = Math.pow(Math.max(0, Math.sin(a * 2.6)), 14) * 0.5; cam.position.y += s * Math.sin(a * 53); cam.position.x += s * Math.cos(a * 47); }
  }
  cam.fov = fov;
  cam.up.set(0, 1, 0);
  cam.lookAt(tgt);
  seg.scene.fog.near = dist * seg.look.fogNear;
  seg.scene.fog.far = dist * seg.look.fogFar;
  seg.tilt = spec.camera === "close_up" ? 0.5 : 0.85;
}
const _cTg = new THREE.Vector3();

// ---------------------------------------------------------------- diorama scene segment ----

/** Generator: builds a scene segment, yielding between chunks of work so it can run across frames. */
function* sceneSegmentGen(ctx, spec, idx) {
  const seed = hashStr(ctx.seedBase + ":" + idx + ":" + spec.setting + ":" + spec.time + ":" + spec.weather + ":" + spec.props.join(","));
  const S = DEF[spec.setting] || DEF.meadow;
  const W = buildWorld(spec, seed);
  yield;
  const L = lookFor(spec, W, S);
  const grade = MOOD_LOOK[spec.mood] || MOOD_LOOK.calm;
  const center = new THREE.Vector3(2 * W.stage.cx, W.stageH * 2, 2 * W.stage.cz);
  const seg = newSegment(ctx, "scene", idx, L, grade, center, Math.hypot(W.HX, W.HZ) * 2 + 14);
  seg.W = W; seg.spec = spec;
  const Bk = newBuckets();
  yield* meshGrid(W.C, Bk);
  yield* meshGrid(W.F, Bk);
  addBuckets(ctx, seg, Bk, seg.scene, true);
  yield;
  for (const f of W.floaters) {
    const b = newBuckets();
    yield* meshGrid(f.grid, b);
    const g = new THREE.Group();
    addBuckets(ctx, seg, b, g, f.castShadow);
    g.position.set(f.pos[0], f.pos[1], f.pos[2]);
    g.rotation.set(f.rot[0], f.rot[1], f.rot[2]);
    seg.scene.add(g);
    seg.floaters.push({ g, f });
  }
  const rng = seeded(seed ^ 0x2545f491);
  const azMid = W.interior ? (W.azRange[0] + W.azRange[1]) / 2 : 0.3 + (rng() - 0.5) * 0.3;
  seg.az0 = azMid;
  stageCast(ctx, seg, W, spec);
  const lights = W.lights.slice();
  if (seg.spot) lights.push({ pos: seg.spot.clone().setY(seg.spot.y + 6), color: 0xfff0b8, intensity: 1.6, flicker: 0 });
  assignLights(seg, lights, center);
  for (const e of W.emitters) addParticles(ctx, seg, e, rng);
  for (const e of ambientEmitters(spec, W, center, L, seg.spot)) addParticles(ctx, seg, e, rng);
  seg.update = (l, a, lineOn, lineK) => {
    for (const f of seg.floaters) {
      const F = f.f, p = F.pos;
      f.g.position.set(p[0] + Math.sin(a * 0.05 + F.phase) * F.drift * 6, p[1] + Math.sin(a * 0.7 + F.phase) * F.bob, p[2]);
      f.g.rotation.y = F.rot[1] + a * F.spin;
    }
    for (const p of seg.flick) p.light.intensity = p.base * (1 + p.f * 0.1 * (Math.sin(a * 13 + p.ph) * 0.6 + Math.sin(a * 7.3 + p.ph * 2) * 0.4));
    poseCast(seg, spec, l, a, lineOn);
    placeSceneCamera(ctx, seg, spec, l, a, lineK);
  };
  return seg;
}

// =================================================================================================
// The book on the desk (intro + outro)
// =================================================================================================

/** Word-wrap `text` into lines no wider than `w` with the current font. */
function wrapText(g, text, w) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + " " + word : word;
      if (g.measureText(t).width > w && line) { out.push(line); line = word; } else line = t;
    }
    if (line) out.push(line);
  }
  return out;
}

/** A canvas texture redrawn once web fonts are ready. */
function canvasTex(ctx, w, h, draw) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const redraw = () => { const g = cv.getContext("2d"); g.clearRect(0, 0, w, h); draw(g, w, h); tex.needsUpdate = true; };
  redraw();
  ctx.redraws.push(redraw);
  return tex;
}

function paperBase(g, w, h, spine) {
  g.fillStyle = "#f3e7cb";
  g.fillRect(0, 0, w, h);
  const sx = spine === "left" ? 0 : w;
  const gr = g.createLinearGradient(sx, 0, spine === "left" ? w * 0.24 : w * 0.76, 0);
  gr.addColorStop(0, "rgba(110,70,30,0.38)");
  gr.addColorStop(1, "rgba(110,70,30,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  const rng = seeded(w * 7 + h);
  g.fillStyle = "rgba(120,90,50,0.06)";
  for (let n = 0; n < 260; n++) g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
}

const SERIF = '"Playfair Display", Georgia, "Times New Roman", serif';

function titlePage(ctx) {
  return canvasTex(ctx, 512, 728, (g, w, h) => {
    paperBase(g, w, h, "right");
    g.textAlign = "center";
    g.fillStyle = "#3a2414";
    g.font = `600 52px ${SERIF}`;
    const lines = wrapText(g, ctx.texts.title || "BookTrip", w - 110).slice(0, 4);
    let y = h * 0.42 - lines.length * 30;
    for (const ln of lines) { g.fillText(ln, w / 2 - 10, y); y += 62; }
    g.font = `italic 600 26px ${SERIF}`;
    g.fillStyle = "#7a4a2a";
    for (const ln of ctx.texts.author ? wrapText(g, ctx.texts.author, w - 150).slice(0, 2) : []) { g.fillText(ln, w / 2 - 14, y + 22); y += 32; }
    y -= 32;
    g.strokeStyle = "rgba(122,74,42,0.55)";
    g.lineWidth = 2;
    const oy = y + 70;
    g.beginPath(); g.moveTo(w / 2 - 110, oy); g.lineTo(w / 2 - 24, oy); g.moveTo(w / 2 + 4, oy); g.lineTo(w / 2 + 90, oy); g.stroke();
    g.fillStyle = "#b8862a";
    g.font = `600 22px ${SERIF}`;
    g.fillText("✦", w / 2 - 10, oy + 8);
  });
}

function textPage(ctx, text, seed) {
  return canvasTex(ctx, 512, 728, (g, w, h) => {
    paperBase(g, w, h, "left");
    g.fillStyle = "#3a2a1c";
    const body = String(text || "").trim();
    const mx = 62, top = 92;
    g.textAlign = "left";
    if (body) {
      g.font = `600 84px ${SERIF}`;
      g.fillStyle = "#9a2a2a";
      g.fillText(body[0], mx, top + 58);
      g.fillStyle = "#3a2a1c";
      g.font = `400 25px ${SERIF}`;
      const lines = wrapText(g, body.slice(1), w - mx * 2 - 64);
      let y = top + 6;
      lines.slice(0, 3).forEach((ln) => { g.fillText(ln, mx + 64, y + 22); y += 36; });
      const rest = wrapText(g, lines.slice(3).join(" "), w - mx * 2);
      for (const ln of rest.slice(0, 12)) { g.fillText(ln, mx, y + 22); y += 36; }
      if (y < h - 140) {
        // fill the rest of the page with soft "printed" lines
        const rng = seeded(seed);
        g.fillStyle = "rgba(58,42,28,0.16)";
        for (y += 30; y < h - 80; y += 36) g.fillRect(mx, y, (w - mx * 2) * (y > h - 130 ? 0.5 : 0.82 + rng() * 0.18), 9);
      }
    }
  });
}

function linesPage(ctx, seed) {
  return canvasTex(ctx, 256, 364, (g, w, h) => {
    paperBase(g, w, h, "left");
    const rng = seeded(seed);
    g.fillStyle = "rgba(58,42,28,0.2)";
    for (let y = 40; y < h - 36; y += 18) g.fillRect(28, y, (w - 56) * (0.7 + rng() * 0.3), 5);
  });
}

function coverTex(ctx) {
  const c = ctx.cover;
  return canvasTex(ctx, 512, 740, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w * 0.4, h);
    gr.addColorStop(0, cssC(c.bg)); gr.addColorStop(1, cssC(c.bg2));
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = cssC(c.accent); g.lineWidth = 6; g.strokeRect(30, 30, w - 60, h - 60);
    g.lineWidth = 2; g.strokeRect(44, 44, w - 88, h - 88);
    g.fillStyle = cssC(c.fg); g.textAlign = "center";
    g.font = `600 54px ${SERIF}`;
    const lines = wrapText(g, ctx.texts.title || "", w - 130).slice(0, 4);
    let y = h * 0.4 - lines.length * 31;
    for (const ln of lines) { g.fillText(ln, w / 2, y); y += 64; }
    g.fillStyle = cssC(c.accent); g.font = `600 30px ${SERIF}`; g.fillText("✦", w / 2, y + 16);
    g.fillStyle = cssC(c.fg); g.font = `italic 600 28px ${SERIF}`;
    if (ctx.texts.author) g.fillText(wrapText(g, ctx.texts.author, w - 130)[0] || "", w / 2, h - 96);
  });
}

/** A flexible page sheet: K segments from the spine (x = 0) outward, bent on the CPU each frame. */
function makeSheet(len, depth, K = 20) {
  const geo = new THREE.PlaneGeometry(len, depth, K, 1);
  geo.userData.K = K; geo.userData.len = len;
  return geo;
}
function bendSheet(geo, theta, curl, y0) {
  const K = geo.userData.K, len = geo.userData.len, ds = len / K;
  const pos = geo.attributes.position;
  let x = 0, y = y0;
  const xs = [x], ys = [y];
  for (let k = 0; k < K; k++) {
    const phi = theta - curl * Math.sin(theta) * Math.pow((k + 0.5) / K, 1.3);
    x += Math.cos(phi) * ds; y += Math.sin(phi) * ds;
    xs.push(x); ys.push(y);
  }
  // PlaneGeometry rows: (K + 1) vertices per row, 2 rows; z from the original y coordinate
  for (let r = 0; r < 2; r++) for (let k = 0; k <= K; k++) {
    const n = r * (K + 1) + k;
    pos.setXYZ(n, xs[k], ys[k], r === 0 ? -geo.parameters.height / 2 : geo.parameters.height / 2);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function drawStackBook(P, x0, x1, y0, y1, z0, z1, col) {
  P.box(x0, x1, y0, y0, z0, z1, col);
  P.box(x0, x1, y1, y1, z0, z1, col);
  P.box(x0, x0 + 1, y0, y1, z0, z1, mulC(col, 0.86));
  P.box(x0 + 2, x1 - 1, y0 + 1, y1 - 1, z0 + 1, z1 - 1, (x, y) => (y % 2 ? 0xf3e6c8 : 0xe2d0ae), M_SOLID, 0.02);
  P.box(x0 + 3, x0 + 3, y1, y1, z0 + 2, z1 - 2, GOLD, M_SOLID, 0);
}

function* deskSegmentGen(ctx, kind) {
  const intro = kind === "intro";
  const L = DESK_LOOK;
  const seg = newSegment(ctx, kind, intro ? -1 : ctx.nScenes, L, DESK_GRADE, new THREE.Vector3(0, 0, 0), 120);
  const cv = ctx.cover;
  // desk: big wooden planks on a coarse grid
  const D = new Grid(4, 77);
  for (let i = -28; i < 28; i++) for (let k = -20; k < 16; k++) {
    const plank = Math.floor((k + 40) / 2);
    const base = [0x8a6a4e, 0x957657, 0x806248, 0x8f6f52][plank % 4];
    D.set(i, -1, k, mulC(base, 0.94 + h3(i >> 2, plank, 0, 5) * 0.1), M_SOLID, 0.03);
  }
  const Bk = newBuckets();
  yield* meshGrid(D, Bk);
  // left half of the book, spine and the desk props (fine grid)
  const G = new Grid(1, 99);
  const coverC = cv.bg, edge = mulC(cv.bg, 0.78);
  const pageEdge = (x, y) => (y % 2 ? 0xf6ead0 : 0xe4d4b2);
  G.box(-38, -1, 0, 1, -27, 26, (x, y, z) => (x === -38 || z === -27 || z === 26 ? edge : coverC));
  G.box(-1, 0, 0, 2, -27, 26, mulC(cv.bg, 0.7));
  G.box(-36, -1, 2, 6, -25, 24, pageEdge, M_SOLID, 0.02);
  G.box(-2, -1, 6, 6, -25, 24, -1);
  G.del(-2, 6, 0);
  for (let z = -25; z <= 24; z++) { G.del(-1, 6, z); G.del(-2, 6, z); G.set(-1, 5, z, 0xe8d8b6, M_SOLID, 0.02); }
  // ribbon bookmark lying over the left page and hanging over the front edge
  for (let z = -6; z <= 25; z++) G.set(-6 - Math.floor((z + 6) / 9), 7, z, 0xb02a3a, M_SOLID, 0.03);
  for (let y = 1; y <= 6; y++) G.set(-9, y, 26, 0xb02a3a, M_SOLID, 0.03);
  // candle on a brass dish
  const C1 = painter(G, -52, 0, -28, 0);
  C1.cyl(0, 0, 7, 0, 0, 0xc8963a); C1.cyl(0, 0, 7, 1, 1, (x, y, z, dx, dz) => (dx * dx + dz * dz > 30 ? 0xd8a84a : -1));
  C1.cyl(0, 0, 3.3, 1, 17, 0xf4ecd8, M_SOLID, 0.03);
  C1.set(3, 15, 0, 0xfaf4e4); C1.set(3, 14, 0, 0xfaf4e4); C1.set(-4, 12, -1, 0xfaf4e4);
  C1.box(-1, 0, 18, 18, -1, 0, 0x2a2018);
  C1.box(-1, 0, 19, 21, -1, 0, FLAME[1], M_GLOW, 0); C1.set(-1, 22, -1, FLAME[0], M_GLOW, 0); C1.set(0, 22, 0, FLAME[0], M_GLOW, 0); C1.set(-1, 23, 0, 0xfff4d0, M_GLOW, 0);
  // inkwell and quill
  const I1 = painter(G, 52, 0, -32, 0);
  I1.cyl(0, 0, 5.2, 0, 6, (x, y, z, dx, dz) => (y === 6 ? 0x2a3450 : dx < -2 && dz > 0 ? 0x6a8ac8 : 0x3a5a9a), M_SOLID, 0.04);
  I1.cyl(0, 0, 2.6, 7, 8, 0x2a3a66); I1.cyl(0, 0, 2.2, 9, 9, 0x8a6a3a);
  for (let n = 0; n <= 30; n++) {
    const t = n / 30, x = Math.round(lerp(1, -12, t)), y = Math.round(lerp(8, 38, t)), z = Math.round(lerp(0, 9, t));
    I1.set(x, y, z, t < 0.25 ? 0x3a2a1a : 0xf2ece0, M_SOLID, 0.03);
    const wv = t < 0.3 ? 0 : Math.round(Math.sin(((t - 0.3) / 0.7) * Math.PI) * 3.2);
    for (let s = 1; s <= wv; s++) { I1.set(x + s, y, z, 0xece4d2, M_SOLID, 0.04); I1.set(x - s, y + 1, z, 0xf6f0e4, M_SOLID, 0.04); }
  }
  // stack of books
  const B1 = painter(G, -58, 0, 24, 0);
  drawStackBook(B1, -16, 15, 0, 4, -11, 10, 0x2a4a7a);
  drawStackBook(B1, -12, 16, 5, 8, -10, 9, 0x8a2a2a);
  drawStackBook(B1, -15, 10, 9, 13, -9, 8, 0x3a6a3a);
  // teacup on a saucer
  const T1 = painter(G, 56, 0, 28, 0);
  T1.cyl(0, 0, 8, 0, 0, 0xf2eee6); T1.cyl(0, 0, 8, 1, 1, (x, y, z, dx, dz) => (dx * dx + dz * dz > 42 ? 0xe8e2d8 : -1));
  T1.cyl(0, 0, 5, 1, 8, (x, y, z, dx, dz) => (dx * dx + dz * dz > 12 || y === 1 ? (y === 6 ? 0x3a6ab8 : 0xf6f2ea) : y === 7 ? 0x8a4a1c : -1), M_SOLID, 0.03);
  T1.box(5, 6, 3, 3, -1, 0, 0xf6f2ea); T1.box(5, 6, 7, 7, -1, 0, 0xf6f2ea); T1.box(7, 7, 4, 6, -1, 0, 0xf6f2ea);
  yield* meshGrid(G, Bk);
  addBuckets(ctx, seg, Bk, seg.scene, true);
  yield;
  // right half pivots on the spine (book closes in the outro)
  const R = new Grid(1, 101);
  R.box(0, 37, 0, 1, -27, 26, (x, y, z) => (x === 37 || z === -27 || z === 26 ? edge : coverC));
  R.box(0, 35, 2, 6, -25, 24, pageEdge, M_SOLID, 0.02);
  for (let z = -25; z <= 24; z++) { R.del(0, 6, z); R.del(1, 6, z); R.set(0, 5, z, 0xe8d8b6, M_SOLID, 0.02); }
  const Rb = newBuckets();
  yield* meshGrid(R, Rb, 0, -7, 0);
  const right = new THREE.Group();
  right.position.set(0, 7, 0);
  addBuckets(ctx, seg, Rb, right, true);
  seg.scene.add(right);
  // printed pages
  const mk = (tex, w, h) => {
    const m = new THREE.MeshLambertMaterial({ map: tex });
    const geo = new THREE.PlaneGeometry(w, h);
    seg.own.push(m, tex); seg.geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.receiveShadow = true;
    return mesh;
  };
  const pl = mk(titlePage(ctx), 33.5, 47.6);
  pl.rotation.x = -Math.PI / 2; pl.position.set(-19.6, 7.02, -0.5);
  seg.scene.add(pl);
  const pr = mk(textPage(ctx, intro ? ctx.texts.intro : ctx.texts.outro, 11), 33.5, 47.6);
  pr.rotation.x = -Math.PI / 2; pr.position.set(19.6, 0.02, -0.5);
  right.add(pr);
  const pc = mk(coverTex(ctx), 37, 53);
  pc.rotation.set(Math.PI / 2, 0, Math.PI); pc.position.set(18.5, -7.03, -0.5);
  right.add(pc);
  // pages flipping over (intro)
  const sheets = [];
  if (intro) {
    const tex = linesPage(ctx, 5);
    // the back of the last sheet is the title page (mirrored, since we see it from behind)
    const back = titlePage(ctx);
    back.wrapS = THREE.RepeatWrapping; back.repeat.set(-1, 1); back.offset.set(1, 0);
    const front = new THREE.MeshLambertMaterial({ map: tex, side: THREE.FrontSide });
    const backM = new THREE.MeshLambertMaterial({ map: tex, side: THREE.BackSide });
    const backT = new THREE.MeshLambertMaterial({ map: back, side: THREE.BackSide });
    seg.own.push(front, backM, backT, tex, back);
    for (let n = 0; n < 3; n++) {
      const geo = makeSheet(34.5, 47.6);
      seg.geos.push(geo);
      const mesh = new THREE.Mesh(geo, front);
      const mb = new THREE.Mesh(geo, n === 2 ? backT : backM);
      for (const x of [mesh, mb]) { x.position.set(0, 0, -0.5); x.castShadow = x === mesh; x.receiveShadow = true; seg.scene.add(x); }
      bendSheet(geo, 0, 0, 7.06 + (2 - n) * 0.05);
      sheets.push({ mesh, geo, y0: 7.06 + (2 - n) * 0.05 });
    }
  }
  // glowing letters
  const chars = [...new Set(Array.from((ctx.texts.title + ctx.texts.intro + ctx.texts.outro + "BookTrip").replace(/[\s\p{P}]+/gu, "")))].filter((c) => c.length === 1);
  while (chars.length < 8) chars.push(...("AaBbCcDd".split("")));
  const atlas = letterAtlas(chars.slice(0, 64));
  ctx.redraws.push(atlas.userData.redraw);
  const NL = ctx.lowQ ? 150 : 240;
  const lp = new Float32Array(NL * 3), ls = new Float32Array(NL), lg = new Float32Array(NL), lm = new Float32Array(NL);
  const rng = seeded(4242);
  for (let n = 0; n < NL; n++) {
    const sideX = rng() < 0.5 ? -1 : 1;
    lp[n * 3] = sideX * (3 + rng() * 30); lp[n * 3 + 1] = 7.4; lp[n * 3 + 2] = (rng() - 0.5) * 42;
    ls[n] = rng(); lg[n] = Math.floor(rng() * Math.min(64, chars.length)); lm[n] = rng() < 0.32 ? 0 : 1;
  }
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute("position", new THREE.BufferAttribute(lp, 3));
  lgeo.setAttribute("aSeed", new THREE.BufferAttribute(ls, 1));
  lgeo.setAttribute("aGlyph", new THREE.BufferAttribute(lg, 1));
  lgeo.setAttribute("aMode", new THREE.BufferAttribute(lm, 1));
  const lmat = new THREE.ShaderMaterial({
    vertexShader: LET_VS, fragmentShader: LET_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uT: { value: 0 }, uDive: { value: 99 }, uScale: ctx.U.pscale, uMaxSize: ctx.U.pmax, uAtlas: { value: atlas }, uGain: { value: 1 } },
  });
  const letters = new THREE.Points(lgeo, lmat);
  letters.frustumCulled = false;
  letters.renderOrder = 30;
  seg.scene.add(letters);
  seg.geos.push(lgeo); seg.own.push(lmat, atlas);
  // lights: candle, page glow
  assignLights(seg, [{ pos: new THREE.Vector3(-52, 24, -28), color: 0xffb060, intensity: 1.5, flicker: 2 }, { pos: new THREE.Vector3(14, 16, 0), color: 0xffe2a8, intensity: 0.001, flicker: 0 }], new THREE.Vector3());
  const pageLight = seg.points[1];
  // ambience: dust in the lamp light, bokeh of a dark room, steam from the tea
  const prng = seeded(77);
  addParticles(ctx, seg, { kind: "dot", count: 46, center: [0, 30, 0], box: [150, 54, 100], vel: [0.4, 0.6, 0], size: [0.55, 1], colors: [0xffe8c0], wob: 3, additive: true, intensity: 1.3, opacity: 0.7 }, prng);
  addParticles(ctx, seg, { kind: "dot", count: 24, center: [0, 80, -300], box: [620, 190, 40], vel: [0.7, 0.2, 0], size: [16, 34], colors: [0xffb060, 0xffd090, 0xff8a50, 0x8ab0ff], wob: 6, additive: true, intensity: 0.42 }, prng);
  addParticles(ctx, seg, { kind: "puff", count: 7, center: [56, 20, 28], box: [6, 18, 6], vel: [0.3, 3.2, 0], size: [5, 9], colors: [0xffffff], opacity: 0.18, wob: 1 }, prng);
  addParticles(ctx, seg, { kind: "dot", count: 10, center: [-52, 34, -28], box: [4, 18, 4], vel: [0, 5, 0], size: [0.6, 1.1], colors: [0xffd08a, 0xff9a4a], wob: 0.8, additive: true, intensity: 3 }, prng);
  seg.tilt = 0.7;
  const cam = seg.camera;
  const tgt = new THREE.Vector3();
  seg.update = (l, a) => {
    const dur = seg.dur || 6;
    for (const p of seg.flick) p.light.intensity = p.base * (1 + p.f * 0.1 * (Math.sin(a * 13 + p.ph) * 0.6 + Math.sin(a * 7.3 + p.ph * 2) * 0.4));
    let fov = FOV, roll = 0;
    if (intro) {
      const Ld = Math.max(0.5, dur - DIVE);
      const gap = Math.max(0.55, (Ld - 0.9) / sheets.length);
      sheets.forEach((s, n) => {
        const p = range(l, 0.45 + n * gap, 0.45 + n * gap + 1.25);
        const th = Math.PI * easeInOut(p);
        bendSheet(s.geo, th, 0.95, p >= 1 ? 7.06 + n * 0.05 : s.y0);
      });
      lmat.uniforms.uT.value = l;
      lmat.uniforms.uDive.value = ctx.reduced ? 99 : Ld + 0.15;
      lmat.uniforms.uGain.value = 1;
      pageLight.intensity = LK * (0.05 + 2.6 * easeIn(range(l, Ld, dur)));
      if (l < Ld) {
        const p = easeInOut(l / Ld);
        const az = lerp(0.42, 0.16, p), el = lerp(0.74, 0.92, p), d = lerp(178, 118, easeOut(l / Ld));
        tgt.set(lerp(2, 7, p), lerp(3, 6, p), lerp(4, 0, p));
        cam.position.set(tgt.x + Math.sin(az) * Math.cos(el) * d, tgt.y + Math.sin(el) * d, tgt.z + Math.cos(az) * Math.cos(el) * d);
      } else {
        const q = easeIn(range(l, Ld, dur)) * (ctx.reduced ? 0.6 : 1);
        const az = 0.16, el = 0.92, d = 118;
        const sx = 7 + Math.sin(az) * Math.cos(el) * d, sy = 6 + Math.sin(el) * d, sz = Math.cos(az) * Math.cos(el) * d;
        cam.position.set(lerp(sx, 18, q), lerp(sy, 9.5, q), lerp(sz, 2.5, q));
        tgt.set(lerp(7, 18.5, q), lerp(6, 7, q), lerp(0, -3, q));
        fov = lerp(FOV, ctx.reduced ? 38 : 54, q);
        roll = ctx.reduced ? 0 : q * q * 0.6;
      }
    } else {
      const cl = easeInOut(range(l, 1.5, 3.5));
      right.rotation.z = Math.PI * cl;
      const g = Math.min(1, ctx.reduced ? 0 : 1);
      lmat.uniforms.uT.value = l < 3 ? lerp(3.3, 0, l / 3) * g + 0.2 : 0;
      lmat.uniforms.uDive.value = 0.3;
      lmat.uniforms.uGain.value = 0.8;
      pageLight.intensity = LK * 2.2 * (1 - range(l, 0, 2.6));
      const q = easeOut(range(l, 0, 3.6));
      const az = lerp(0.1, 0.34, q), el = lerp(1.25, 0.64, q), d = lerp(30, 150, q) + Math.max(0, l - 3.6) * 1.6;
      tgt.set(lerp(16, -6, q), lerp(7, 5, q), lerp(-2, 2, q));
      cam.position.set(tgt.x + Math.sin(az) * Math.cos(el) * d, tgt.y + Math.sin(el) * d, tgt.z + Math.cos(az) * Math.cos(el) * d);
    }
    if (!ctx.reduced) { tgt.x += Math.sin(a * 0.5) * 0.25; tgt.y += Math.sin(a * 0.7) * 0.15; }
    cam.fov = fov;
    cam.up.set(Math.sin(roll), Math.cos(roll), 0);
    cam.lookAt(tgt);
  };
  return seg;
}

// =================================================================================================
// Post pipeline: segment render targets → bloom → composite (transition, grade, tilt-shift, ACES)
// =================================================================================================

function makePost(renderer, hdr, samples) {
  const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const mkRT = (s, depth = true) => new THREE.WebGLRenderTarget(1, 1, { type, samples: s, depthBuffer: depth, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const rtA = mkRT(samples), rtB = mkRT(samples), rtH1 = mkRT(0, false), rtH2 = mkRT(0, false);
  const TU = { tA: { value: rtA.texture }, tB: { value: rtB.texture }, uMode: { value: 0 }, uProg: { value: 0 }, uAspect: { value: 1 }, uTime: { value: 0 } };
  const base = { vertexShader: TRI_VS, depthTest: false, depthWrite: false, toneMapped: false };
  const bright = new THREE.ShaderMaterial({ ...base, fragmentShader: BRIGHT_FS, uniforms: { ...TU, uTexel: { value: new THREE.Vector2() }, uThresh: { value: hdr ? 1.0 : 0.82 } } });
  const blur = new THREE.ShaderMaterial({ ...base, fragmentShader: BLUR_FS, uniforms: { tIn: { value: null }, uDir: { value: new THREE.Vector2() } } });
  const comp = new THREE.ShaderMaterial({
    ...base, fragmentShader: COMP_FS,
    uniforms: {
      ...TU, tBloom: { value: rtH1.texture }, uBloom: { value: 0.6 }, uExposure: { value: 1 }, uSat: { value: 1 }, uCon: { value: 1 }, uVig: { value: 0.3 },
      uTilt: { value: 0 }, uFocus: { value: 0.5 }, uFlash: { value: 0 }, uFade: { value: 0 }, uGrain: { value: 0.012 }, uHDR: { value: hdr ? 1 : 0 },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() }, uFlashCol: { value: new THREE.Vector3(2.4, 2.05, 1.6) },
      uPx: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
    },
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, comp);
  quad.frustumCulled = false;
  const pScene = new THREE.Scene();
  pScene.add(quad);
  const pCam = new THREE.Camera();
  let W = 1, H = 1;
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(pScene, pCam); };
  return {
    rtA, rtB, TU, comp,
    setSize(w, h) {
      W = w; H = h;
      rtA.setSize(w, h); rtB.setSize(w, h);
      const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
      rtH1.setSize(qw, qh); rtH2.setSize(qw, qh);
      bright.uniforms.uTexel.value.set(1 / w, 1 / h);
      comp.uniforms.uPx.value.set(1 / w, 1 / h);
      comp.uniforms.uRes.value.set(w, h);
      TU.uAspect.value = w / h;
    },
    /** Bloom from the (transitioned) scene, then the final composite to the canvas. */
    finish() {
      pass(bright, rtH1);
      const qw = rtH1.width, qh = rtH1.height;
      for (const s of [1, 2.2]) {
        blur.uniforms.tIn.value = rtH1.texture; blur.uniforms.uDir.value.set(s / qw, 0); pass(blur, rtH2);
        blur.uniforms.tIn.value = rtH2.texture; blur.uniforms.uDir.value.set(0, s / qh); pass(blur, rtH1);
      }
      pass(comp, null);
    },
    dispose() {
      for (const r of [rtA, rtB, rtH1, rtH2]) r.dispose();
      for (const m of [bright, blur, comp]) m.dispose();
      tri.dispose();
    },
    get size() { return [W, H]; },
  };
}

// =================================================================================================
// Overlay (DOM over the canvas): title cards, subtitles, progress dots, optional controls
// =================================================================================================

const FILM_CSS = `
.btf-host-rel{position:relative}
.btf-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.btf-root{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:#fff;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;container-type:size;-webkit-font-smoothing:antialiased;z-index:2}
.btf-root.btf-nogl{background:var(--btf-bg,linear-gradient(180deg,#1b2a4a,#0e1630));transition:background 1.2s ease}
.btf-nogl .btf-card{top:calc(9% + 34px)}
.btf-card{position:absolute;left:0;right:0;top:9%;display:flex;flex-direction:column;align-items:center;gap:.6em;padding:0 7%;text-align:center;opacity:0;transform:translateY(14px) scale(.985);transition:opacity .8s ease,transform 1.2s cubic-bezier(.16,1,.3,1)}
.btf-card.is-on{opacity:1;transform:none}
.btf-kicker{font-weight:600;font-size:clamp(9px,1.2vw,13px);font-size:clamp(8.5px,1.3cqw,16px);letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.9);padding:.55em 1.1em;border-radius:99px;background:rgba(8,10,22,.34);border:1px solid rgba(255,255,255,.2);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.btf-title{margin:0;font-family:Unbounded,Inter,system-ui,sans-serif;font-weight:800;font-size:clamp(15px,3.4vw,54px);font-size:clamp(14px,4.1cqw,72px);line-height:1.1;letter-spacing:-.012em;max-width:21ch;text-wrap:balance;text-shadow:0 1px 2px rgba(0,0,0,.45),0 4px 30px rgba(0,0,0,.5)}
.btf-sub{position:absolute;left:50%;bottom:calc(5% + 18px);transform:translate(-50%,8px);width:max-content;max-width:min(88%,58ch);padding:.5em 1em .56em;border-radius:14px;background:rgba(6,8,18,.6);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-weight:500;font-size:clamp(12px,1.7vw,21px);font-size:clamp(11px,1.85cqw,28px);line-height:1.42;text-align:center;text-wrap:pretty;opacity:0;transition:opacity .45s ease,transform .6s cubic-bezier(.16,1,.3,1)}
.btf-sub.is-on{opacity:1;transform:translate(-50%,0)}
.btf-who{font-weight:700;color:#ffcf7a}
.btf-sub.is-line .btf-txt{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-weight:600}
.btf-dots{position:absolute;left:50%;bottom:calc(2.4% + 2px);transform:translateX(-50%);display:flex;gap:6px;align-items:center}
.btf-dot{position:relative;width:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.34);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:width .6s cubic-bezier(.16,1,.3,1),background .3s}
.btf-dot.is-past{background:rgba(255,255,255,.88)}
.btf-dot.is-cur{width:26px}
.btf-dot i{position:absolute;inset:0;background:#fff;transform-origin:0 50%;transform:scaleX(0)}
.btf-end{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:.55em;padding:0 8% 6%;text-align:center;opacity:0;transform:scale(.97);transition:opacity 1.3s ease,transform 2s cubic-bezier(.16,1,.3,1)}
.btf-end.is-on{opacity:1;transform:none}
.btf-end::before{content:"";position:absolute;inset:-10%;z-index:-1;background:radial-gradient(closest-side,rgba(4,5,12,.5),rgba(4,5,12,0))}
.btf-end-k{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-weight:600;font-size:clamp(12px,1.8vw,26px);font-size:clamp(11px,2.3cqw,34px);color:#ffe2a8;text-shadow:0 2px 18px rgba(0,0,0,.6)}
.btf-end-t{margin:0;font-family:Unbounded,Inter,system-ui,sans-serif;font-weight:800;font-size:clamp(16px,3.8vw,60px);font-size:clamp(15px,4.6cqw,80px);line-height:1.08;max-width:18ch;text-wrap:balance;text-shadow:0 2px 4px rgba(0,0,0,.4),0 6px 40px rgba(0,0,0,.55)}
.btf-note{position:absolute;left:50%;top:10px;transform:translateX(-50%);max-width:92%;padding:.4em .9em;border-radius:99px;background:rgba(6,8,18,.6);font-size:12px;color:#c3cbe0;text-align:center}
.btf-ctrl{position:absolute;right:10px;top:10px;display:flex;gap:6px;pointer-events:auto}
.btf-btn{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(6,8,18,.55);color:#fff;cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:background .2s,border-color .2s}
.btf-btn:hover{background:rgba(20,26,44,.75);border-color:rgba(95,225,255,.5)}
.btf-btn:focus-visible{outline:2px solid #5fe1ff;outline-offset:2px}
.btf-btn svg{width:20px;height:20px;fill:currentColor}
.btf-btn[aria-pressed="false"]{opacity:.6}
@container (max-width:460px){.btf-sub{bottom:calc(4% + 14px);max-width:94%;padding:.42em .8em .46em;border-radius:10px}.btf-dots{gap:4px}.btf-dot{width:5px;height:5px}.btf-dot.is-cur{width:18px}.btf-card{top:7%;gap:.45em}}
@container (max-height:230px){.btf-kicker{display:none}}
@container (max-width:560px){.btf-root.has-ctrl .btf-card{top:calc(7% + 52px)}}
@media (prefers-reduced-motion:reduce){.btf-card,.btf-sub,.btf-end{transform:none!important;transition-property:opacity!important}.btf-dot{transition:none}}
`;

function injectCSS() {
  if (typeof document === "undefined" || document.getElementById("btf-style")) return;
  const s = document.createElement("style");
  s.id = "btf-style";
  s.textContent = FILM_CSS;
  document.head.appendChild(s);
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="2.6" height="14" rx="1"/><path d="M19 6.2v11.6a.9.9 0 0 1-1.4.75L9.3 12.75a.9.9 0 0 1 0-1.5l8.3-5.8A.9.9 0 0 1 19 6.2z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16.4" y="5" width="2.6" height="14" rx="1"/><path d="M5 6.2v11.6a.9.9 0 0 0 1.4.75l8.3-5.8a.9.9 0 0 0 0-1.5L6.4 5.45A.9.9 0 0 0 5 6.2z"/></svg>',
  voice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7l-1.1-1.1a3.4 3.4 0 0 0 0-4.8zM17.9 6.1a8.4 8.4 0 0 1 0 11.8l-1.1-1.1a6.8 6.8 0 0 0 0-9.6z"/></svg>',
};

function buildOverlay(root, nScenes, L, withControls) {
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const card = mk("div", "btf-card"), kicker = mk("span", "btf-kicker"), title = mk("p", "btf-title");
  card.append(kicker, title);
  const sub = mk("div", "btf-sub"), who = mk("span", "btf-who"), txt = mk("span", "btf-txt");
  sub.setAttribute("aria-live", "polite");
  sub.append(who, txt);
  const dots = mk("div", "btf-dots");
  dots.setAttribute("role", "img");
  dots.setAttribute("aria-label", L.progress);
  const dotEls = [];
  for (let n = 0; n < nScenes; n++) { const d = mk("span", "btf-dot"); const f = mk("i"); d.append(f); dots.append(d); dotEls.push({ d, f }); }
  const end = mk("div", "btf-end"), endK = mk("span", "btf-end-k"), endT = mk("p", "btf-end-t");
  end.append(endT, endK);
  root.append(card, sub, dots, end);
  let ctrl = null;
  if (withControls) {
    ctrl = mk("div", "btf-ctrl");
    const btn = (name, label) => { const b = mk("button", "btf-btn"); b.type = "button"; b.innerHTML = ICONS[name]; b.setAttribute("aria-label", label); b.title = label; ctrl.append(b); return b; };
    ctrl.prev = btn("prev", L.prev); ctrl.pp = btn("play", L.play); ctrl.next = btn("next", L.next); ctrl.voice = btn("voice", L.voiceOn);
    root.append(ctrl);
    root.classList.add("has-ctrl");
  }
  return { card, kicker, title, sub, who, txt, dots, dotEls, end, endK, endT, ctrl, last: {} };
}

/** Split long narration into subtitle chunks of at most ~max characters, on sentence / clause boundaries. */
function chunkText(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const parts = t.match(/[^.!?…]+[.!?…]+["»”')\]]*\s*|[^.!?…]+$/g) || [t];
  const out = [];
  let cur = "";
  const push = (s) => {
    s = s.trim();
    if (!s) return;
    if (s.length <= max * 1.15) { out.push(s); return; }
    // very long sentence: split on commas / dashes / spaces
    let c = "";
    for (const w of s.split(/\s+/)) {
      if ((c + " " + w).trim().length > max && c) { out.push(c.trim()); c = w; } else c = (c + " " + w).trim();
    }
    if (c) out.push(c.trim());
  };
  for (const p of parts) {
    if ((cur + p).trim().length > max && cur) { push(cur); cur = p; } else cur += p;
  }
  push(cur);
  return out;
}

// =================================================================================================
// Speech (optional narration voice)
// =================================================================================================

const VOICE_LANG = { ru: "ru-RU", uk: "uk-UA", en: "en-US" };

function makeVoice(lang) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") return null;
  const tag = VOICE_LANG[lang] || "en-US", lc = tag.toLowerCase();
  let voice = null, known = false, token = 0;
  const norm = (s) => String(s || "").replace("_", "-").toLowerCase();
  const pickVoice = () => {
    let vs = [];
    try { vs = synth.getVoices() || []; } catch { vs = []; }
    if (!vs.length) return;
    known = true;
    voice = vs.find((v) => norm(v.lang) === lc && v.localService) || vs.find((v) => norm(v.lang) === lc) || vs.find((v) => norm(v.lang).startsWith(lang + "-")) || null;
  };
  pickVoice();
  const onVC = () => pickVoice();
  try { synth.addEventListener("voiceschanged", onVC); } catch { /* old browsers */ }
  return {
    /** Speak; returns false when there is no voice for the language (stay silent). */
    speak(text, h) {
      const my = ++token;
      if (known && !voice) return false;
      try {
        const u = new window.SpeechSynthesisUtterance(text);
        u.lang = tag;
        if (voice) u.voice = voice;
        u.rate = 1; u.pitch = 1; u.volume = 1;
        u.onstart = () => { if (my === token) h.start(); };
        u.onend = () => { if (my === token) h.end(true); };
        u.onerror = () => { if (my === token) h.end(false); };
        u.onboundary = (e) => { if (my === token && typeof e.charIndex === "number") h.boundary(e.charIndex); };
        synth.speak(u);
        return true;
      } catch { return false; }
    },
    cancel() { token++; try { if (synth.speaking || synth.pending) synth.cancel(); } catch { /* ignore */ } },
    dispose() { this.cancel(); try { synth.removeEventListener("voiceschanged", onVC); } catch { /* ignore */ } },
  };
}

// =================================================================================================
// Film data normalisation (unknown enums / ids never crash the film)
// =================================================================================================

const SETTING_ALIAS = {
  beach: "island", coast: "island", ocean: "sea", lake: "sea", river: "meadow", harbor: "sea", port: "sea", home: "room", house: "room",
  bedroom: "room", kitchen: "room", study: "library", office: "room", hall: "ballroom", ball: "ballroom", court: "palace", throne_room: "palace",
  market: "street", town: "city", square: "street", farm: "village", field: "meadow", fields: "meadow", jungle: "forest", woods: "forest", wood: "forest",
  park: "garden", prison: "cave", dungeon: "cave", mine: "cave", temple: "church", cathedral: "church", chapel: "church", monastery: "church",
  inn: "tavern", pub: "tavern", bar: "tavern", arctic: "snow", tundra: "snow", winter: "snow", deck: "ship", boat: "ship", spaceship: "space",
  planet: "space", moon: "space", asteroid: "space", war: "battlefield", battle: "battlefield", classroom: "school", university: "school",
  hill: "mountains", hills: "mountains", mountain: "mountains", valley: "meadow", bog: "swamp", marsh: "swamp", fortress: "castle", station: "train",
  railway: "train", sky: "space", underground: "cave", ruins: "castle", graveyard: "church", cemetery: "church",
};
const TIME_ALIAS = { morning: "dawn", sunrise: "dawn", noon: "day", afternoon: "day", daytime: "day", evening: "dusk", sunset: "dusk", twilight: "dusk", midnight: "night" };
const WEATHER_ALIAS = { sunny: "clear", sun: "clear", storm: "rain", rainy: "rain", thunderstorm: "rain", snowy: "snow", blizzard: "snow", mist: "fog", foggy: "fog", misty: "fog", starry: "stars", windy: "wind", breeze: "wind" };
const ACTION_ALIAS = { run: "chase", running: "chase", fly: "travel", journey: "travel", walking: "walk", battle: "fight", duel: "fight", sleep: "rest", sit: "rest", cry: "sad", party: "celebrate", feast: "celebrate", explore: "discover", search: "discover", speak: "talk", argue: "talk", idle: "talk", wave: "talk" };
const CAMERA_ALIAS = { zoom: "dolly_in", dolly: "dolly_in", push_in: "dolly_in", tracking: "pan", aerial: "fly_over", flyover: "fly_over", closeup: "close_up", close: "close_up", rotate: "orbit" };
const MOOD_ALIAS = { happy: "joyful", sad: "melancholic", scary: "tense", dark: "mysterious", love: "romantic", heroic: "epic", peaceful: "calm", dreamy: "magical" };
const normEnum = (v, list, alias, fb) => { const s = str(v).toLowerCase().replace(/[\s-]+/g, "_"); return list.includes(s) ? s : alias[s] || fb; };

function normalizeFilm(book) {
  const f = book.film && typeof book.film === "object" ? book.film : {};
  const chars = new Map();
  for (const c of Array.isArray(book.characters) ? book.characters : []) {
    if (c && typeof c.id === "string" && c.id && !chars.has(c.id)) chars.set(c.id, { name: str(c.name) || c.id, appearance: c.appearance });
  }
  const scenes = (Array.isArray(f.scenes) ? f.scenes : []).filter((s) => s && typeof s === "object").slice(0, 12).map((s) => {
    const line = s.line && typeof s.line === "object" && str(s.line.text) ? { speaker: str(s.line.speaker), text: str(s.line.text) } : null;
    const props = [];
    for (const p of Array.isArray(s.props) ? s.props : []) { const n = str(p).toLowerCase(); if (SCENE_PROPS.includes(n) && !props.includes(n)) props.push(n); }
    return {
      title: str(s.title), narration: str(s.narration), line,
      setting: normEnum(s.setting, SETTINGS, SETTING_ALIAS, "meadow"),
      time: normEnum(s.time, TIMES, TIME_ALIAS, "day"),
      weather: normEnum(s.weather, WEATHER, WEATHER_ALIAS, "clear"),
      action: normEnum(s.action, ACTIONS, ACTION_ALIAS, "talk"),
      camera: normEnum(s.camera, CAMERAS, CAMERA_ALIAS, "orbit"),
      mood: normEnum(s.mood, MOODS, MOOD_ALIAS, "calm"),
      cast: (Array.isArray(s.cast) ? s.cast : []).filter((id) => typeof id === "string" && id),
      props: props.slice(0, 5),
    };
  });
  return { title: str(f.title) || str(book.title), intro: str(f.intro), outro: str(f.outro), scenes, chars };
}

/** Scene length: long enough to read (or hear) the narration and the line. */
function sceneDuration(sc) {
  const narr = sc.narration.length / CPS, ln = sc.line ? sc.line.text.length / CPS + 1 : 0;
  return Math.max(SCENE_MIN, narr + 1.5 + ln);
}

// =================================================================================================
// createFilm — the public API
// =================================================================================================

const LANGS3 = ["ru", "uk", "en"];

export function createFilm(container, opts = {}) {
  if (!container || typeof container.appendChild !== "function") throw new TypeError("createFilm(container): a DOM element is required");
  injectCSS();
  const book = opts.book && typeof opts.book === "object" ? opts.book : {};
  const lang = LANGS3.includes(opts.lang) ? opts.lang : LANGS3.includes(book.lang) ? book.lang : "en";
  const L = STR[lang];
  const data = normalizeFilm(book);
  const nS = data.scenes.length;
  const reduced = prefersReducedMotion();
  let coarse = false;
  try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { /* ignore */ }
  const lowQ = !!opts.lowQuality || coarse || Math.min(window.screen?.width || 1920, window.screen?.height || 1080) < 600;

  // ---- timeline: intro, scenes, outro (durations may grow while speech is still running)
  const segs = [{ kind: "intro", idx: -1, base: clamp(data.intro.length / CPS + 1.6, 5.4, 10), narr: data.intro, line: null }];
  data.scenes.forEach((sc, i) => segs.push({ kind: "scene", idx: i, sc, base: sceneDuration(sc), narr: sc.narration, line: sc.line }));
  segs.push({ kind: "outro", idx: nS, base: clamp(data.outro.length / CPS + 2.6, 6.2, 11), narr: data.outro, line: null });
  let total = 0;
  const relayout = () => { let t = 0; for (const s of segs) { s.start = t; t += s.dur; } total = t; };
  for (const s of segs) s.dur = s.base;
  relayout();

  // ---- DOM
  let madeRel = false;
  try { if (getComputedStyle(container).position === "static") { container.classList.add("btf-host-rel"); madeRel = true; } } catch { /* ignore */ }
  const canvas = document.createElement("canvas");
  canvas.className = "btf-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", data.title || L.film);
  const root = document.createElement("div");
  root.className = "btf-root";
  container.append(canvas, root);
  const ui = buildOverlay(root, nS, L, !!opts.controls);

  // ---- renderer + shared resources
  const U = { time: { value: 0 }, wind: { value: 0 }, pscale: { value: 800 }, pmax: { value: 64 } };
  let renderer = null, post = null, hdr = false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x04050b, 1);
    renderer.info.autoReset = false;
    hdr = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
    post = makePost(renderer, hdr, lowQ ? 2 : 4);
  } catch (err) {
    console.warn("[film] WebGL unavailable, showing a storyboard", err);
    try { renderer?.dispose(); } catch { /* ignore */ }
    renderer = null; post = null;
    canvas.remove();
    root.classList.add("btf-nogl");
    const note = document.createElement("p");
    note.className = "btf-note";
    note.textContent = L.nogl;
    root.append(note);
  }
  const cov = book.cover && typeof book.cover === "object" ? book.cover : {};
  const pool = new Map(), inUse = new Set();
  const ctx = {
    renderer, U, reduced, lowQ, aspect: 16 / 9, shadowSize: lowQ ? 1024 : 2048,
    mats: renderer ? makeMaterials(U) : null,
    skyGeo: renderer ? new THREE.SphereGeometry(1500, 32, 16) : null,
    chars: data.chars, nScenes: nS, seedBase: str(book.id) || data.title || "booktrip",
    cover: { bg: hexC(cov.bg, 0x7a2a3a), bg2: hexC(cov.bg2, 0x3a1424), fg: hexC(cov.fg, 0xf6e7b0), accent: hexC(cov.accent, 0xe8b04a) },
    texts: { title: str(book.title) || data.title, author: str(book.author), intro: data.intro, outro: data.outro },
    redraws: [],
    acquire(id) {
      let list = pool.get(id);
      if (!list) pool.set(id, (list = []));
      let g = list.find((x) => !inUse.has(x));
      if (!g) {
        const ch = data.chars.get(id);
        if (!ch) return null;
        try { g = buildCharacter(normalizeAppearance(ch.appearance)); } catch (err) { console.warn("[film] character skipped", id, err); return null; }
        list.push(g);
      }
      inUse.add(g);
      return g;
    },
    release(g) { inUse.delete(g); if (g.parent) g.parent.remove(g); },
  };

  // ---- state
  let T = 0, animT = 0, userPlaying = false, ended = false, endFired = false, disposed = false;
  let hidden = typeof document !== "undefined" && document.hidden, offscreen = false, suspended = hidden;
  let raf = 0, lastNow = 0, curSeg = -1, quality = 1, debug = false;
  let W = 1, H = 1, dprUsed = 1;
  const built = new Map();
  let job = null;
  const ft = [];
  let fps = 0;

  // ---- segment building (incremental, a few ms per frame)
  function startJob(i) {
    const s = segs[i];
    let gen;
    try { gen = s.kind === "scene" ? sceneSegmentGen(ctx, s.sc, s.idx) : deskSegmentGen(ctx, s.kind); } catch (err) { gen = null; }
    job = { i, gen };
  }
  function fallbackSeg(i) {
    const s = segs[i];
    if (s.kind === "scene" && s.sc.setting !== "meadow") {
      try { return drain(sceneSegmentGen(ctx, { ...s.sc, setting: "meadow", props: [], cast: [] }, s.idx)); } catch { /* fall through */ }
    }
    const seg = newSegment(ctx, s.kind, s.idx, TIME_LOOK.night, MOOD_LOOK.calm, new THREE.Vector3(), 60);
    seg.update = (l, a) => { seg.camera.position.set(0, 30, 120); seg.camera.lookAt(0, 20, 0); };
    return seg;
  }
  function drain(gen) { let r; do { r = gen.next(); } while (!r.done); return r.value; }
  function stepJob(budgetMs, sync) {
    if (!job) return;
    const t0 = performance.now();
    try {
      if (!job.gen) throw new Error("no generator");
      for (;;) {
        const r = job.gen.next();
        if (r.done) {
          built.set(job.i, r.value);
          if (!sync && renderer.compileAsync) renderer.compileAsync(r.value.scene, r.value.camera).catch(() => {});
          job = null;
          return;
        }
        if (!sync && performance.now() - t0 > budgetMs) return;
      }
    } catch (err) {
      console.warn("[film] segment build failed", segs[job.i]?.kind, err);
      built.set(job.i, fallbackSeg(job.i));
      job = null;
    }
  }
  function ensure(i, sync) {
    if (!renderer || i < 0 || i >= segs.length) return null;
    if (built.has(i)) return built.get(i);
    if (!job || job.i !== i) {
      if (job && !sync) return null;
      startJob(i);
    }
    stepJob(0, sync);
    return built.get(i) || null;
  }
  function pump(budgetMs) {
    if (!renderer) return;
    if (!job) {
      for (const i of [curSeg, curSeg + 1]) if (i >= 0 && i < segs.length && !built.has(i)) { startJob(i); break; }
    }
    stepJob(budgetMs, false);
  }
  function disposeSeg(seg) {
    for (const c of seg.cast) ctx.release(c.g);
    for (const g of seg.geos) g.dispose();
    for (const m of seg.own) m.dispose();
    try { seg.sun.dispose(); for (const p of seg.points) p.dispose(); } catch { /* ignore */ }
    seg.scene.clear();
  }
  function prune(keep) {
    for (const [i, seg] of built) if (!keep.includes(i)) { disposeSeg(seg); built.delete(i); }
    if (job && !keep.includes(job.i)) job = null;
  }

  // ---- timeline helpers
  function segIndexAt(t) {
    for (let i = 0; i < segs.length; i++) if (t < segs[i].start + segs[i].dur) return i;
    return segs.length - 1;
  }
  function frameState(t) {
    const i = segIndexAt(t), s = segs[i], l = clamp(t - s.start, 0, s.dur);
    let mode = 0, prog = 0, j = -1;
    if (i > 0 && segs[i - 1].kind === "intro" && l < IRIS) { mode = 2; prog = l / IRIS; }
    else if (i + 1 < segs.length && s.kind !== "intro" && l > s.dur - TRANS) { mode = 1; prog = sat((l - (s.dur - TRANS)) / TRANS); j = i + 1; }
    return { i, s, l, mode, prog, j };
  }
  function extend(i, d) { segs[i].dur += d; relayout(); }

  // ---- speech + subtitles
  const voice = makeVoice(lang);
  let ttsBroken = !voice;
  const ttsWanted = () => { try { return !!opts.tts; } catch { return false; } };
  let ttsOverride = null;
  const ttsOn = () => !debug && !ttsBroken && (ttsOverride ?? ttsWanted());
  // phase: 0 waiting, 1 narration, 2 line, 3 done; timed = following the clock instead of the voice
  let sp = { seg: -1, phase: 0, started: false, t0: 0, chars: 0, timed: false, lineAt: 0 };
  function resetSpeech(i) { if (voice) voice.cancel(); sp = { seg: i, phase: 0, started: false, t0: 0, chars: 0, timed: false, lineAt: 0 }; }
  function speakPhase(ph) {
    const s = segs[sp.seg];
    const text = ph === 1 ? s.narr : s.line ? s.line.text : "";
    sp.phase = ph; sp.started = false; sp.t0 = animT; sp.chars = 0;
    if (!text) { advancePhase(); return; }
    const my = sp;
    const ok = voice.speak(text, {
      start: () => { if (my === sp) my.started = true; },
      boundary: (c) => { if (my === sp) my.chars = c; },
      end: (ok) => {
        if (my !== sp) return;
        if (ok || my.started) advancePhase();
        else { my.timed = true; ttsBroken = true; } // the engine failed before speaking: follow the clock
      },
    });
    if (!ok) { sp.timed = true; }
  }
  function advancePhase() {
    const s = segs[sp.seg];
    if (sp.phase === 1 && s.line) { sp.lineAt = segLocal(sp.seg); speakPhase(2); } else sp.phase = 3;
  }
  const segLocal = (i) => T - segs[i].start;
  function tickSpeech(st) {
    if (sp.seg !== st.i) resetSpeech(st.i);
    if (!ttsOn() || sp.timed) { if (voice && sp.phase && sp.phase < 3 && !sp.timed) { voice.cancel(); sp.timed = true; } return; }
    const s = st.s;
    if (sp.phase === 0 && st.l >= (s.kind === "scene" ? 0.5 : 0.6) && s.narr) speakPhase(1);
    // a voice that never starts (blocked autoplay, broken engine) → follow the clock from now on
    if ((sp.phase === 1 || sp.phase === 2) && !sp.started && animT - sp.t0 > 2.2) { voice.cancel(); ttsBroken = true; sp.timed = true; }
  }
  function speaking(st) { return ttsOn() && !sp.timed && sp.seg === st.i && (sp.phase === 1 || sp.phase === 2); }

  /** Which subtitle to show for segment state st → { who, text, line } or null. */
  function subtitleFor(st) {
    const s = st.s, l = st.l;
    if (st.mode === 1 && st.prog > 0.45) return null;
    const narr = s.narr, line = s.line;
    const maxC = W < 420 ? 86 : 108; // about two subtitle lines at every size
    const voiced = ttsOn() && !sp.timed && sp.seg === st.i && sp.phase > 0;
    let showLine = false, frac = 0;
    if (voiced) {
      if (sp.phase === 1) frac = sp.chars > 0 ? sp.chars / Math.max(1, narr.length) : (animT - sp.t0) / Math.max(1, narr.length / CPS);
      else showLine = !!line;
      if (sp.phase === 3 && !line) return null;
    } else {
      const n0 = s.kind === "scene" ? 0.5 : 0.6, nT = narr.length / CPS + 0.6;
      if (l < n0) return null;
      if (l < n0 + nT || !line) {
        if (!line && l > n0 + nT + 1.2 && s.kind !== "outro") return null;
        frac = (l - n0) / nT;
      } else showLine = true;
    }
    if (showLine && line) {
      const ch = data.chars.get(line.speaker);
      return { who: ch ? ch.name + ": " : "", text: "«" + line.text + "»", line: true };
    }
    if (!narr) return null;
    const chunks = chunkText(narr, maxC);
    if (!chunks.length) return null;
    // pick the chunk by its share of characters
    const totalC = chunks.reduce((a, c) => a + c.length, 0);
    let acc = 0, idx = 0;
    const at = clamp(frac, 0, 0.999) * totalC;
    for (; idx < chunks.length - 1; idx++) { acc += chunks[idx].length; if (acc > at) break; }
    return { who: "", text: chunks[idx], line: false };
  }

  // ---- overlay
  function setOn(el, on, key) { if (ui.last[key] !== on) { ui.last[key] = on; el.classList.toggle("is-on", on); } }
  function updateOverlay(st) {
    const s = st.s, l = st.l;
    // title card
    let cardOn = false, kick = "", title = "";
    if (s.kind === "intro") { cardOn = l > 0.7 && l < Math.min(3.8, s.dur - DIVE - 0.2); kick = L.film; title = data.title; }
    else if (s.kind === "scene") {
      const t0 = s.idx === 0 ? IRIS * 0.7 : 0.35;
      cardOn = l > t0 && l < t0 + Math.min(3.2, s.dur * 0.42) && st.mode !== 1;
      kick = L.scene.replace("{n}", String(s.idx + 1)).replace("{m}", String(nS));
      title = s.sc.title;
    }
    if (!title) cardOn = false;
    if (cardOn && ui.last.title !== title + kick) { ui.last.title = title + kick; ui.kicker.textContent = kick; ui.title.textContent = title; }
    setOn(ui.card, cardOn, "card");
    // subtitles
    const sub = subtitleFor(st);
    const key = sub ? sub.who + "|" + sub.text : "";
    if (sub && ui.last.sub !== key) {
      ui.last.sub = key;
      ui.who.textContent = sub.who;
      ui.who.hidden = !sub.who;
      ui.txt.textContent = sub.text;
      ui.sub.classList.toggle("is-line", sub.line);
    }
    setOn(ui.sub, !!sub, "subOn");
    // progress dots
    const cur = s.kind === "scene" ? s.idx : s.kind === "outro" ? nS : -1;
    if (ui.last.dot !== cur) {
      ui.last.dot = cur;
      ui.dotEls.forEach((d, n) => { d.d.classList.toggle("is-cur", n === cur); d.d.classList.toggle("is-past", n < cur); d.f.style.transform = n < cur ? "scaleX(1)" : "scaleX(0)"; });
    }
    if (cur >= 0 && cur < nS) ui.dotEls[cur].f.style.transform = `scaleX(${sat(l / s.dur).toFixed(3)})`;
    // end title
    const endOn = s.kind === "outro" && l > 2.9 && !(endFired && typeof opts.onEnd === "function" && !debug);
    if (endOn && !ui.last.endText) { ui.last.endText = true; ui.endT.textContent = data.title || ctx.texts.title; ui.endK.textContent = L.end; }
    setOn(ui.end, endOn, "end");
    if (!renderer) {
      const sc = s.kind === "scene" ? s.sc : null;
      const lk = sc ? TIME_LOOK[sc.time] : DESK_LOOK;
      const bg = `linear-gradient(180deg, ${cssC(lk.top)}, ${cssC(lk.mid)} 62%, ${cssC(lk.bot)})`;
      if (ui.last.bg !== bg) { ui.last.bg = bg; root.style.setProperty("--btf-bg", bg); }
    }
    if (ui.ctrl) {
      const want = userPlaying && !ended ? "pause" : "play";
      if (ui.last.pp !== want) { ui.last.pp = want; ui.ctrl.pp.innerHTML = ICONS[want]; const lb = want === "pause" ? L.pause : ended ? L.replay : L.play; ui.ctrl.pp.setAttribute("aria-label", lb); ui.ctrl.pp.title = lb; }
      const v = ttsOverride ?? ttsWanted();
      if (ui.last.v !== v) { ui.last.v = v; ui.ctrl.voice.setAttribute("aria-pressed", v ? "true" : "false"); const lb = v ? L.voiceOn : L.voiceOff; ui.ctrl.voice.setAttribute("aria-label", lb); ui.ctrl.voice.title = lb; }
    }
  }

  // ---- rendering
  const _tint = new THREE.Vector3(), _lift = new THREE.Vector3();
  function renderSeg(seg, i, l, target, lineOn, lineK) {
    seg.dur = segs[i].dur;
    seg.update(l, animT, lineOn, lineK);
    U.wind.value = seg.look.wind;
    ctx.mats[M_GLOW].color.setScalar(seg.look.glow);
    const cam = seg.camera;
    cam.aspect = ctx.aspect;
    cam.updateProjectionMatrix();
    seg.sky.position.copy(cam.position);
    U.pscale.value = H / (2 * Math.tan((cam.fov * Math.PI) / 360));
    renderer.setRenderTarget(target);
    renderer.render(seg.scene, cam);
  }
  function draw() {
    if (disposed) return;
    const st = frameState(T);
    if (st.i !== curSeg) {
      const prev = curSeg;
      curSeg = st.i;
      prune([curSeg, curSeg + 1]);
      if (st.s.kind === "scene" && prev !== curSeg) { try { opts.onScene?.(st.s.idx); } catch (err) { console.warn(err); } }
    }
    tickSpeech(st);
    updateOverlay(st);
    if (!renderer) return;
    const A = ensure(st.i, true);
    const B = st.j >= 0 ? ensure(st.j, true) : null;
    if (!A) return;
    renderer.info.reset();
    U.time.value = animT;
    const s = st.s;
    const sub = subtitleFor(st);
    const lineOn = !!(sub && sub.line);
    if (lineOn && !sp.lineSeen) { sp.lineSeen = true; sp.lineStart = st.l; }
    const lineK = lineOn ? sat((st.l - (sp.lineStart ?? st.l)) / 0.9) : 0;
    const P = post;
    if (st.mode === 2) {
      renderSeg(A, st.i, st.l, P.rtB, lineOn, lineK);
      P.TU.tA.value = P.rtB.texture; P.TU.tB.value = P.rtB.texture;
    } else {
      renderSeg(A, st.i, st.l, P.rtA, lineOn, lineK);
      P.TU.tA.value = P.rtA.texture; P.TU.tB.value = P.rtA.texture;
      if (B) { renderSeg(B, st.j, 0, P.rtB, false, 0); P.TU.tB.value = P.rtB.texture; }
    }
    P.TU.uMode.value = st.mode === 1 && B ? 1 : st.mode === 2 ? 2 : 0;
    P.TU.uProg.value = st.mode === 2 ? easeOut(st.prog) : easeInOut(st.prog);
    P.TU.uTime.value = animT;
    const k = st.mode === 1 && B ? smooth(st.prog) : 0;
    const g0 = A.grade, g1 = B ? B.grade : A.grade;
    const cu = P.comp.uniforms;
    cu.uTint.value.copy(_tint.set(...g0.tint).lerp(_lift.set(...g1.tint), k));
    cu.uLift.value.copy(_tint.set(...g0.lift).lerp(_lift.set(...g1.lift), k));
    cu.uSat.value = lerp(g0.sat, g1.sat, k);
    cu.uCon.value = lerp(g0.con, g1.con, k);
    cu.uVig.value = lerp(g0.vig, g1.vig, k);
    cu.uBloom.value = lerp(g0.bloom, g1.bloom, k) * (hdr ? 1 : 0.7);
    cu.uExposure.value = lerp(A.look.exposure, B ? B.look.exposure : A.look.exposure, k);
    cu.uTilt.value = lerp(A.tilt, B ? B.tilt : A.tilt, k) * 3.4 * dprUsed;
    cu.uFocus.value = 0.5;
    cu.uFlash.value = s.kind === "intro" ? smooth(range(st.l, s.dur - 0.5, s.dur)) : 0;
    cu.uFade.value = s.kind === "intro" ? 1 - smooth(st.l / 0.9) : 0;
    P.finish();
  }

  // ---- clock
  function advance(dt) {
    animT += dt;
    let st = frameState(T);
    const s = st.s;
    // hold the current segment while its narration is still being spoken (capped), or while the next one builds
    const holdAt = s.kind === "intro" ? s.dur - DIVE - 0.1 : s.kind === "scene" ? s.dur - TRANS - 0.15 : s.dur - 0.3;
    const cap = s.kind === "scene" ? Math.max(s.base, SPEECH_CAP) : Math.max(s.base, 16);
    if (st.l + dt >= holdAt && st.l <= holdAt + dt && s.dur < cap && speaking(st)) { extend(st.i, dt); }
    else if (renderer && st.i + 1 < segs.length && !built.has(st.i + 1) && st.l + dt >= holdAt - 0.05 && s.dur - s.base < 2.5) { extend(st.i, dt); pump(14); }
    T = Math.min(T + dt, total);
    if (T >= total - 1e-6) {
      T = total;
      if (!ended) {
        ended = true;
        userPlaying = false;
        if (!endFired) { endFired = true; try { opts.onEnd?.(); } catch (err) { console.warn(err); } }
      }
    }
  }

  function running() { return userPlaying && !suspended && !ended && !disposed; }
  function schedule() { if (!raf && running()) { lastNow = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(now) {
    raf = 0;
    if (!running()) { draw(); return; }
    const dt = Math.min(0.25, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    advance(dt);
    pump(lowQ ? 5 : 8);
    draw();
    // adaptive resolution when frames are slow
    ft.push(dt);
    if (ft.length >= 45) {
      const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
      ft.length = 0;
      fps = Math.round(1 / Math.max(avg, 1e-3));
      if (avg > 0.05 && quality > 0.55) { quality = Math.max(0.55, quality * 0.85); resize(); }
    }
    if (running()) raf = requestAnimationFrame(frame);
    else if (ended) draw();
  }

  function resize() {
    if (disposed) return;
    const r = container.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    ctx.aspect = W / H;
    if (!renderer) return;
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * quality;
    if (W * H * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (W * H));
    dprUsed = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    post.setSize(v.x, v.y);
    U.pmax.value = 80 * dpr;
    H = v.y; // particle scale uses drawing-buffer pixels
    ctx.aspect = v.x / v.y;
    W = r.width;
  }

  // ---- listeners
  const onVis = () => { hidden = document.hidden; syncSuspend(); };
  document.addEventListener("visibilitychange", onVis);
  let io = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((es) => { for (const e of es) offscreen = !e.isIntersecting; syncSuspend(); }, { threshold: 0.12 });
    io.observe(container);
  }
  let ro = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => { resize(); if (!running()) draw(); });
    ro.observe(container);
  }
  const onLost = (e) => { e.preventDefault(); suspended = true; if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => { syncSuspend(); draw(); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  function syncSuspend() {
    const s = hidden || offscreen;
    if (s === suspended) return;
    suspended = s;
    if (s) pauseSpeech(); else resumeSpeech();
    schedule();
  }
  function pauseSpeech() { if (voice && (sp.phase === 1 || sp.phase === 2) && !sp.timed) { voice.cancel(); sp.resume = sp.phase; } }
  function resumeSpeech() { if (voice && sp.resume && running() && ttsOn()) { const ph = sp.resume; sp.resume = 0; speakPhase(ph); } }
  if (ui.ctrl) {
    ui.ctrl.pp.addEventListener("click", () => (userPlaying && !ended ? api.pause() : api.play()));
    ui.ctrl.prev.addEventListener("click", () => api.seek(Math.max(0, (segs[curSeg]?.kind === "scene" ? segs[curSeg].idx : nS) - 1)));
    ui.ctrl.next.addEventListener("click", () => { const c = segs[curSeg]; const n = c?.kind === "scene" ? c.idx + 1 : c?.kind === "intro" ? 0 : nS; if (n < nS) api.seek(n); });
    ui.ctrl.voice.addEventListener("click", () => api.setTts(!(ttsOverride ?? ttsWanted())));
  }

  // fonts arrive later than the first frame: redraw canvas text (pages, letters) once they are ready
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('600 52px "Playfair Display"'), document.fonts.load('italic 600 28px "Playfair Display"')]).catch(() => {}).then(() => {
      if (disposed) return;
      for (const r of ctx.redraws) { try { r(); } catch { /* ignore */ } }
      if (!running()) draw();
    });
  }

  resize();
  if (renderer) ensure(0, true);
  draw();

  const api = {
    play() {
      if (disposed) return;
      if (ended) api.restart();
      userPlaying = true;
      resumeSpeech();
      schedule();
      draw();
    },
    pause() {
      if (disposed) return;
      userPlaying = false;
      pauseSpeech();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      draw();
    },
    restart() {
      if (disposed) return;
      T = 0; animT = 0; ended = false; endFired = false; curSeg = -1;
      for (const s of segs) s.dur = s.base;
      relayout();
      resetSpeech(-1);
      ui.last = {};
      prune([0, 1]);
      draw();
      schedule();
    },
    /** Jump to the start of scene i (0-based). */
    seek(i) {
      if (disposed || !nS) return;
      const n = clamp(Math.round(Number(i) || 0), 0, nS - 1);
      T = segs[n + 1].start + (n === 0 ? IRIS : 0);
      ended = false; endFired = false;
      resetSpeech(-1);
      draw();
      schedule();
    },
    /** Debug / screenshots: render the frame at film time t (seconds) synchronously, no speech. */
    renderAt(t) {
      if (disposed) return null;
      debug = true;
      T = clamp(Number(t) || 0, 0, total);
      animT = T;
      draw();
      debug = false;
      const s = segs[segIndexAt(T)];
      return { kind: s.kind, index: s.idx, local: T - s.start };
    },
    setTts(on) {
      ttsOverride = !!on;
      if (!on && voice) { voice.cancel(); if (sp.phase === 1 || sp.phase === 2) sp.timed = true; }
      if (on) ttsBroken = !voice;
      if (!running()) draw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      userPlaying = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (voice) voice.dispose();
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect(); ro?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      job = null;
      for (const seg of built.values()) disposeSeg(seg);
      built.clear();
      for (const list of pool.values()) for (const g of list) disposeCharacter(g);
      pool.clear(); inUse.clear();
      if (renderer) {
        post.dispose();
        ctx.mats.forEach((m) => m.dispose());
        ctx.skyGeo.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch { /* ignore */ }
      }
      canvas.remove();
      root.remove();
      if (madeRel) container.classList.remove("btf-host-rel");
    },
    get playing() { return userPlaying && !ended && !disposed; },
    get ended() { return ended; },
    get duration() { return total; },
    get time() { return T; },
    get timeline() { return segs.map((s) => ({ kind: s.kind, index: s.idx, start: s.start, duration: s.dur })); },
    get scene() { const s = segs[segIndexAt(T)]; return s.kind === "scene" ? s.idx : -1; },
    get stats() { return { fps, quality, hdr, calls: renderer ? renderer.info.render.calls : 0, triangles: renderer ? renderer.info.render.triangles : 0, segments: built.size, webgl: !!renderer }; },
  };
  if (opts.autoplay) api.play();
  return api;
}

/** Internals for dev pages / tests only (not part of the contract). */
export const _debug = { buildWorld, normalizeFilm, SETTING_IDS: Object.keys(DEF), PROP_IDS: Object.keys(PROPS) };
