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
 * dot glyph), then it rests. The pointer leans it a few degrees (parallax)
 * and the dots near it brighten and lean away, like the dot field's.
 * Drag or arrow keys orbit it; 0 resets. Under prefers-reduced-motion: no
 * entrance, no lean, no morphing; drag and keys still work, because the
 * person moves it. Stops when hidden or scrolled away.
 *
 * OmniDraw's addition: `morph: ["planes", "face", "tetrahedron", …]` makes the
 * object a shape-shifter. It holds each shape for a few seconds, then every dot
 * travels to its place in the next one (staggered, with a little swirl), and it
 * sways slowly so each shape reads as 3D. At most ~30 frames a second.
 */

const STEPS = 8;
const TAU = Math.PI * 2;
const ENTER_MS = 1100;
const ASSEMBLE_MS = 700;
const LEAN_YAW = 0.18; // rad, at the canvas edge
const LEAN_PITCH = 0.12;
const PITCH_MAX = 1.2;
const CAMERA = 3.4; // camera distance, in object radii
const FRAME_MS = 33; // while it morphs or sways
const POINTER_R = 84; // the same reach as the dot field's pointer
const SWAY = 0.42; // rad each way
const SWAY_MS = 9000;

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
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

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

/* ---------- more shapes (OmniDraw): each a list of [x, y, z], unit radius ---------- */

/** A head with a face on it: eyes, brows, a nose that stands out and a smile, facing +z. */
export function face() {
  const out = [];
  const A = 0.6, B = 0.78, C = 0.62; // half width, height, depth of the head
  const on = (x, y, lift = 1) => {
    // the point of the head's front surface over (x, y), pushed out by `lift`
    const q = 1 - (x / A) ** 2 - (y / B) ** 2;
    return [x * lift, y * lift, Math.sqrt(Math.max(0, q)) * C * lift];
  };
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 250; i++) {
    const y = 1 - (2 * (i + 0.5)) / 250, r = Math.sqrt(1 - y * y);
    out.push([Math.cos(g * i) * r * A, y * B, Math.sin(g * i) * r * C]);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 44; i++) {
      // an eye: a small filled disc
      const rr = 0.085 * Math.sqrt((i + 0.5) / 44), a = g * i;
      out.push(on(side * 0.23 + Math.cos(a) * rr * 1.25, 0.2 + Math.sin(a) * rr, 1.05));
    }
    for (let i = 0; i < 20; i++) out.push(on(side * (0.11 + 0.24 * (i / 19)), 0.37 + 0.035 * Math.sin((i / 19) * Math.PI), 1.05)); // a brow
  }
  for (let i = 0; i < 26; i++) {
    // the nose: a ridge that stands out from the face
    const t = i / 25, p = on(0, 0.14 - t * 0.3);
    out.push([p[0], p[1], p[2] + 0.04 + 0.12 * Math.sin(t * Math.PI * 0.85)]);
  }
  for (let row = 0; row < 2; row++)
    for (let i = 0; i < 37; i++) {
      // the smile
      const t = i / 36, x = (t * 2 - 1) * 0.3;
      out.push(on(x, -0.36 - row * 0.03 + 0.11 * (x / 0.3) ** 2, 1.05));
    }
  return out;
}

/** A tetrahedron: dots along its six edges and across its four faces. */
export function tetrahedron(m = 12) {
  const s = 0.95;
  const V = [[0, 1, 0], [Math.sqrt(8 / 9), -1 / 3, 0], [-Math.sqrt(2 / 9), -1 / 3, Math.sqrt(2 / 3)], [-Math.sqrt(2 / 9), -1 / 3, -Math.sqrt(2 / 3)]].map((v) => v.map((c) => c * s));
  const mix = (a, b, c, u, v) => [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u + (c[k] - a[k]) * v);
  const out = [];
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]])
    for (let i = 0; i <= m; i++) for (let j = 0; j <= m - i; j++) out.push(mix(V[a], V[b], V[c], i / m, j / m));
  for (const [a, b] of [[0, 1], [0, 2], [0, 3], [1, 2], [2, 3], [3, 1]])
    for (let i = 0; i <= 26; i++) out.push(mix(V[a], V[b], V[b], i / 26, 0));
  return out;
}

/** A spiral rising like a spring that opens out toward the top. */
export function spiral(n = 520, turns = 5.5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1), a = u * turns * TAU, r = 0.12 + 0.72 * u;
    out.push([Math.cos(a) * r, (u - 0.5) * 1.5, Math.sin(a) * r]);
  }
  return out;
}

