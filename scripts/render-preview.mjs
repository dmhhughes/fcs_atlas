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
// The renderer uses fillStyle, fillRect, globalAlpha and the save/translate/
// restore stack, so that is all this implements.
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
    this.globalAlpha = 1;
    this.tx = 0;
    this.ty = 0;
    this.stack = [];
  }

  save() { this.stack.push([this.tx, this.ty]); }
  restore() { [this.tx, this.ty] = this.stack.pop() ?? [0, 0]; }
  translate(x, y) { this.tx += x; this.ty += y; }

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
      for (let px = x0; px < x1; px++) {
        const i = (py * this.width + px) * 4;
        this.data[i] = Math.round(this.data[i] * (1 - a) + r * a);
        this.data[i + 1] = Math.round(this.data[i + 1] * (1 - a) + g * a);
        this.data[i + 2] = Math.round(this.data[i + 2] * (1 - a) + b * a);
        this.data[i + 3] = 255;
      }
    }
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
  ctx.fillStyle = '#2a2150';
  ctx.fillRect(0, 0, CANVAS_W / scale, CANVAS_H / scale);
  ctx.save();
  ctx.translate(originX / scale, originY / scale);
  renderFrame(ctx, map, { unit, mode: 'terrain', ...state });
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

await shot('terrain', {});
await shot('territory', { mode: 'territory' });
await shot('district', { mode: 'district' });
await shot('selected', { selected: find('agtrust'), hovered: find('capital farm credit') });
await shot('ping', { selected: find('fresno-madera'), ping: { index: find('fresno-madera'), t: 0.35 } });

console.log('\nPreviews written to data/reports/');
