// BookTrip — subtle twinkling starfield on the fixed #starfield canvas. Owned by home.
//
//   startStars(canvas) → { stop() }
//
// Two parallax layers of tiny stars drifting very slowly, plus a handful of bright stars with a
// soft glow. DPR-aware, ~30 fps, pauses while the tab is hidden, static under reduced motion.

import { seeded, prefersReducedMotion } from "./util.js";

const FAR_DENSITY = 1 / 4200;   // stars per CSS px²
const NEAR_DENSITY = 1 / 26000;
const BRIGHT_DENSITY = 1 / 190000;
const FRAME_MS = 40; // ~25 fps is plenty for slow twinkle and drift

const TINTS = ["#ffffff", "#dfeaff", "#cfe0ff", "#bfe9ff", "#fff3dc"];

function glowSprite(color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.12, color);
  grad.addColorStop(0.35, color.replace(/[\d.]+\)$/, "0.22)"));
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // faint diffraction cross
  g.globalCompositeOperation = "lighter";
  g.fillStyle = color.replace(/[\d.]+\)$/, "0.35)");
  g.fillRect(r - 0.5, r * 0.25, 1, r * 1.5);
  g.fillRect(r * 0.25, r - 0.5, r * 1.5, 1);
  return c;
}

export function startStars(canvas) {
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) return { stop() {} };

  const reduced = prefersReducedMotion();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let stars = [];
  let raf = 0;
  let last = 0;
  let t = 0;           // seconds of animated time (does not advance while hidden)
  let stopped = false;
  const sprites = [glowSprite("rgba(170,225,255,0.9)", 48), glowSprite("rgba(255,236,200,0.9)", 48)];

  function build() {
    const rnd = seeded(20251006);
    const area = w * h;
    const make = (count, layer) => {
      for (let i = 0; i < count; i++) {
        const near = layer === 1;
        const bright = layer === 2;
        stars.push({
          x: rnd() * w,
          y: rnd() * h,
          r: bright ? 0.9 + rnd() * 0.7 : near ? 0.7 + rnd() * 0.6 : 0.35 + rnd() * rnd() * 0.65,
          a: bright ? 0.75 + rnd() * 0.25 : near ? 0.45 + rnd() * 0.4 : 0.18 + rnd() * 0.45,
          tw: 0.25 + rnd() * 1.1,            // twinkle speed (rad/s)
          ph: rnd() * Math.PI * 2,
          depth: (bright ? 0.6 : near ? 1 : 0.35) * (0.8 + rnd() * 0.4),
          tint: TINTS[Math.floor(rnd() * TINTS.length)],
          sprite: sprites[rnd() < 0.7 ? 0 : 1],
          layer,
        });
      }
    };
    stars = [];
    make(Math.round(area * FAR_DENSITY), 0);
    make(Math.round(area * NEAR_DENSITY), 1);
    make(Math.max(3, Math.round(area * BRIGHT_DENSITY)), 2);
  }

  function resize() {
    const nw = Math.max(1, canvas.clientWidth || window.innerWidth);
    const nh = Math.max(1, canvas.clientHeight || window.innerHeight);
    const nd = Math.min(2, window.devicePixelRatio || 1);
    // Mobile URL-bar resizes only change the height a little: keep the same stars then.
    const rebuild = !stars.length || Math.abs(nw - w) > 2 || Math.abs(nh - h) > 160;
    w = nw;
    h = nh;
    dpr = nd;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (rebuild) build();
    draw();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const driftX = -2.2; // px/s for the nearest layer
    const driftY = -0.6;
    for (const s of stars) {
      let x = (s.x + driftX * s.depth * t) % w;
      let y = (s.y + driftY * s.depth * t) % h;
      if (x < 0) x += w;
      if (y < 0) y += h;
      const tw = reduced ? 1 : 0.62 + 0.38 * Math.sin(s.ph + t * s.tw);
      const alpha = s.a * tw;
      if (s.layer === 2) {
        const size = (9 + s.r * 7) * (0.85 + 0.15 * tw);
        ctx.globalAlpha = alpha * 0.85;
        ctx.drawImage(s.sprite, x - size / 2, y - size / 2, size, size);
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.tint;
        if (s.r < 0.7) ctx.fillRect(x - s.r, y - s.r, s.r * 2, s.r * 2);
        else {
          ctx.beginPath();
          ctx.arc(x, y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    raf = 0;
    if (stopped || document.hidden) return;
    if (!last) last = now;
    const dt = now - last;
    if (dt >= FRAME_MS) {
      t += Math.min(dt, 100) / 1000;
      last = now;
      draw();
    }
    raf = requestAnimationFrame(frame);
  }

  function play() {
    if (reduced || stopped || raf || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function onVisibility() {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else play();
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }

  resize();
  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisibility);
  play();

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
