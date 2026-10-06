// BookTrip — the 3D perspective ring of book covers on the home screen. Owned by home.
//
//   createRing(container, items, { onOpen(item), reducedMotion }) → { destroy(), shuffle(), setItems(items), flick(), pause(), resume() }
//   items = [{ id, title, author, cover }]
//
// Pure CSS 3D: the camera sits at the centre of a cylinder (perspective === radius) and 37 cards are
// placed tangent to it, so cards curve around the viewer and the outer ones loom larger with slanted
// edges. The parent has `perspective`; cards need no preserve-3d. One rAF loop drives spin, drag
// inertia, flicks, flips and hover; it sleeps while the tab or the ring is not visible.

import { coverSVG, coverFromString } from "./covers.js";
import { seeded, hashStr, prefersReducedMotion } from "./util.js";

const SLOTS = 37;
const STEP = (Math.PI * 2) / SLOTS;
const BASE_W = 150;          // card size and radius at scale 1
const BASE_H = 225;
const BASE_R = 890;
const SPIN = 0.055;          // rad/s idle spin (~2 min per revolution)
const FRICTION = 1.45;       // 1/s, how fast extra velocity decays back to the idle spin
const MAX_OMEGA = 14;
const FLIP_MS = 640;
const ENTER_MS = 560;
const TAP_MS = 450;
const DRAG_SLOP = 6;

let instances = 0;

const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeIn = (t) => t * t * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const n3 = (v) => Math.round(v * 1000) / 1000;

/** Normalise incoming items; tolerate missing fields. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && (it.title || it.id))
    .map((it, i) => {
      const title = String(it.title ?? it.id ?? "");
      return {
        id: String(it.id ?? `item-${i}`),
        title,
        author: String(it.author ?? ""),
        cover: it.cover && typeof it.cover === "object" ? it.cover : coverFromString(title),
        src: it,
      };
    });
}

/**
 * Fill the slots so equal books are as far apart as possible (never neighbours, ring wraps).
 * Returns an array of item indices, one per slot.
 */