/** A spiral galaxy: a bright bulge and two arms of scattered stars in a thin disc. */
export function galaxy(n = 520) {
  const out = [];
  const bulge = Math.round(n * 0.2);
  for (let i = 0; i < bulge; i++) {
    const r = 0.2 * Math.cbrt(hash(i * 3 + 1)), a = hash(i * 3 + 2) * TAU, b = Math.acos(2 * hash(i * 3 + 3) - 1);
    out.push([r * Math.sin(b) * Math.cos(a), r * Math.cos(b) * 0.6, r * Math.sin(b) * Math.sin(a)]);
  }
  for (let i = bulge; i < n; i++) {
    const u = (i - bulge) / (n - bulge), arm = i % 2;
    const r = 0.16 + 0.8 * u ** 0.8;
    const a = arm * Math.PI + r * 5.2 + (hash(i * 7 + 5) - 0.5) * (0.55 - 0.3 * u);
    const rr = r + (hash(i * 7 + 6) - 0.5) * 0.09;
    out.push([Math.cos(a) * rr, (hash(i * 7 + 8) - 0.5) * 0.07 * (1.2 - u), Math.sin(a) * rr]);
  }
  return out;
}

/** A ringed planet. */
export function saturn() {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 290; i++) {
    const y = 1 - (2 * (i + 0.5)) / 290, r = Math.sqrt(1 - y * y);
    out.push([Math.cos(g * i) * r * 0.46, y * 0.46, Math.sin(g * i) * r * 0.46]);
  }
  for (let ring = 0; ring < 3; ring++)
    for (let i = 0; i < 76; i++) {
      const a = (i / 76) * TAU + ring * 0.04, r = 0.68 + ring * 0.09;
      out.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
    }
  return out;
}

/** A double helix with rungs. */
export function helix(turns = 2.4) {
  const out = [];
  for (let i = 0; i < 150; i++) {
    const u = i / 149, a = u * turns * TAU, y = (u - 0.5) * 1.7;
    for (const side of [0, Math.PI]) out.push([Math.cos(a + side) * 0.42, y, Math.sin(a + side) * 0.42]);
    if (i % 6 === 0) for (let k = 1; k < 9; k++) out.push([Math.cos(a) * 0.42 * (1 - (2 * k) / 9), y, Math.sin(a) * 0.42 * (1 - (2 * k) / 9)]);
  }
  return out;
}

/** A heart with some depth to it. */
export function heart() {
  const out = [];
  const layers = 9;
  for (let l = 0; l < layers; l++) {
    const z = (l / (layers - 1)) * 2 - 1, k = Math.sqrt(1 - z * z * 0.92);
    const count = Math.max(10, Math.round(72 * k));
    for (let i = 0; i < count; i++) {
      const t = (i / count) * TAU;
      const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      out.push([(x / 18) * k * 0.9, (y / 18 + 0.1) * k * 0.9, z * 0.3]);
    }
  }
  return out;
}

/** A sheet with a ripple running out from its middle. */
export function wave(m = 23) {
  const out = [];
  for (let a = 0; a < m; a++)
    for (let b = 0; b < m; b++) {
      const x = ((a / (m - 1)) * 2 - 1) * 0.82, z = ((b / (m - 1)) * 2 - 1) * 0.82, r = Math.hypot(x, z);
      out.push([x, 0.2 * Math.cos(r * 9) * (1 - r * 0.6), z]);
    }
  return out;
}

const triples = (flat) => Array.from({ length: flat.length / 3 }, (_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]);

/**
 * A shape as exactly `n` dots, in an order that keeps a morph tidy: top to bottom, and
 * around the vertical axis within each band, so a dot's place in one shape is near its
 * place in the next. Shapes with more dots are thinned evenly; with fewer, some are doubled.
 */
export function fitShape(points, n) {
  const sorted = points.slice().sort((p, q) => Math.round((q[1] - p[1]) * 9) || Math.atan2(p[2], p[0]) - Math.atan2(q[2], q[0]));
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / n) * sorted.length))], i * 3);
  return out;
}

const SHAPES = { sphere, cube, torus, planes };
/** Shapes to morph through: their dots, and the angle each is best seen from. */
const MORPHS = {
  planes: { make: () => triples(planes()), yaw: 0.65, pitch: 0.42 },
  face: { make: face, yaw: 0.3, pitch: 0.06 },
  tetrahedron: { make: tetrahedron, yaw: 0.5, pitch: 0.3 },
  spiral: { make: spiral, yaw: 0.4, pitch: 0.3 },
  galaxy: { make: galaxy, yaw: 0.3, pitch: 0.85 },
  saturn: { make: saturn, yaw: 0.4, pitch: 0.36 },
  helix: { make: helix, yaw: 0.3, pitch: 0.12 },
  heart: { make: heart, yaw: 0.25, pitch: 0.05 },
  cube: { make: () => triples(cube()), yaw: 0.65, pitch: 0.42 },
  torus: { make: () => triples(torus()), yaw: 0.5, pitch: 0.7 },
  sphere: { make: () => triples(sphere(520)), yaw: 0.5, pitch: 0.3 },
  wave: { make: wave, yaw: 0.65, pitch: 0.5 },
};
export const MORPH_SHAPES = Object.keys(MORPHS);

