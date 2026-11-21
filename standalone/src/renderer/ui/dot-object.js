/**
 * omni-design: a 3D object drawn in dots (Canvas 2D, no library).
 *
 * New in this skill, built to the rules of the two places the language
 * already does depth: the OmniFile dot layer (dots.js: quantised opacity,
 * batched fills, a motion budget, still under reduced motion) and the
 * BambuMate model viewport (a point cloud in theme greys, alpha fading with
 * depth, drawn only when something changes, drag and keys to orbit, no
 * auto-spin, one signal colour for the one thing that matters).
 *
 *   <div class="dotobject-stage">
 *     <canvas class="dotobject" aria-label="Three stacked layers"></canvas>
 *   </div>
 *   <script type="module">
 *     import { mountDotObject } from "./dot-object.js";
 *     mountDotObject(document.querySelector(".dotobject"), { shape: "planes", signalAt: [0.8, -0.6, 0.8] });
 *   </script>
 *
 * Motion: on mount the object turns in once and its dots assemble (like a
 * dot glyph), then it rests. The pointer leans it a few degrees (parallax).
 * Drag or arrow keys orbit it; 0 resets. Nothing loops. Under
 * prefers-reduced-motion: no entrance, no lean; drag and keys still work,
 * because the person moves it. Stops when hidden or scrolled away.
 */

const STEPS = 8;
const TAU = Math.PI * 2;
const ENTER_MS = 1100;
const ASSEMBLE_MS = 700;
const LEAN_YAW = 0.18; // rad, at the canvas edge
const LEAN_PITCH = 0.12;
const PITCH_MAX = 1.2;
const CAMERA = 3.4; // camera distance, in object radii

function media(win, q) {
  try {
    return "matchMedia" in win ? win.matchMedia(q) : null;
  } catch {
    return null;
  }
}
const reduced = (win) => media(win, "(prefers-reduced-motion: reduce)")?.matches ?? false;
function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/** Close to --ease-enter, cubic-bezier(0.16, 0.84, 0.3, 1): fast out, long settle. */
const easeEnter = (t) => 1 - (1 - t) ** 4;

/* ---------- shapes: unit radius, deterministic ---------- */

export function sphere(n = 900) {
  const out = new Float32Array(n * 3);
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.set([Math.cos(g * i) * r, y, Math.sin(g * i) * r], i * 3);
  }
  return out;
}

/** A cube as a dot lattice on its six faces (m x m per face). */
export function cube(m = 11) {
  const pts = [];
  const s = 0.62;
  for (let a = 0; a < m; a++)
    for (let b = 0; b < m; b++) {
      const u = (a / (m - 1)) * 2 - 1;
      const v = (b / (m - 1)) * 2 - 1;
      for (const f of [-1, 1]) pts.push([f, u, v], [u, f, v], [u, v, f]);
    }
  const seen = new Set();
  const out = [];
  for (const [x, y, z] of pts) {
    const k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!seen.has(k)) seen.add(k), out.push(x * s, y * s, z * s);
  }
  return new Float32Array(out);
}

export function torus(nu = 48, nv = 16, R = 0.68, r = 0.26) {
  const out = new Float32Array(nu * nv * 3);
  let i = 0;
  for (let a = 0; a < nu; a++)
    for (let b = 0; b < nv; b++) {
      const u = (a / nu) * TAU;
      const v = (b / nv) * TAU;
      out[i++] = (R + r * Math.cos(v)) * Math.cos(u);
      out[i++] = r * Math.sin(v);
      out[i++] = (R + r * Math.cos(v)) * Math.sin(u);
    }
  return out;
}

/** Stacked square planes of dots: layers, tiers, a diagram's z-order. */
export function planes(layers = 3, m = 13, gap = 0.55) {
  const out = [];
  const s = 0.72;
  for (let l = 0; l < layers; l++) {
    const y = (l - (layers - 1) / 2) * gap;
    for (let a = 0; a < m; a++)
      for (let b = 0; b < m; b++)
        out.push(((a / (m - 1)) * 2 - 1) * s, y, ((b / (m - 1)) * 2 - 1) * s);
  }
  return new Float32Array(out);
}

const SHAPES = { sphere, cube, torus, planes };

/* ---------- the renderer ---------- */

