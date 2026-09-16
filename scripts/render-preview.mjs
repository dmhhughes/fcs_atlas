/**
 * Render the map headlessly.
 *
 * Drives src/render.js - the same frame renderer the page uses - through a
 * minimal Canvas2D shim, so the output is what the browser paints rather than a
 * reimplementation that could agree with itself while both are wrong.
 *
 * Run: npm run preview
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { encodePNG } from './lib/png.mjs';

const { GameMap } = await import('../src/map.js');
const { renderFrame } = await import('../src/render.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const OUT = join(DATA, 'reports');

// --- Minimal Canvas2D -------------------------------------------------------
// The renderer uses fillStyle, fillRect, globalAlpha, the save/translate/
// restore stack, and (since the map became traced vector territories) path
// building (straight edges only - no curves) and filling/stroking, so that is
// what this implements. Polygon fills and strokes are rasterised by hand
// rather than delegated to a library, to keep the "no native deps, preview
// matches the browser" guarantee intact.
class Ctx2D {
  /**
   * @param {number} width   canvas size in device pixels
   * @param {number} height
   * @param {number} scale   device pixels per world pixel
   */
  constructor(width, height, scale = 1) {
    this.width = width;
    this.height = height;
    this.s = scale;
    this.data = new Uint8Array(width * height * 4);
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.tx = 0;
    this.ty = 0;
    this.stack = [];
    this.path = []; // subpaths: { pts: [x,y,...] in world+translate space, closed }
    this.cur = null;
  }

  save() { this.stack.push([this.tx, this.ty]); }
  restore() { [this.tx, this.ty] = this.stack.pop() ?? [0, 0]; }
  translate(x, y) { this.tx += x; this.ty += y; }

  #blend(px, py, r, g, b, a) {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height || a <= 0) return;
    const i = (py * this.width + px) * 4;
    this.data[i] = Math.round(this.data[i] * (1 - a) + r * a);
    this.data[i + 1] = Math.round(this.data[i + 1] * (1 - a) + g * a);
    this.data[i + 2] = Math.round(this.data[i + 2] * (1 - a) + b * a);
    this.data[i + 3] = 255;
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    if (a <= 0) return;
    const s = this.s;
    const x0 = Math.max(0, Math.round((x + this.tx) * s));
    const y0 = Math.max(0, Math.round((y + this.ty) * s));
    const x1 = Math.min(this.width, Math.max(x0 + (w > 0 ? 1 : 0), Math.round((x + this.tx + w) * s)));
    const y1 = Math.min(this.height, Math.max(y0 + (h > 0 ? 1 : 0), Math.round((y + this.ty + h) * s)));

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.#blend(px, py, r, g, b, a);
    }
  }

  // --- Path building -----------------------------------------------------
  // Points are stored in world+translate space (matching fillRect's (x+tx)),
  // and only scaled to device pixels at fill()/stroke() time.

  beginPath() { this.path = []; this.cur = null; }

  moveTo(x, y) {
    this.cur = { pts: [x + this.tx, y + this.ty], closed: false };
    this.path.push(this.cur);
  }

  lineTo(x, y) {
    if (!this.cur) return this.moveTo(x, y);
    this.cur.pts.push(x + this.tx, y + this.ty);
  }

  closePath() { if (this.cur) this.cur.closed = true; }

  // --- Fill / stroke -------------------------------------------------------

  /** Even-odd (or nonzero - our shapes never need the distinction) scanline
   * fill of a set of device-space rings, mirroring lib/raster.mjs's
   * fillPolygon so the two hand-written rasterisers agree with each other. */
  #scanFill(rings, r, g, b, a) {
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 2) {
        if (ring[i] < yMin) yMin = ring[i];
        if (ring[i] > yMax) yMax = ring[i];
      }
    }
    if (!Number.isFinite(yMin)) return;
    const y0 = Math.max(0, Math.floor(yMin));
    const y1 = Math.min(this.height - 1, Math.ceil(yMax));
    const xs = [];

    for (let py = y0; py <= y1; py++) {
      const scan = py + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length / 2;
        for (let i = 0; i < n; i++) {
          const ax = ring[i * 2], ay = ring[i * 2 + 1];
          const j = (i + 1) % n;
          const bx = ring[j * 2], by = ring[j * 2 + 1];
          if (ay === by) continue;
          if (scan >= Math.min(ay, by) && scan < Math.max(ay, by)) {
            xs.push(ax + ((scan - ay) / (by - ay)) * (bx - ax));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        const to = Math.min(this.width - 1, Math.floor(xs[i + 1] - 0.5));
        for (let px = from; px <= to; px++) this.#blend(px, py, r, g, b, a);
      }
    }
  }

  fill() {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    if (a <= 0) return;
    const rings = this.path.filter((p) => p.pts.length >= 6).map((p) => p.pts.map((v) => v * this.s));
    this.#scanFill(rings, r, g, b, a);
  }

  /** Thick strokes are just filled quads, one per segment, projecting half a
   * line-width past each endpoint so consecutive segments leave no gap. */
  stroke() {
    const [r, g, b, a0] = parseColor(this.strokeStyle);
    const a = a0 * this.globalAlpha;
    if (a <= 0) return;
    const w = Math.max(1, this.lineWidth * this.s);
    for (const sub of this.path) {
      const pts = sub.pts.map((v) => v * this.s);
      const n = pts.length / 2;
      if (n < 2) continue;
      const segments = sub.closed ? n : n - 1;
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % n;
        this.#strokeSegment(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], w, r, g, b, a);
      }
    }
  }

  #strokeSegment(x0, y0, x1, y1, w, r, g, b, a) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    const ex = (dx / len) * (w / 2);
    const ey = (dy / len) * (w / 2);
    const quad = [
      x0 - ex + nx, y0 - ey + ny,
      x1 + ex + nx, y1 + ey + ny,
      x1 + ex - nx, y1 + ey - ny,
      x0 - ex - nx, y0 - ey - ny,
    ];
    this.#scanFill([quad], r, g, b, a);
  }
}