/* ---------- the renderer ---------- */

export class DotObject {
  constructor(canvas, ctx, opts = {}, win = window) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.win = win;
    this.opts = { dot: 2.2, yaw: 0.65, pitch: 0.42, scale: 0.38, entrance: true, hold: 4200, morphMs: 1700, ...opts };
    const shape = this.opts.shape ?? "sphere";
    const list = (this.opts.morph ?? []).filter((name) => MORPHS[name]);
    if (list.length > 1) {
      // a shape-shifter: every shape with the first one's number of dots
      const first = MORPHS[list[0]].make();
      this.shapes = list.map((name, i) => ({ name, pts: fitShape(i ? MORPHS[name].make() : first, first.length), yaw: MORPHS[name].yaw, pitch: MORPHS[name].pitch }));
      this.pts = Float32Array.from(this.shapes[0].pts);
      this.opts.yaw = this.shapes[0].yaw;
      this.opts.pitch = this.shapes[0].pitch;
    } else {
      this.shapes = null;
      this.pts = shape instanceof Float32Array ? shape : SHAPES[shape]();
    }
    this.n = this.pts.length / 3;
    this.shapeIndex = 0;
    this.phase = { morphing: false, since: win.performance.now(), from: null, to: null };
    this.pose = { yaw: this.opts.yaw, pitch: this.opts.pitch }; // the shape's own best angle (eases between shapes)
    this.pointer = null; // in canvas px, while it is over the object
    this.swayFrom = win.performance.now();
    this.seeds = Float32Array.from({ length: this.n }, (_, i) => hash(i));
    this.level = new Uint8Array(this.n);
    this.sx = new Float32Array(this.n);
    this.sy = new Float32Array(this.n);
    this.still = reduced(win);
    this.yaw = this.opts.yaw; // where the person put it
    this.pitch = this.opts.pitch;
    // the dot the signal colour marks: the one nearest `signalAt` (it travels with the morphs)
    this.signalIndex = -1;
    if (this.shapes && this.opts.signalAt) {
      let best = Infinity;
      for (let i = 0; i < this.n; i++) {
        const d = Math.hypot(this.pts[i * 3] - this.opts.signalAt[0], this.pts[i * 3 + 1] - this.opts.signalAt[1], this.pts[i * 3 + 2] - this.opts.signalAt[2]);
        if (d < best) (best = d), (this.signalIndex = i);
      }
    }
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
    // (a canvas is blank after a resize: draw now, so it never flashes empty while it is being moved)
    if (w && h && this.visible) this.draw(this.win.performance.now());
    this.wake();
  }

  /** True when it changes shape by itself. */
  get live() {
    return !!this.shapes && !this.still;
  }

  /** Go to a shape now (by name), or to the next one. */
  morphTo(name) {
    if (!this.shapes) return;
    const i = name ? this.shapes.findIndex((s) => s.name === name) : (this.shapeIndex + 1) % this.shapes.length;
    if (i < 0 || (i === this.shapeIndex && !this.phase.morphing)) return;
    this.phase = { morphing: true, since: this.win.performance.now(), from: Float32Array.from(this.pts), to: this.shapes[i].pts, fromPose: { ...this.pose }, toPose: this.shapes[i] };
    this.shapeIndex = i;
    this.canvas.dataset.shape = this.shapes[i].name;
    if (this.still) this.finishMorph();
    this.wake();
  }

  finishMorph() {
    this.pts.set(this.phase.to);
    this.pose = { yaw: this.phase.toPose.yaw, pitch: this.phase.toPose.pitch };
    this.phase = { morphing: false, since: this.win.performance.now(), from: null, to: null };
  }

  /** Moves the dots along: holds a shape, then sends each dot to its place in the next. */
  advance(t) {
    if (!this.shapes) return;
    const ph = this.phase;
    if (!ph.morphing) {
      if (!this.still && t - ph.since > this.opts.hold && t - this.born > ENTER_MS) this.morphTo();
      return;
    }
    const u = (t - ph.since) / this.opts.morphMs;
    if (u >= 1) return this.finishMorph();
    const { pts, seeds, n } = this;
    for (let i = 0; i < n; i++) {
      // each dot leaves a little after the last, swings round the axis and bulges out on its way
      const e = easeInOut(Math.min(1, Math.max(0, (u - seeds[i] * 0.34) / 0.66)));
      const mid = Math.sin(e * Math.PI);
      const x = ph.from[i * 3] + (ph.to[i * 3] - ph.from[i * 3]) * e;
      const y = ph.from[i * 3 + 1] + (ph.to[i * 3 + 1] - ph.from[i * 3 + 1]) * e;
      const z = ph.from[i * 3 + 2] + (ph.to[i * 3 + 2] - ph.from[i * 3 + 2]) * e;
      const a = mid * 0.75, c = Math.cos(a), s = Math.sin(a), grow = 1 + mid * 0.16;
      pts[i * 3] = (x * c + z * s) * grow;
      pts[i * 3 + 1] = y * grow;
      pts[i * 3 + 2] = (-x * s + z * c) * grow;
    }
    const e = easeInOut(Math.min(1, u));
    this.pose = { yaw: ph.fromPose.yaw + (ph.toPose.yaw - ph.fromPose.yaw) * e, pitch: ph.fromPose.pitch + (ph.toPose.pitch - ph.fromPose.pitch) * e };
  }

  setReducedMotion(still) {
    this.still = still;
    if (still) {
      if (this.phase.morphing) this.finishMorph();
      this.pointer = null;
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
      this.pointer = null;
    } else {
      const r = this.canvas.getBoundingClientRect();
      this.lean.tx = Math.max(-1, Math.min(1, ((cx - r.left) / r.width) * 2 - 1));
      this.lean.ty = Math.max(-1, Math.min(1, ((cy - r.top) / r.height) * 2 - 1));
      this.pointer = { x: cx - r.left, y: cy - r.top };
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
    if (this.live || this.pointer) return true;
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
    // a shape-shifter keeps to the dot field's budget (~30 frames a second) once it has turned in
    const settled = this.live && this.win.performance.now() - this.born > ENTER_MS + 200;
    if (settled && this.last && t - this.last < FRAME_MS) {
      this.raf = this.win.requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(64, t - (this.last || t));
    this.last = t;
    const k = 1 - Math.exp(-dt / 120); // lean settles in ~360 ms
    this.lean.x += (this.lean.tx - this.lean.x) * k;
    this.lean.y += (this.lean.ty - this.lean.y) * k;
    const now = this.win.performance.now();
    this.advance(now);
    this.draw(now);
    if (this.busy(now)) this.raf = this.win.requestAnimationFrame(this.tick);
    else this.last = 0;
  }

  draw(t) {
    const { ctx, pts, n, seeds, level, sx, sy, w, h } = this;
    const age = t - this.born;
    const e = easeEnter(Math.min(1, Math.max(0, age / ENTER_MS)));
    // a shape-shifter turns to each shape's best angle and sways a little, so the shape reads as 3D
    const sway = this.live ? Math.sin(((t - this.swayFrom) / SWAY_MS) * TAU) * SWAY : 0;
    const yaw = this.yaw + (this.pose.yaw - this.opts.yaw) + sway - (1 - e) * 1.1 + this.lean.x * LEAN_YAW;
    const pitch = this.pitch + (this.pose.pitch - this.opts.pitch) + (1 - e) * 0.25 + this.lean.y * LEAN_PITCH;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const R = Math.min(w, h) * this.opts.scale * 2;
    // small (tucked into a corner): fewer, relatively larger dots, so it stays a shape and not a smudge
    const small = Math.min(w, h) < 90;
    const stride = small ? 3 : 1;
    const dotSize = small ? Math.max(1.1, this.opts.dot * 0.62) : this.opts.dot;
    const p = this.pointer;
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
      if (i % stride && i !== this.signalIndex) {
        level[i] = 0;
        continue;
      }
      let [px, py, d] = project(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      const near = Math.min(1, Math.max(0, (d + 1) / 2));
      const appear = Math.min(1, Math.max(0, (age - seeds[i] * ASSEMBLE_MS) / 260));
      let a = appear * (0.14 + 0.86 * near ** 1.4);
      if (p) {
        // the dot field's pointer: dots near it brighten and lean away
        const ddx = px - p.x, ddy = py - p.y, dd = Math.hypot(ddx, ddy);
        if (dd < POINTER_R && dd > 0.01) {
          const k = (1 - dd / POINTER_R) ** 2;
          a += k * 0.55 * appear;
          px += (ddx / dd) * k * 5;
          py += (ddy / dd) * k * 5;
        }
      }
      level[i] = Math.max(0, Math.min(STEPS, Math.round(a * STEPS)));
      sx[i] = px;
      sy[i] = py;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.colours.ink;
    for (let step = 1; step <= STEPS; step++) {
      const rad = (dotSize / 2) * (0.7 + (0.6 * step) / STEPS); // nearer = bigger
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
      const [px, py] = this.signalIndex >= 0 ? [sx[this.signalIndex], sy[this.signalIndex]] : project(...this.opts.signalAt);
      ctx.fillStyle = this.colours.signal;
      ctx.beginPath();
      ctx.arc(px, py, dotSize * 1.6, 0, TAU);
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
