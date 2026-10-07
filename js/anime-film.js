// BookTrip — the anime "trip into the book": the same story as the 3D film (js/film.js), told with drawn key frames.
//
// createFilm(container, { book, lang, tts, onScene(i), onEnd(), autoplay?, controls? })
//   → { play(), pause(), restart(), dispose(), get playing, seek(sceneIndex), renderAt(seconds), setTts(on),
//       get ended, get duration, get time, get scene }                       (same contract as js/film.js)
//
// Sequence: a title card over the first frame → every scene shows two key frames (a wide establishing shot, then a
// closer shot of the cast) with a slow camera move (Ken Burns), a cross-fade between them, subtitles and the
// optional narration voice → an end card. Frames are drawn by js/anime.js; until a frame has loaded the film shows
// a painted gradient in the book's cover colours, so it can start at once.

import { animeFrameUrl, englishNarrations, loadAnimeImage } from "./anime.js";
import { hashStr, prefersReducedMotion } from "./util.js";

const CPS = 14;            // reading speed, characters per second
const SCENE_MIN = 8;       // seconds
const SPEECH_CAP = 20;     // a scene never waits for the voice longer than this beyond its own length
const FADE = 1.2;          // cross-fade between frames (s)
const LANGS3 = ["ru", "uk", "en"];
const STR = {
  ru: { film: "Мини-фильм", end: "Конец", painting: "Рисуем кадр…", scene: (i, n) => `Сцена ${i} из ${n}`, play: "Смотреть", pause: "Пауза" },
  uk: { film: "Мініфільм", end: "Кінець", painting: "Малюємо кадр…", scene: (i, n) => `Сцена ${i} з ${n}`, play: "Дивитися", pause: "Пауза" },
  en: { film: "Mini-film", end: "The End", painting: "Painting the frame…", scene: (i, n) => `Scene ${i} of ${n}`, play: "Watch", pause: "Pause" },
};
const VOICE_LANG = { ru: "ru-RU", uk: "uk-UA", en: "en-US" };

const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const hex = (v, fb) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fb);
const smooth = (t) => { t = sat(t); return t * t * (3 - 2 * t); };

let cssDone = false;
function injectCSS() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const s = document.createElement("style");
  s.dataset.owner = "anime-film";
  s.textContent = `
.baf-root{position:absolute;inset:0;overflow:hidden;background:#05060c;border-radius:inherit;color:#fff;font-family:inherit;user-select:none}
.baf-host-rel{position:relative}
.baf-layer{position:absolute;inset:0;opacity:0;will-change:opacity}
.baf-layer>div{position:absolute;inset:-2%;background-size:cover;background-position:center;will-change:transform}
.baf-paint{position:absolute;inset:0;opacity:1}
.baf-paint i{position:absolute;inset:-20%;filter:blur(40px);opacity:.85}
.baf-vign{position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 90% at 50% 45%,transparent 55%,rgba(0,0,0,.55) 100%),linear-gradient(180deg,rgba(0,0,0,.35),transparent 18%,transparent 70%,rgba(0,0,0,.55))}
.baf-wait{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:.55em 1em;border-radius:999px;background:rgba(8,10,20,.55);backdrop-filter:blur(6px);font-size:.9rem;letter-spacing:.02em;opacity:0;transition:opacity .4s}
.baf-wait.is-on{opacity:1}
.baf-card{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:6%;pointer-events:none;opacity:0}
.baf-card h3{margin:0;font-family:"Unbounded","Inter",sans-serif;font-weight:800;font-size:clamp(1.3rem,4.2vw,3.2rem);line-height:1.05;text-shadow:0 4px 30px rgba(0,0,0,.7)}
.baf-card p{margin:.6em 0 0;font-size:clamp(.85rem,1.8vw,1.25rem);opacity:.85;text-shadow:0 2px 12px rgba(0,0,0,.8)}
.baf-card small{display:block;margin-bottom:.8em;font-size:clamp(.7rem,1.3vw,.95rem);letter-spacing:.2em;text-transform:uppercase;opacity:.75}
.baf-sub{position:absolute;left:50%;bottom:7%;transform:translateX(-50%);width:min(88%,860px);text-align:center;font-size:clamp(.74rem,1.9vw,1.35rem);line-height:1.38;padding:.5em .85em;border-radius:14px;background:rgba(6,8,16,.62);backdrop-filter:blur(8px);box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transition:opacity .35s}
.baf-sub.is-on{opacity:1}
.baf-sub b{color:#9ef6ff;font-weight:700}
.baf-ctl{position:absolute;left:12px;bottom:12px;padding:.5em .9em;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(8,10,20,.6);color:#fff;font:inherit;cursor:pointer}
@media (max-width:520px){.baf-sub{bottom:4%;width:94%;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.baf-card small{display:none}}
@media (prefers-reduced-motion: reduce){.baf-layer>div{transform:none!important}}
`;
  document.head.append(s);
}