export class DotObject {
  constructor(canvas, ctx, opts = {}, win = window) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.win = win;
    this.opts = { dot: 2.2, yaw: 0.65, pitch: 0.42, scale: 0.38, entrance: true, ...opts };
    const shape = this.opts.shape ?? "sphere";
    this.pts = shape instanceof Float32Array ? shape : SHAPES[shape]();
    this.n = this.pts.length / 3;
    this.seeds = Float32Array.from({ length: this.n }, (_, i) => hash(i));
    this.level = new Uint8Array(this.n);
    this.sx = new Float32Array(this.n);
    this.sy = new Float32Array(this.n);
    this.still = reduced(win);
    this.yaw = this.opts.yaw; // where the person put it
    this.pitch = this.opts.pitch;
    this.lean = { x: 0, y: 0, tx: 0, ty: 0 }; // pointer parallax, eased
    this.born = this.opts.entrance && !this.still ? win.performance.now() : -Infinity;
    this.colours = { ink: "#141414", signal: "#d71921" };
    this.w = this.h = 0;
    this.dpr = 1;
    this.raf = 0;
    this.last = 0;
    this.visible = true;
    this.onScreen = true;
    this.tick = this.tick.bind(this);
  }

  readColours() {
    const css = this.win.getComputedStyle(this.canvas);
    const get = (k, f) => css.getPropertyValue(k).trim() || f;
    this.colours = { ink: get("--ink", this.colours.ink), signal: get("--signal", this.colours.signal) };
    this.wake();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, this.win.devicePixelRatio || 1);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    Object.assign(this, { w, h, dpr });
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.wake();
  }

  setReducedMotion(still) {
    this.still = still;
    if (still) {
      this.born = -Infinity;
      this.lean = { x: 0, y: 0, tx: 0, ty: 0 };
    }
    this.wake();
  }

  /** Pointer in client coords (null = left): leans the object a few degrees. */
  point(cx, cy) {
    if (this.still) return;
    if (cx === null) {
      this.lean.tx = this.lean.ty = 0;
    } else {
      const r = this.canvas.getBoundingClientRect();
      this.lean.tx = Math.max(-1, Math.min(1, ((cx - r.left) / r.width) * 2 - 1));
      this.lean.ty = Math.max(-1, Math.min(1, ((cy - r.top) / r.height) * 2 - 1));
    }
    this.wake();
  }

  /** Orbit by a delta (drag, keys). Pitch is clamped; yaw wraps. */
  orbit(dYaw, dPitch) {
    this.yaw = (this.yaw + dYaw) % TAU;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch + dPitch));
    this.canvas.dataset.yaw = this.yaw.toFixed(3);
    this.wake();
  }

  reset() {
    this.yaw = this.opts.yaw;
    this.pitch = this.opts.pitch;
    this.wake();
  }

  busy(t) {
    if (t - this.born < ENTER_MS + 200) return true;
    const l = this.lean;
    return Math.abs(l.tx - l.x) > 0.002 || Math.abs(l.ty - l.y) > 0.002;
  }

  wake() {
    if (this.raf || !this.visible || !this.onScreen || !this.w || !this.h) {
      if (this.raf && (!this.visible || !this.onScreen)) this.stop();
      return;
    }
    this.raf = this.win.requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  tick(t) {
    this.raf = 0;
    if (!this.visible || !this.onScreen) return;
    const dt = Math.min(64, t - (this.last || t));
    this.last = t;
    const k = 1 - Math.exp(-dt / 120); // lean settles in ~360 ms
    this.lean.x += (this.lean.tx - this.lean.x) * k;
    this.lean.y += (this.lean.ty - this.lean.y) * k;
    this.draw(this.win.performance.now());
    if (this.busy(this.win.performance.now())) this.raf = this.win.requestAnimationFrame(this.tick);
    else this.last = 0;
  }

  draw(t) {
    const { ctx, pts, n, seeds, level, sx, sy, w, h } = this;
    const age = t - this.born;
    const e = easeEnter(Math.min(1, Math.max(0, age / ENTER_MS)));
    const yaw = this.yaw - (1 - e) * 1.1 + this.lean.x * LEAN_YAW;
    const pitch = this.pitch + (1 - e) * 0.25 + this.lean.y * LEAN_PITCH;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const R = Math.min(w, h) * this.opts.scale * 2;
    const cx = w / 2, cy = h / 2;
    const project = (x, y, z) => {
      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp; // toward the viewer: +1 near, -1 far
      const s = (CAMERA - 1) / (CAMERA - z2);
      return [cx + x1 * s * R, cy - y2 * s * R, z2];
    };
    for (let i = 0; i < n; i++) {
      const [px, py, d] = project(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      const near = (d + 1) / 2;
      const appear = Math.min(1, Math.max(0, (age - seeds[i] * ASSEMBLE_MS) / 260));
      const a = appear * (0.14 + 0.86 * near ** 1.4);
      level[i] = Math.max(0, Math.min(STEPS, Math.round(a * STEPS)));
      sx[i] = px;
      sy[i] = py;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.colours.ink;
    for (let step = 1; step <= STEPS; step++) {
      const rad = (this.opts.dot / 2) * (0.7 + (0.6 * step) / STEPS); // nearer = bigger
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (level[i] !== step) continue;
        ctx.moveTo(sx[i] + rad, sy[i]);
        ctx.arc(sx[i], sy[i], rad, 0, TAU);
        any = true;
      }
      if (any) {
        ctx.globalAlpha = step / STEPS;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (this.opts.signalAt && e > 0.6) {
      const [px, py] = project(...this.opts.signalAt);
      ctx.fillStyle = this.colours.signal;
      ctx.beginPath();
      ctx.arc(px, py, this.opts.dot * 1.6, 0, TAU);
      ctx.fill();
    }
  }
}

/**
 * Mount on a <canvas class="dotobject">. Give it an aria-label (it is the
 * figure's text alternative) or it is aria-hidden as decoration. With
 * `interactive` (default true) it is focusable: arrows orbit, 0 resets.
 * Returns { object, destroy } or null without a 2D canvas.
 */
export function mountDotObject(canvas, opts = {}) {
  const win = canvas?.ownerDocument.defaultView;
  const ctx = canvas?.getContext?.("2d");
  if (!win || !ctx) return null;
  const interactive = opts.interactive ?? true;
  const o = new DotObject(canvas, ctx, opts, win);
  if (canvas.getAttribute("aria-label")) canvas.setAttribute("role", "img");
  else canvas.setAttribute("aria-hidden", "true");
  if (interactive) canvas.tabIndex = 0;
  o.readColours();
  o.resize();
  const off = [];
  const on = (el, ev, fn, opt) => {
    el?.addEventListener(ev, fn, opt);
    off.push(() => el?.removeEventListener(ev, fn, opt));
  };
  on(win.document, "visibilitychange", () => {
    o.visible = win.document.visibilityState !== "hidden";
    o.wake();
  });
  const motion = media(win, "(prefers-reduced-motion: reduce)");
  on(motion, "change", () => o.setReducedMotion(reduced(win)));
  on(media(win, "(prefers-color-scheme: dark)"), "change", () => o.readColours());
  const mo = new MutationObserver(() => o.readColours());
  mo.observe(win.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const ro = new ResizeObserver(() => o.resize());
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => {
    for (const en of es) (o.onScreen = en.isIntersecting), o.wake();
  });
  io.observe(canvas);
  off.push(() => (mo.disconnect(), ro.disconnect(), io.disconnect()));

  const host = canvas.parentElement ?? canvas;
  let drag = null;
  on(host, "pointermove", (ev) => {
    if (ev.pointerType !== "touch" && !drag) o.point(ev.clientX, ev.clientY);
  }, { passive: true });
  on(host, "pointerleave", () => o.point(null), { passive: true });
  if (interactive) {
    on(canvas, "pointerdown", (ev) => {
      drag = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
    });
    on(canvas, "pointermove", (ev) => {
      if (!drag) return;
      o.orbit((ev.clientX - drag.x) * 0.008, (ev.clientY - drag.y) * 0.008);
      drag = { x: ev.clientX, y: ev.clientY };
    });
    on(canvas, "pointerup", () => (drag = null));
    on(canvas, "pointercancel", () => (drag = null));
    on(canvas, "keydown", (ev) => {
      const step = 0.12;
      const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (keys[ev.key]) o.orbit(...keys[ev.key]);
      else if (ev.key === "0") o.reset();
      else return;
      ev.preventDefault();
    });
  }
  return {
    object: o,
    destroy: () => {
      for (const f of off) f();
      o.stop();
    },
  };
}