function parseColor(c) {
  if (typeof c !== 'string') return [0, 0, 0, 1];

  let m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((d) => d + d).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length >= 8 ? n(6) / 255 : 1];
  }

  m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }

  m = c.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i);
  if (m) {
    const [h, s, l] = [Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100];
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4), 1];
  }

  return [255, 0, 255, 1]; // unmistakable magenta: an unparsed colour is a bug
}

// --- Render -----------------------------------------------------------------
const AVAIL_W = 1060; // the room the page gives the map
const AVAIL_H = 662;

const mapData = JSON.parse(await readFile(join(DATA, 'map.json'), 'utf8'));
const { associations } = JSON.parse(await readFile(join(DATA, 'directory.web.json'), 'utf8'));
const map = new GameMap(mapData, associations);

await mkdir(OUT, { recursive: true });

// Mirrors main.js: quantise so a tile is a whole number of pixels, then size
// the canvas to exactly the map.
const fit = Math.min(AVAIL_W / map.worldWidth, AVAIL_H / map.worldHeight);
const tilePx = Math.max(1, Math.floor(fit * map.tileSize));
const scale = tilePx / map.tileSize;
const unit = map.tileSize / tilePx;
const CANVAS_W = tilePx * map.width;
const CANVAS_H = tilePx * map.height;
const originX = 0;
const originY = 0;
console.log(`fit ${fit.toFixed(3)} -> ${scale.toFixed(4)} (${tilePx}px tiles) on ${CANVAS_W}x${CANVAS_H}`);

async function shot(name, state) {
  const ctx = new Ctx2D(CANVAS_W, CANVAS_H, scale);
  // The letterbox margin outside the world is deep sea, as in main.js.
  ctx.fillStyle = '#4a616b';
  ctx.fillRect(0, 0, CANVAS_W / scale, CANVAS_H / scale);
  ctx.save();
  ctx.translate(originX / scale, originY / scale);
  renderFrame(ctx, map, { unit, mode: 'territory', ...state });
  ctx.restore();

  let magenta = 0;
  for (let i = 0; i < ctx.data.length; i += 4) {
    if (ctx.data[i] === 255 && ctx.data[i + 1] === 0 && ctx.data[i + 2] === 255) magenta++;
  }
  if (magenta) console.log(`  !! ${name}: ${magenta} px from an unparsed colour`);

  await writeFile(join(OUT, `preview-${name}.png`), encodePNG(CANVAS_W, CANVAS_H, ctx.data));
  console.log(`  wrote preview-${name}.png`);
}

const find = (needle) => associations.findIndex((a) => a.name.toLowerCase().includes(needle));

await shot('territory', {});
await shot('district', { mode: 'district' });
await shot('selected', { selected: find('agtrust'), hovered: find('capital farm credit') });
await shot('ping', { selected: find('fresno-madera'), ping: { index: find('fresno-madera'), t: 0.35 } });

console.log('\nPreviews written to data/reports/');
