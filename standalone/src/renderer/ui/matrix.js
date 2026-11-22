/**
 * OmniDraw: the matrix. The dot field behind the chat's head (dots.js), on every surface:
 * one layer of the same dots over the whole window, on the same 7px grid, in the same grey,
 * with the same slow pattern of lighter and darker dots. Dots near the pointer brighten and
 * lean away, exactly like the field's.
 *
 * Unlike the live field it does not drift: it is drawn once, and only the patch around the
 * pointer is drawn again as the pointer moves, so it costs nothing while the mouse is still,
 * whatever the window's size. It never takes a click (pointer-events: none), stays out of
 * areas given as `holes` (the diagram itself), and does not react under reduced motion.
 *
 *   import { mountMatrix } from "/ui/matrix.js";
 *   const matrix = mountMatrix();            // the app's pages (colour from CSS: --matrix-dot)
 *   mountMatrix({ holes: () => [rect], colour: () => "#7d7d7d", zIndex: 9000 });   // draw.io
 */
import { drift, media, reducedMotion } from "./dots.js";

const GRID = 7; // as the dot field
const DOT = 1.6;
const STEPS = 16;
const POINTER_R = 84;
const TAU = Math.PI * 2;

/** A dot's place in the slow pattern, the same on every load. */
function seed(c, r) {
  const x = Math.sin((r * 733 + c) * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function mountMatrix(opts = {}) {
  const doc = opts.document ?? document;
  const win = doc.defaultView;
  if (!win || !doc.body) return null;
  const layer = doc.createElement("div");
  layer.className = "matrix-layer";
  layer.setAttribute("aria-hidden", "true");
  const canvas = doc.createElement("canvas");
  layer.appendChild(canvas);
  Object.assign(layer.style, { position: "fixed", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: String(opts.zIndex ?? 2147482000) });
  Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
  doc.body.appendChild(layer);
  let ctx = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) {
    layer.remove();
    return null;
  }

  const density = opts.density ?? 0.2;
  const boost = opts.boost ?? 0.5;
  let w = 0, h = 0, dpr = 1;
  let colour = "#8b8984";
  let mode = "grey";
  let pointer = null; // where the pointer is, in CSS px
  let drawn = null; // where it was when the patch around it was last drawn
  let holes = [];
  let still = reducedMotion(win);
  let raf = 0;
  let dots = 0;
  const buckets = Array.from({ length: STEPS + 1 }, () => []);

  const readColour = () => {
    colour = (opts.colour ? opts.colour(mode) : win.getComputedStyle(layer).getPropertyValue("--matrix-dot").trim()) || colour;
  };
  const readHoles = () => {
    const next = (opts.holes ? opts.holes() : []).filter(Boolean).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    const same = next.length === holes.length && next.every((r, i) => r.left === holes[i].left && r.top === holes[i].top && r.right === holes[i].right && r.bottom === holes[i].bottom);
    holes = next;
    return !same;
  };
  const inHole = (x, y) => {
    for (const r of holes) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    return false;
  };

  /** Draws the dots of the grid cells c0..c1 × r0..r1 again (whole cells, so no dot is cut). */
  function paint(c0, r0, c1, r1, count) {
    c0 = Math.max(0, c0);
    r0 = Math.max(0, r0);
    c1 = Math.min(Math.ceil(w / GRID) - 1, c1);
    r1 = Math.min(Math.ceil(h / GRID) - 1, r1);
    if (c1 < c0 || r1 < r0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(c0 * GRID, r0 * GRID, (c1 - c0 + 1) * GRID, (r1 - r0 + 1) * GRID);
    for (const b of buckets) b.length = 0;
    const p = still ? null : pointer;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const y = r * GRID + GRID / 2;
      for (let c = c0; c <= c1; c++) {
        const x = c * GRID + GRID / 2;
        if (holes.length && inHole(x, y)) continue;
        let a = density * (0.25 + 0.75 * drift(x, y, seed(c, r) * 900));
        let px = x, py = y;
        if (p) {
          const ddx = x - p.x, ddy = y - p.y, dd = Math.hypot(ddx, ddy);
          if (dd < POINTER_R && dd > 0.01) {
            const k = (1 - dd / POINTER_R) ** 2;
            a += k * boost;
            px += (ddx / dd) * k * 2.6;
            py += (ddy / dd) * k * 2.6;
          }
        }
        const level = Math.max(0, Math.min(STEPS, Math.round(a * STEPS)));
        if (level) buckets[level].push(px, py);
        n++;
      }
    }
    ctx.fillStyle = colour;
    const rad = DOT / 2;
    for (let step = 1; step <= STEPS; step++) {
      const b = buckets[step];
      if (!b.length) continue;
      ctx.beginPath();
      for (let i = 0; i < b.length; i += 2) {
        ctx.moveTo(b[i] + rad, b[i + 1]);
        ctx.arc(b[i], b[i + 1], rad, 0, TAU);
      }
      ctx.globalAlpha = step / STEPS;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (count) dots = n;
  }
  const all = () => {
    drawn = still || !pointer ? null : { x: pointer.x, y: pointer.y };
    paint(0, 0, Math.ceil(w / GRID), Math.ceil(h / GRID), true);
  };
  /** The cells a pointer at (x, y) touches. */
  const around = (q) => {
    const m = POINTER_R + GRID;
    return [Math.floor((q.x - m) / GRID), Math.floor((q.y - m) / GRID), Math.floor((q.x + m) / GRID), Math.floor((q.y + m) / GRID)];
  };

  function resize() {
    const nw = win.innerWidth, nh = win.innerHeight, nd = Math.min(2, win.devicePixelRatio || 1);
    if (nw === w && nh === h && nd === dpr) return false;
    w = nw;
    h = nh;
    dpr = nd;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    return true;
  }
  /** Everything again: after a resize, a theme change, or when the areas to stay out of moved. */
  function refresh() {
    resize();
    readColour();
    readHoles();
    all();
  }
  function frame() {
    raf = 0;
    if (mode === "off") return;
    if (resize() | readHoles()) {
      readColour();
      return all();
    }
    // only the patches the pointer left and entered
    const was = drawn;
    drawn = still || !pointer ? null : { x: pointer.x, y: pointer.y };
    if (was) paint(...around(was), false);
    if (drawn && !(was && Math.abs(was.x - drawn.x) < 0.5 && Math.abs(was.y - drawn.y) < 0.5)) paint(...around(drawn), false);
  }
  const wake = () => {
    if (!raf) raf = win.requestAnimationFrame(frame);
  };

  const off = [];
  const on = (target, ev, fn, o) => {
    target?.addEventListener(ev, fn, o);
    off.push(() => target?.removeEventListener(ev, fn, o));
  };
  on(win, "pointermove", (ev) => {
    if (still || mode === "off" || (ev.pointerType !== "mouse" && ev.pointerType !== "pen")) return;
    pointer = { x: ev.clientX, y: ev.clientY };
    wake();
  }, { passive: true, capture: true });
  const leave = () => {
    if (!pointer) return;
    pointer = null;
    wake();
  };
  on(doc.documentElement, "pointerleave", leave, { passive: true });
  on(win, "blur", leave);
  on(win, "resize", wake);
  on(media(win, "(prefers-color-scheme: dark)"), "change", () => refresh());
  on(media(win, "(prefers-reduced-motion: reduce)"), "change", () => {
    still = reducedMotion(win);
    pointer = null;
    refresh();
  });
  if (typeof MutationObserver !== "undefined") {
    // the app's pages say which matrix they want on <html data-matrix>, and their theme on data-theme
    const mo = new MutationObserver(() => api.setMode(doc.documentElement.dataset.matrix || mode));
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-matrix", "data-theme"] });
    off.push(() => mo.disconnect());
  }

  const api = {
    /** "grey", "green" or "off". */
    setMode(next) {
      mode = next === "off" || next === "green" ? next : "grey";
      layer.style.display = mode === "off" ? "none" : "block";
      if (mode !== "off") refresh();
    },
    refresh,
    /** Looks again at the areas to stay out of (they moved or changed size). */
    check: wake,
    stats: () => ({ mode, dots, width: w, height: h, holes: holes.length, colour }),
    destroy() {
      for (const f of off) f();
      if (raf) win.cancelAnimationFrame(raf);
      layer.remove();
    },
  };
  api.setMode(opts.mode ?? doc.documentElement.dataset.matrix ?? "grey");
  return api;
}