function makeVoice(lang) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  if (!synth || typeof window.SpeechSynthesisUtterance === "undefined") return null;
  const tag = VOICE_LANG[lang] || "en-US";
  const pickVoice = () => {
    try {
      const vs = synth.getVoices() || [];
      return vs.find((v) => v.lang?.replace("_", "-").toLowerCase() === tag.toLowerCase()) || vs.find((v) => v.lang?.toLowerCase().startsWith(lang)) || null;
    } catch { return null; }
  };
  let token = 0;
  return {
    speak(text, onEnd) {
      const my = ++token;
      const voice = pickVoice();
      try {
        if (!voice && synth.getVoices().length) return false; // no voice for this language: stay silent
        const u = new window.SpeechSynthesisUtterance(text);
        u.lang = tag;
        if (voice) u.voice = voice;
        u.onend = () => { if (my === token) onEnd(); };
        u.onerror = () => { if (my === token) onEnd(); };
        synth.speak(u);
        return true;
      } catch { return false; }
    },
    cancel() { token++; try { synth.cancel(); } catch { /* ignore */ } },
    pause() { try { synth.pause(); } catch { /* ignore */ } },
    resume() { try { synth.resume(); } catch { /* ignore */ } },
  };
}

export function createFilm(container, opts = {}) {
  if (!container || typeof container.appendChild !== "function") throw new TypeError("createFilm(container): a DOM element is required");
  injectCSS();
  const book = opts.book && typeof opts.book === "object" ? opts.book : {};
  const lang = LANGS3.includes(opts.lang) ? opts.lang : LANGS3.includes(book.lang) ? book.lang : "en";
  const L = STR[lang];
  const reduced = prefersReducedMotion();
  const f = book.film && typeof book.film === "object" ? book.film : {};
  const names = new Map((Array.isArray(book.characters) ? book.characters : []).map((c) => [c.id, str(c.name) || c.id]));
  const scenes = (Array.isArray(f.scenes) ? f.scenes : []).filter((s) => s && typeof s === "object").slice(0, 12);
  const nS = scenes.length;
  const cov = book.cover || {};
  const colA = hex(cov.bg, "#1b2a4a"), colB = hex(cov.bg2, "#0e1630"), colC = hex(cov.accent, "#5fe1ff");

  // ---- timeline
  const segs = [];
  const introText = str(f.intro);
  segs.push({ kind: "intro", idx: -1, narr: introText, line: null, base: Math.min(10, Math.max(5.5, introText.length / CPS + 2)) });
  scenes.forEach((sc, i) => {
    const narr = str(sc.narration);
    const line = sc.line && str(sc.line.text) ? { who: names.get(str(sc.line.speaker)) || "", text: str(sc.line.text) } : null;
    const base = Math.max(SCENE_MIN, narr.length / CPS + 1.5 + (line ? line.text.length / CPS + 1 : 0));
    segs.push({ kind: "scene", idx: i, title: str(sc.title), narr, line, base });
  });
  const outroText = str(f.outro);
  segs.push({ kind: "outro", idx: nS, narr: outroText, line: null, base: Math.min(11, Math.max(6, outroText.length / CPS + 2.5)) });
  let total = 0;
  for (const s of segs) { s.start = total; s.dur = s.base; total += s.dur; }

  // ---- DOM
  let madeRel = false;
  try { if (getComputedStyle(container).position === "static") { container.classList.add("baf-host-rel"); madeRel = true; } } catch { /* ignore */ }
  const root = document.createElement("div");
  root.className = "baf-root";
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", str(f.title) || str(book.title) || L.film);
  const paint = document.createElement("div");
  paint.className = "baf-paint";
  paint.innerHTML = "<i></i>";
  const layers = [0, 1].map(() => {
    const d = document.createElement("div");
    d.className = "baf-layer";
    const pic = document.createElement("div");
    d.append(pic);
    return { node: d, pic, url: null };
  });
  const vign = document.createElement("div");
  vign.className = "baf-vign";
  const wait = document.createElement("div");
  wait.className = "baf-wait";
  wait.textContent = L.painting;
  const card = document.createElement("div");
  card.className = "baf-card";
  const sub = document.createElement("div");
  sub.className = "baf-sub";
  sub.setAttribute("aria-live", "polite");
  root.append(paint, layers[0].node, layers[1].node, vign, wait, card, sub);
  let ctlBtn = null;
  if (opts.controls) {
    ctlBtn = document.createElement("button");
    ctlBtn.type = "button";
    ctlBtn.className = "baf-ctl";
    ctlBtn.addEventListener("click", () => (state.playing ? api.pause() : api.play()));
    root.append(ctlBtn);
  }
  container.append(root);

  // ---- frames
  const frameKey = (i, k) => `${i}/${k}`;
  const ready = new Map();   // key → url (loaded)
  const pending = new Map(); // key → promise
  const ctrl = new AbortController();
  let narrEn = [];
  const narrReady = englishNarrations(book).then((list) => { narrEn = list; }).catch(() => {});

  function want(i, k, priority = false) {
    if (i < 0 || i >= nS) return;
    const key = frameKey(i, k);
    if (ready.has(key) || pending.has(key)) return;
    const p = narrReady.then(() => {
      const url = animeFrameUrl(book, i, k, { narrationEn: narrEn[i] || "" });
      return loadAnimeImage(url, { signal: ctrl.signal, priority });
    }).then((url) => { ready.set(key, url); }).catch(() => { /* keep the painted background */ }).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  // first scene first, then the rest in order
  want(0, 0, true); want(0, 1);
  for (let i = 1; i < nS; i++) { want(i, 0); want(i, 1); }

  function setPaint(i) {
    const sc = scenes[i] || {};
    const h = hashStr(`${book.id}/${i}`);
    const ang = h % 360;
    paint.firstChild.style.background =
      `radial-gradient(60% 60% at ${20 + (h % 60)}% ${25 + (h % 40)}%, ${colC}55, transparent 70%),` +
      `linear-gradient(${ang}deg, ${colA}, ${colB})`;
    paint.dataset.mood = str(sc.mood);
  }

  /** Show the picture for (scene i, frame k) on layer `slot` with opacity `a` and Ken Burns progress `p`. */
  function showLayer(slot, i, k, a, p) {
    const lay = layers[slot];
    const url = ready.get(frameKey(i, k)) || (k === 1 ? ready.get(frameKey(i, 0)) : null);
    if (url !== lay.url) {
      lay.url = url;
      lay.pic.style.backgroundImage = url ? `url("${url.replace(/"/g, "%22")}")` : "none";
    }
    lay.node.style.opacity = url ? String(a) : "0";
    if (!reduced && url) {
      const h = hashStr(`${book.id}/${i}/${k}`);
      const dir = h % 4;
      const zoom = 1.04 + 0.12 * p;
      const dx = (dir === 0 ? -1 : dir === 1 ? 1 : 0) * 3 * (p - 0.5);
      const dy = (dir === 2 ? -1 : dir === 3 ? 1 : 0) * 2.4 * (p - 0.5);
      lay.pic.style.transform = `translate3d(${dx}%, ${dy}%, 0) scale(${zoom.toFixed(4)})`;
    }
    return Boolean(url);
  }

  // ---- state + clock
  const state = { t: 0, playing: false, ended: false, seg: -1, raf: 0, last: 0, tts: null, holdUntil: 0 };
  const voice = makeVoice(lang);
  const ttsOn = () => (state.tts != null ? state.tts : Boolean(opts.tts));
  const speech = { seg: -1, done: true };

  function segAt(t) {
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return i;
    return 0;
  }

  function speakSeg(si) {
    speech.seg = si;
    speech.done = true;
    if (!voice || !ttsOn()) return;
    const s = segs[si];
    const text = [s.narr, s.line ? s.line.text : ""].filter(Boolean).join(" ");
    if (!text) return;
    speech.done = !voice.speak(text, () => { if (speech.seg === si) speech.done = true; });
  }

  function render() {
    const t = state.t;
    const si = segAt(t);
    const s = segs[si];
    const local = t - s.start;
    const k = sat(local / s.dur);
    if (si !== state.seg) {
      state.seg = si;
      if (s.kind === "scene") { setPaint(s.idx); want(s.idx, 0, true); want(s.idx, 1, true); }
      if (state.playing) speakSeg(si);
      try { opts.onScene?.(s.kind === "scene" ? s.idx : s.kind === "intro" ? -1 : nS); } catch (err) { console.error(err); }
    }
    let shown = true;
    card.style.opacity = "0";
    if (s.kind === "scene") {
      // frame 0 → cross-fade → frame 1 at ~55% of the scene
      const cut = s.dur * 0.55;
      const fade = smooth((local - cut + FADE / 2) / FADE);
      shown = showLayer(0, s.idx, 0, 1, sat(local / (cut + FADE)));
      showLayer(1, s.idx, 1, fade, sat((local - cut + FADE / 2) / (s.dur - cut + FADE / 2)));
      // scene title for the first 2.2 s
      const tIn = smooth(local / 0.6) * (1 - smooth((local - 2.2) / 0.6));
      if (s.title && tIn > 0.01) {
        card.style.opacity = String(tIn);
        if (card.dataset.key !== `s${s.idx}`) {
          card.dataset.key = `s${s.idx}`;
          card.replaceChildren(el("small", L.scene(s.idx + 1, nS)), el("h3", s.title));
        }
      }
      // subtitles: narration, then the line in the second half
      const lineAt = s.line ? Math.max(2.5, s.narr.length / CPS + 1) : Infinity;
      const subKey = local < lineAt ? `n${si}` : `l${si}`;
      if (sub.dataset.key !== subKey) {
        sub.dataset.key = subKey;
        if (subKey[0] === "n") sub.replaceChildren(document.createTextNode(s.narr));
        else sub.replaceChildren(...(s.line.who ? [el("b", `${s.line.who}: `)] : []), document.createTextNode(`«${s.line.text}»`));
      }
      sub.classList.toggle("is-on", local > 0.8 && local < s.dur - 0.4 && Boolean(sub.textContent));
    } else {
      // intro: first frame under the title; outro: last frame under "The End"
      const sceneIdx = s.kind === "intro" ? 0 : nS - 1;
      if (sceneIdx >= 0) { setPaint(sceneIdx); showLayer(0, sceneIdx, s.kind === "intro" ? 0 : 1, 0.55, k); }
      layers[1].node.style.opacity = "0";
      const a = smooth(local / 0.8) * (1 - smooth((local - s.dur + 0.8) / 0.8));
      card.style.opacity = String(a);
      const key = s.kind;
      if (card.dataset.key !== key) {
        card.dataset.key = key;
        card.replaceChildren(
          ...(s.kind === "intro"
            ? [el("small", L.film), el("h3", str(f.title) || str(book.title)), el("p", str(book.author))]
            : [el("h3", L.end), el("p", str(book.title))]),
        );
      }
      sub.dataset.key = `x${si}`;
      sub.replaceChildren(document.createTextNode(s.narr));
      sub.classList.toggle("is-on", Boolean(s.narr) && local > 1.4 && local < s.dur - 0.4);
      shown = true;
    }
    wait.classList.toggle("is-on", !shown && state.playing);
    if (ctlBtn) ctlBtn.textContent = state.playing ? L.pause : L.play;
  }

  function el(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }

  function tick(now) {
    state.raf = 0;
    if (!state.playing) return;
    const dt = Math.min(0.1, (now - (state.last || now)) / 1000);
    state.last = now;
    const si = segAt(state.t);
    const s = segs[si];
    let next = state.t + dt;
    // hold the end of a segment while the narration voice is still talking (up to SPEECH_CAP)
    if (next >= s.start + s.dur && ttsOn() && !speech.done && speech.seg === si && next < s.start + s.dur + SPEECH_CAP) {
      next = s.start + s.dur - 0.001;
    }
    // hold a scene's start while its first frame is still being drawn (at most 12 s, then go on painted)
    if (s.kind === "scene" && !ready.has(frameKey(s.idx, 0)) && pending.has(frameKey(s.idx, 0)) && next - s.start > 0.5) {
      state.holdUntil ||= now + 12000;
      if (now < state.holdUntil) next = state.t;
    } else state.holdUntil = 0;
    state.t = next;
    if (state.t >= total) {
      state.t = total;
      state.playing = false;
      state.ended = true;
      voice?.cancel();
      render();
      try { opts.onEnd?.(); } catch (err) { console.error(err); }
      return;
    }
    render();
    state.raf = requestAnimationFrame(tick);
  }

  const api = {
    play() {
      if (state.playing) return;
      if (state.ended) { state.t = 0; state.ended = false; state.seg = -1; }
      state.playing = true;
      state.last = 0;
      if (speech.seg === segAt(state.t) && !speech.done) voice?.resume();
      else { render(); speakSeg(segAt(state.t)); }
      state.raf = requestAnimationFrame(tick);
    },
    pause() {
      if (!state.playing) return;
      state.playing = false;
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      voice?.cancel();
      speech.done = true;
      render();
    },
    restart() { this.seek(-1); this.play(); },
    seek(i) {
      const n = Number(i);
      const target = n < 0 ? segs[0] : segs.find((s) => s.kind === "scene" && s.idx === n) || segs[segs.length - 1];
      voice?.cancel();
      speech.done = true;
      state.t = target.start;
      state.ended = false;
      state.seg = -1;
      render();
      if (state.playing) speakSeg(segAt(state.t));
    },
    renderAt(sec) { state.t = Math.max(0, Math.min(total, Number(sec) || 0)); state.seg = -1; render(); },
    setTts(on) { state.tts = Boolean(on); if (!on) { voice?.cancel(); speech.done = true; } },
    dispose() {
      state.playing = false;
      cancelAnimationFrame(state.raf);
      voice?.cancel();
      ctrl.abort();
      root.remove();
      if (madeRel) container.classList.remove("baf-host-rel");
    },
    get playing() { return state.playing; },
    get ended() { return state.ended; },
    get duration() { return total; },
    get time() { return state.t; },
    get scene() { const s = segs[segAt(state.t)]; return s.kind === "scene" ? s.idx : s.kind === "intro" ? -1 : nS; },
    get timeline() { return segs.map((s) => ({ kind: s.kind, index: s.idx, start: s.start, duration: s.dur })); },
    get kind() { return "anime"; },
  };

  setPaint(0);
  render();
  if (opts.autoplay) api.play();
  return api;
}