function assignSlots(n, seed) {
  if (!n) return [];
  const rnd = seeded(seed);
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const last = new Array(n).fill(-Infinity);
  const first = new Array(n).fill(null);
  const out = [];
  for (let i = 0; i < SLOTS; i++) {
    let best = order[0];
    let bestScore = -Infinity;
    for (const k of order) {
      let gap = i - last[k];
      if (first[k] !== null) gap = Math.min(gap, first[k] + SLOTS - i);
      const score = Math.min(gap, SLOTS) + rnd() * 0.25;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    out.push(best);
    if (first[best] === null) first[best] = i;
    last[best] = i;
  }
  return out;
}

export function createRing(container, items, { onOpen, reducedMotion } = {}) {
  const reduced = reducedMotion ?? prefersReducedMotion();
  const uid = "rg" + (++instances).toString(36);

  let list = cleanItems(items);
  let seed = hashStr(list.map((it) => it.id).join("|")) || 1;
  let assignment = assignSlots(list.length, seed);
  const svgCache = new Map(); // item key → cover SVG with a placeholder id prefix

  // ---------- DOM ----------
  if (!container.hasAttribute("role")) container.setAttribute("role", "group");
  container.classList.add("ring-host");
  const view = document.createElement("div");
  view.className = "ring-view";
  const floor = document.createElement("div");
  floor.className = "ring-floor";
  floor.setAttribute("aria-hidden", "true");
  view.append(floor);
  container.append(view);

  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ring-card";
    el.tabIndex = -1;
    el.dataset.slot = String(i);
    const face = document.createElement("span");
    face.className = "ring-face";
    face.setAttribute("aria-hidden", "true");
    const shine = document.createElement("span");
    shine.className = "ring-shine";
    shine.setAttribute("aria-hidden", "true");
    const shade = document.createElement("span");
    shade.className = "ring-shade";
    shade.setAttribute("aria-hidden", "true");
    el.append(face, shine, shade);
    view.append(el);
    slots.push({
      i, el, face, shine, shade,
      item: -1,          // index into list currently shown
      data: null,        // the original item object (what onOpen receives)
      pending: null,     // item index waiting to be swapped in
      vis: null,         // currently visible?
      anim: null,        // { kind: "flip" | "enter", t0, dir }
      hover: 0,
      ver: 0,
      lastT: "",
      lastShade: -1,
    });
  }

  function coverMarkup(item, slot) {
    const key = item.id + "\u0000" + item.title + "\u0000" + item.author + "\u0000" + JSON.stringify(item.cover);
    let svg = svgCache.get(key);
    if (!svg) {
      svg = coverSVG(item.cover, { title: item.title, author: item.author, w: BASE_W, h: BASE_H, idPrefix: "IDP", decorative: true });
      if (svgCache.size > 120) svgCache.clear();
      svgCache.set(key, svg);
    }
    // ids must be unique per inline copy
    return svg.replace(/IDP-/g, `${uid}s${slot.i}v${++slot.ver}-`);
  }

  function paintSlot(slot, itemIndex) {
    const item = list[itemIndex];
    slot.item = itemIndex;
    slot.pending = null;
    slot.data = item ? item.src : null;
    if (!item) {
      slot.face.innerHTML = "";
      slot.el.removeAttribute("aria-label");
      return;
    }
    slot.face.innerHTML = coverMarkup(item, slot);
    slot.el.setAttribute("aria-label", item.author ? `${item.title} — ${item.author}` : item.title);
  }

  function paintAll() {
    for (const s of slots) paintSlot(s, assignment[s.i] ?? -1);
    view.classList.toggle("is-empty", !list.length);
  }
  paintAll();

  // ---------- geometry ----------
  let W = 0;
  let H = 0;
  let scale = 1;
  let radius = BASE_R;
  let cardW = BASE_W;
  let cardH = BASE_H;
  let edge = 0.7;    // angle where the screen edge is
  let cull = 0.8;    // cards beyond this angle are hidden

  function layout() {
    W = container.clientWidth;
    H = container.clientHeight;
    if (!W || !H) return false;
    // How many cards should span the width: ~3 on a phone, ~8 on a laptop, up to 11 on huge screens.
    const visibleCards = clamp(3.1 + (W - 390) * 0.00486, 2.9, 11);
    const half = (visibleCards * STEP) / 2;
    let rs = W / 2 / Math.tan(half);
    let s = rs / BASE_R;
    s = Math.min(s, (H * 0.8) / BASE_H, 1.45);
    s = Math.max(s, 0.5);
    scale = s;
    radius = BASE_R * s;
    cardW = BASE_W * s;
    cardH = BASE_H * s;
    edge = Math.atan(W / 2 / radius);
    cull = Math.min(edge + Math.atan(cardW / radius) + 0.02, 1.25);

    const top = clamp(H * 0.1, 12, 64);
    const cy = top + cardH / 2;
    const eyeY = cy - cardH * 0.62;
    view.style.perspective = `${n3(radius)}px`;
    view.style.perspectiveOrigin = `${n3(W / 2)}px ${n3(eyeY)}px`;
    view.style.setProperty("--card-w", `${n3(cardW)}px`);
    view.style.setProperty("--card-h", `${n3(cardH)}px`);
    view.style.setProperty("--card-x", `${n3(W / 2 - cardW / 2)}px`);
    view.style.setProperty("--card-y", `${n3(top)}px`);
    view.style.setProperty("--ring-s", n3(s));
    for (const sl of slots) sl.lastT = "";
    return true;
  }

  // ---------- motion state ----------
  let rotation = reduced ? 0 : -0.55;   // entrance: the ring sweeps in
  let omega = reduced ? 0 : 1.9;
  let dir = 1;
  let hoverSlot = -1;
  let hoverK = 0;
  let focusSlot = -1;
  let paused = false;
  let shuffleAt = 0;
  let centerSlot = -1;

  const drag = { id: null, x0: 0, y0: 0, t0: 0, lastX: 0, active: false, onCard: false, samples: [] };
  let suppressClickUntil = 0;

  function thetaOf(i) {
    return wrapPi(i * STEP + rotation);
  }

  function flipAngle(slot, now) {
    const a = slot.anim;
    if (!a) return 0;
    const p = (now - a.t0) / (a.kind === "flip" ? FLIP_MS : ENTER_MS);
    if (p < 0) return 0;
    if (a.kind === "enter") {
      if (p >= 1) { slot.anim = null; return 0; }
      return a.dir * 90 * (1 - easeOut(p));
    }
    // in-place flip: fold to edge-on, swap cover, unfold
    if (p >= 1) { slot.anim = null; return 0; }
    if (p < 0.5) return a.dir * 90 * easeIn(p * 2);
    if (slot.pending !== null) paintSlot(slot, slot.pending);
    return -a.dir * 90 * (1 - easeOut((p - 0.5) * 2));
  }

  function updateCards(now, dt) {
    const lift = 12 * scale;
    let best = -1;
    let bestA = Infinity;
    const settled = Math.abs(omega) < 1.1 && !drag.active;
    for (const slot of slots) {
      const th = thetaOf(slot.i);
      const a = Math.abs(th);
      if (a < bestA) { bestA = a; best = slot.i; }
      const vis = a < cull;

      // Swap pending covers: instantly while hidden (it will unfold when it enters), or in place.
      if (slot.pending !== null && !slot.anim) {
        if (!vis) {
          paintSlot(slot, slot.pending);
          if (!reduced) slot.anim = { kind: "enter-wait", t0: 0, dir: th > 0 ? -1 : 1 };
        } else if (reduced) {
          paintSlot(slot, slot.pending);
        } else if (settled && now - shuffleAt > 260) {
          // a left-to-right wave of flips
          const stagger = ((th / edge + 1) / 2) * 420;
          slot.anim = { kind: "flip", t0: now + clamp(stagger, 0, 520), dir: dir >= 0 ? 1 : -1 };
        }
      }

      if (vis !== slot.vis) {
        slot.vis = vis;
        slot.el.style.visibility = vis ? "" : "hidden";
        if (vis && slot.anim && slot.anim.kind === "enter-wait") slot.anim = { kind: "enter", t0: now, dir: th > 0 ? 1 : -1 };
        slot.lastT = "";
      }
      if (!vis) continue;

      const target = slot.i === hoverSlot && drag.id === null ? 1 : 0;
      slot.hover += (target - slot.hover) * (1 - Math.exp(-dt * 14));
      if (slot.hover < 0.002) slot.hover = 0;
      const flip = slot.anim && slot.anim.kind !== "enter-wait" ? flipAngle(slot, now) : 0;
      const hk = slot.hover;

      const t = `translateZ(${n3(radius)}px) rotateY(${n3(-th)}rad) translateZ(${n3(-radius)}px)`
        + (hk ? ` translateY(${n3(-lift * hk)}px) scale(${n3(1 + 0.035 * hk)})` : "")
        + (flip ? ` rotateY(${n3(flip)}deg)` : "");
      if (t !== slot.lastT) {
        slot.el.style.transform = t;
        slot.lastT = t;
        const edgeK = smooth(0.18, 1.02, a / edge);
        const shade = clamp(0.06 + 0.7 * edgeK + 0.45 * Math.abs(Math.sin((flip * Math.PI) / 180)) - 0.12 * hk, 0, 0.92);
        if (Math.abs(shade - slot.lastShade) > 0.004) {
          slot.shade.style.opacity = n3(shade);
          slot.lastShade = shade;
        }
        slot.shine.style.transform = `translateX(${n3(clamp(th / edge, -1.3, 1.3) * -55)}%)`;
      }
    }
    // Roving tabindex: the card nearest the centre is the ring's single tab stop.
    if (focusSlot < 0 && best !== centerSlot && best >= 0) {
      if (centerSlot >= 0) slots[centerSlot].el.tabIndex = -1;
      slots[best].el.tabIndex = 0;
      centerSlot = best;
    }
  }

  // ---------- loop ----------
  let raf = 0;
  let last = 0;
  let inView = true;
  let destroyed = false;

  function frame(now) {
    raf = 0;
    if (destroyed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;

    hoverK += ((hoverSlot >= 0 ? 1 : 0) - hoverK) * (1 - Math.exp(-dt * 5));
    if (drag.active) {
      // rotation follows the pointer (set in pointermove)
    } else if (focusSlot >= 0) {
      const diff = wrapPi(-focusSlot * STEP - rotation);
      rotation += reduced ? diff : diff * (1 - Math.exp(-dt * 9));
      omega = 0;
    } else {
      const base = reduced || paused ? 0 : dir * SPIN * (1 - hoverK);
      const k = reduced ? 6 : FRICTION;
      omega = base + (omega - base) * Math.exp(-k * dt);
      rotation += omega * dt;
    }
    rotation = wrapPi(rotation);
    updateCards(now, dt);
    schedule();
  }

  function schedule() {
    if (raf || destroyed || !inView || document.hidden) return;
    raf = requestAnimationFrame(frame);
  }

  function wake() {
    last = 0;
    schedule();
  }

  function onVisibility() {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else wake();
  }

  // ---------- input ----------
  function slotFromEvent(e) {
    const el = e.target && e.target.closest ? e.target.closest(".ring-card") : null;
    return el && view.contains(el) ? slots[Number(el.dataset.slot)] : null;
  }

  function onPointerDown(e) {
    if (drag.id !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.id = e.pointerId;
    drag.x0 = drag.lastX = e.clientX;
    drag.y0 = e.clientY;
    drag.t0 = performance.now();
    drag.active = false;
    drag.onCard = !!slotFromEvent(e);
    drag.samples = [{ t: drag.t0, r: rotation }];
  }

  function onPointerMove(e) {
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < DRAG_SLOP) {
        if (Math.abs(dy) > 12 && e.pointerType !== "mouse") drag.id = null; // let the page scroll
        return;
      }
      drag.active = true;
      focusSlot = -1;
      try { view.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      view.classList.add("is-dragging");
    }
    const now = performance.now();
    rotation = wrapPi(rotation + (e.clientX - drag.lastX) / radius);
    drag.lastX = e.clientX;
    drag.samples.push({ t: now, r: rotation });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 90) drag.samples.shift();
    omega = 0;
    schedule();
  }

  function endDrag(e, cancelled) {
    if (e.pointerId !== drag.id) return;
    const now = performance.now();
    if (drag.active) {
      const s0 = drag.samples[0];
      const span = (now - s0.t) / 1000;
      if (!cancelled && span > 0.008) {
        const v = wrapPi(rotation - s0.r) / span;
        omega = clamp(v, -MAX_OMEGA, MAX_OMEGA);
        if (Math.abs(omega) > 0.25) dir = Math.sign(omega);
      }
      suppressClickUntil = now + 80;
      view.classList.remove("is-dragging");
      try { view.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    } else if (!cancelled && !drag.onCard && now - drag.t0 < TAP_MS) {
      flick();
    }
    drag.id = null;
    drag.active = false;
    schedule();
  }
  const onPointerUp = (e) => endDrag(e, false);
  const onPointerCancel = (e) => endDrag(e, true);

  function onClick(e) {
    const slot = slotFromEvent(e);
    if (!slot) return;
    if (performance.now() < suppressClickUntil) {
      e.preventDefault();
      return;
    }
    if (slot.data && typeof onOpen === "function") onOpen(slot.data);
  }

  function onWheel(e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 1) return;
    e.preventDefault();
    focusSlot = -1;
    const px = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    rotation = wrapPi(rotation - px / radius);
    omega = dir * SPIN * (1 - hoverK);
    schedule();
  }

  function onPointerOver(e) {
    if (e.pointerType !== "mouse") return;
    const slot = slotFromEvent(e);
    hoverSlot = slot && slot.vis ? slot.i : -1;
    schedule();
  }
  function onPointerLeave() {
    hoverSlot = -1;
    schedule();
  }

  function onFocusIn(e) {
    const slot = slotFromEvent(e);
    if (!slot) return;
    // Keyboard focus brings the card to the centre and holds the ring still; a mouse click does not.
    let keyboard = true;
    try { keyboard = slot.el.matches(":focus-visible"); } catch { /* old browsers */ }
    if (!keyboard) return;
    focusSlot = slot.i;
    for (const s of slots) s.el.tabIndex = s === slot ? 0 : -1;
    centerSlot = slot.i;
    schedule();
  }
  function onFocusOut(e) {
    if (e.relatedTarget && view.contains(e.relatedTarget)) return;
    focusSlot = -1;
    schedule();
  }

  function onKeyDown(e) {
    const slot = slotFromEvent(e);
    if (!slot) return;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (slot.i + 1) % SLOTS;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (slot.i - 1 + SLOTS) % SLOTS;
    if (next === null) return;
    e.preventDefault();
    slots[next].el.focus({ preventScroll: true });
  }

  view.addEventListener("pointerdown", onPointerDown);
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerCancel);
  view.addEventListener("click", onClick);
  view.addEventListener("wheel", onWheel, { passive: false });
  view.addEventListener("pointerover", onPointerOver);
  view.addEventListener("pointerleave", onPointerLeave);
  view.addEventListener("focusin", onFocusIn);
  view.addEventListener("focusout", onFocusOut);
  view.addEventListener("keydown", onKeyDown);
  view.addEventListener("dragstart", (e) => e.preventDefault());
  document.addEventListener("visibilitychange", onVisibility);

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (layout()) wake(); }) : null;
  if (ro) ro.observe(container);
  else window.addEventListener("resize", layout);

  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      if (inView) wake();
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    })
    : null;
  if (io) io.observe(container);

  // ---------- public actions ----------
  function reshuffle() {
    if (!list.length) return;
    seed = (seed * 1103515245 + 12345) >>> 0 || 7;
    assignment = assignSlots(list.length, seed);
    shuffleAt = performance.now();
    for (const s of slots) {
      const next = assignment[s.i];
      s.pending = next === s.item ? null : next;
    }
    schedule();
  }

  function flick() {
    if (!list.length) return;
    focusSlot = -1;
    if (!reduced) {
      const rnd = Math.random();
      const sign = rnd < 0.5 ? -1 : 1;
      omega = sign * (7.2 + Math.random() * 2.6);
      dir = sign;
    }
    reshuffle();
  }

  function setItems(nextItems) {
    const next = cleanItems(nextItems);
    const sameSet = next.length === list.length && next.every((it) => list.some((o) => o.id === it.id));
    if (sameSet) {
      // Same books (e.g. a language switch): keep slot positions, refresh titles/covers in place.
      const byId = new Map(next.map((it, i) => [it.id, i]));
      const remap = list.map((o) => byId.get(o.id));
      list = next;
      assignment = assignment.map((k) => remap[k]);
      for (const s of slots) {
        const k = s.item >= 0 ? remap[s.item] : -1;
        if (s.pending !== null) s.pending = remap[s.pending];
        paintSlot(s, k);
      }
      return;
    }
    const wasEmpty = !list.length;
    list = next;
    if (wasEmpty) {
      assignment = assignSlots(list.length, seed);
      paintAll();
      schedule();
      return;
    }
    for (const s of slots) s.item = -1; // old indices are meaningless now
    reshuffle();
    if (!list.length) paintAll();
  }

  layout();
  requestAnimationFrame(() => view.classList.add("is-in"));
  wake();

  return {
    shuffle: reshuffle,
    flick,
    setItems,
    pause() { paused = true; },
    resume() { paused = false; wake(); },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", layout);
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      view.remove();
      container.classList.remove("ring-host");
    },
  };
}
