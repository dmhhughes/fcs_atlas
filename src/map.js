/**
 * Tile map: region geometry, hit testing, and the golden-hour renderer.
 *
 * The map is always shown whole, so everything expensive is precomputed once:
 * per-region fill runs and outlines (for highlighting), distance-to-coast for
 * the banded sea, and the coast and district edges. A redraw is then a few
 * thousand rectangles, and it only happens when hover or selection changes.
 */

import {
  SEA_BANDS, LIGHT, DISTRICT_COLORS, DISTRICT_FALLBACK,
  regionColor, tileNoise,
} from './tiles.js';

// Edge flags, packed per tile so each edge tile costs two array slots.
const TOP = 1;
const RIGHT = 2;
const BOTTOM = 4;
const LEFT = 8;

export class GameMap {
  constructor(mapData, associations) {
    this.width = mapData.width;
    this.height = mapData.height;
    this.tileSize = mapData.tileSize;
    this.assoc = Int16Array.from(mapData.assoc);
    this.regions = mapData.regions;
    this.graticule = mapData.graticule ?? [];
    this.associations = associations;

    this.worldWidth = this.width * this.tileSize;
    this.worldHeight = this.height * this.tileSize;

    this.regionByIndex = new Map();
    for (const r of this.regions) if (r) this.regionByIndex.set(r.index, r);

    this.#buildGeometry();
    this.#buildSea();
  }

  // --- Geometry -------------------------------------------------------------

  #buildGeometry() {
    const W = this.width;
    const H = this.height;
    const districtOf = (a) => (a >= 0 ? this.associations[a]?.district ?? '' : null);

    this.runs = new Map(); // region -> [x0, x1, y, ...]
    this.outlines = new Map(); // region -> [tile, sides, ...]
    this.coastEdges = []; // [tile, sides, ...] land tiles touching sea
    this.districtEdges = []; // [tile, sides, ...] land-to-land district changes

    const push = (map, key) => {
      let v = map.get(key);
      if (!v) map.set(key, (v = []));
      return v;
    };

    for (let y = 0; y < H; y++) {
      let runStart = -1;
      let runValue = -1;

      for (let x = 0; x <= W; x++) {
        const a = x < W ? this.assoc[y * W + x] : -1;
        if (a !== runValue) {
          if (runValue >= 0) push(this.runs, runValue).push(runStart, x - 1, y);
          runStart = x;
          runValue = a;
        }
        if (x >= W || a < 0) continue;

        const n = [this.assocAt(x, y - 1), this.assocAt(x + 1, y), this.assocAt(x, y + 1), this.assocAt(x - 1, y)];
        const flags = [TOP, RIGHT, BOTTOM, LEFT];

        let region = 0;
        let coast = 0;
        let district = 0;
        const d = districtOf(a);
        for (let k = 0; k < 4; k++) {
          if (n[k] !== a) region |= flags[k];
          if (n[k] < 0) coast |= flags[k];
          else if (districtOf(n[k]) !== d) district |= flags[k];
        }
        const i = y * W + x;
        if (region) push(this.outlines, a).push(i, region);
        if (coast) this.coastEdges.push(i, coast);
        if (district) this.districtEdges.push(i, district);
      }
    }
  }

  /** Multi-source flood from the coast outward: tiles of sea to nearest land. */
  #buildSea() {
    const W = this.width;
    const H = this.height;
    const CAP = SEA_BANDS.length - 1;
    this.seaDist = new Uint8Array(W * H).fill(CAP);

    let frontier = [];
    for (let i = 0; i < this.assoc.length; i++) {
      if (this.assoc[i] >= 0) { this.seaDist[i] = 0; frontier.push(i); }
    }
    for (let d = 1; d < CAP && frontier.length; d++) {
      const next = [];
      for (const i of frontier) {
        const x = i % W;
        const y = (i / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (this.assoc[k] >= 0 || this.seaDist[k] <= d) continue;
          this.seaDist[k] = d;
          next.push(k);
        }
      }
      frontier = next;
    }
  }

  // --- Queries --------------------------------------------------------------

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  /** Association index at a tile, or -1 for ocean / out of bounds. */
  assocAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return -1;
    return this.assoc[ty * this.width + tx];
  }

  isLand(tx, ty) {
    return this.assocAt(tx, ty) >= 0;
  }

  regionAtWorld(worldX, worldY) {
    return this.assocAt(Math.floor(worldX / this.tileSize), Math.floor(worldY / this.tileSize));
  }

  associationAt(tx, ty) {
    const i = this.assocAt(tx, ty);
    return i >= 0 ? this.associations[i] : null;
  }

  /** Anchor tile of a region, in world pixels (centre of the tile). */
  anchorWorld(index) {
    const r = this.regionByIndex.get(index);
    if (!r) return null;
    return [
      r.anchor[0] * this.tileSize + this.tileSize / 2,
      r.anchor[1] * this.tileSize + this.tileSize / 2,
    ];
  }

  /** The swatch colour an association carries in a given mode. */
  colorOf(index, mode) {
    if (mode === 'district') {
      return DISTRICT_COLORS[this.associations[index]?.district] ?? DISTRICT_FALLBACK;
    }
    return regionColor(index);
  }

  // --- Rendering ------------------------------------------------------------

  /**
   * Draw the whole map.
   * @param {object} opts
   * @param {'territory'|'district'} opts.mode
   * @param {number} opts.unit  one device pixel in world units; every width
   *                            below is a whole multiple of it, so no edge is
   *                            fractional and nothing anti-aliases into seams
   */
  draw(ctx, { mode = 'territory', unit = 1 } = {}) {
    const T = this.tileSize;

    // Sea: deep underlay, then the coastal bands.
    ctx.fillStyle = SEA_BANDS[SEA_BANDS.length - 1];
    ctx.fillRect(0, 0, this.worldWidth, this.worldHeight);
    this.#fillRuns(ctx, (i) => {
      const d = this.seaDist[i];
      return d > 0 && d < SEA_BANDS.length - 1 ? SEA_BANDS[d] : null;
    });

    this.#drawGraticule(ctx, unit);
    this.#drawGlints(ctx, unit);

    // Land, coloured by mode.
    this.#fillRuns(ctx, (i) => {
      const a = this.assoc[i];
      if (a < 0) return null;
      return this.colorOf(a, mode);
    });

    // Territory borders, hairline.
    ctx.fillStyle = LIGHT.border;
    for (const outline of this.outlines.values()) {
      for (let k = 0; k < outline.length; k += 2) {
        const i = outline[k];
        const s = outline[k + 1];
        const px = (i % this.width) * T;
        const py = Math.floor(i / this.width) * T;
        if (s & RIGHT && this.assoc[i + 1] >= 0) ctx.fillRect(px + T - unit, py, unit, T);
        if (s & BOTTOM && this.assoc[i + this.width] >= 0) ctx.fillRect(px, py + T - unit, T, unit);
      }
    }

    if (mode === 'district') {
      this.#strokeEdges(ctx, this.districtEdges, LIGHT.districtBorder, 2 * unit);
    }

    // Golden-hour relief: the sun is low in the west, so coasts facing north
    // and west catch the light and those facing south and east fall into shade.
    this.#strokeEdges(ctx, this.coastEdges, LIGHT.highlight, unit, TOP | LEFT);
    this.#strokeEdges(ctx, this.coastEdges, LIGHT.shadow, 2 * unit, BOTTOM | RIGHT);
  }

  /** Fill tiles row by row, merging horizontal runs of the same colour. */
  #fillRuns(ctx, colorAt) {
    const T = this.tileSize;
    const W = this.width;
    for (let y = 0; y < this.height; y++) {
      let start = 0;
      let color = colorAt(y * W);
      for (let x = 1; x <= W; x++) {
        const c = x < W ? colorAt(y * W + x) : null;
        if (c === color && x < W) continue;
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(start * T, y * T, (x - start) * T, T);
        }
        start = x;
        color = c;
      }
    }
  }

  #strokeEdges(ctx, edges, color, w, only = TOP | RIGHT | BOTTOM | LEFT) {
    const T = this.tileSize;
    const width = Math.min(w, T);
    ctx.fillStyle = color;
    for (let k = 0; k < edges.length; k += 2) {
      const i = edges[k];
      const s = edges[k + 1] & only;
      if (!s) continue;
      const px = (i % this.width) * T;
      const py = Math.floor(i / this.width) * T;
      if (s & TOP) ctx.fillRect(px, py, T, width);
      if (s & BOTTOM) ctx.fillRect(px, py + T - width, T, width);
      if (s & LEFT) ctx.fillRect(px, py, width, T);
      if (s & RIGHT) ctx.fillRect(px + T - width, py, width, T);
    }
  }

  /** Lines of latitude and longitude, dotted, and only where there is sea. */
  #drawGraticule(ctx, unit) {
    const step = 6 * unit;
    ctx.fillStyle = LIGHT.graticule;
    for (const line of this.graticule) {
      let carry = 0;
      for (let k = 0; k + 3 < line.length; k += 2) {
        const x0 = line[k];
        const y0 = line[k + 1];
        const dx = line[k + 2] - x0;
        const dy = line[k + 3] - y0;
        const len = Math.hypot(dx, dy);
        for (let t = carry; t < len; t += step) {
          const x = x0 + (dx * t) / len;
          const y = y0 + (dy * t) / len;
          if (x < 0 || y < 0 || x >= this.worldWidth || y >= this.worldHeight) continue;
          if (this.regionAtWorld(x, y) >= 0) continue;
          ctx.fillRect(Math.round(x / unit) * unit, Math.round(y / unit) * unit, unit, unit);
        }
        carry = (carry - len) % step;
        if (carry < 0) carry += step;
      }
    }
  }

  /** Sparse amber glints where the low sun catches open water. */
  #drawGlints(ctx, unit) {
    const T = this.tileSize;
    ctx.fillStyle = LIGHT.glint;
    for (let i = 0; i < this.seaDist.length; i++) {
      if (this.seaDist[i] < 2) continue;
      const x = i % this.width;
      const y = (i / this.width) | 0;
      if (tileNoise(x, y) < 0.988) continue;
      ctx.fillRect(x * T + 2 * unit, y * T + 2 * unit, 2 * unit, unit);
    }
  }

  /** Wash a region's area in a translucent colour, via its precomputed runs. */
  fillRegion(ctx, index, color) {
    const runs = this.runs.get(index);
    if (!runs) return;
    const T = this.tileSize;
    ctx.fillStyle = color;
    for (let k = 0; k < runs.length; k += 3) {
      ctx.fillRect(runs[k] * T, runs[k + 2] * T, (runs[k + 1] - runs[k] + 1) * T, T);
    }
  }

  /** Stroke a region's boundary, via its precomputed edge segments. */
  strokeRegion(ctx, index, color, thickness) {
    const outline = this.outlines.get(index);
    if (outline) this.#strokeEdges(ctx, outline, color, Math.max(1, thickness));
  }

  /** A small marker on a region's anchor tile, a fixed size on screen. */
  markAnchor(ctx, index, unit, color = '#f7e6c4') {
    const at = this.anchorWorld(index);
    if (!at) return;
    const s = 6 * unit;
    const b = 2 * unit;
    ctx.fillStyle = 'rgba(28,16,10,0.85)';
    ctx.fillRect(at[0] - s / 2 - b, at[1] - s / 2 - b, s + b * 2, s + b * 2);
    ctx.fillStyle = color;
    ctx.fillRect(at[0] - s / 2, at[1] - s / 2, s, s);
  }

  /**
   * An expanding square ring around a region's anchor - the "you are here"
   * ping when a territory is chosen. `t` runs from 0 to 1.
   */
  drawPing(ctx, index, unit, t, color) {
    const at = this.anchorWorld(index);
    if (!at) return;
    const r = Math.round((6 + 30 * t) / 2) * 2 * unit;
    const w = 2 * unit;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = color;
    ctx.fillRect(at[0] - r, at[1] - r, r * 2, w);
    ctx.fillRect(at[0] - r, at[1] + r - w, r * 2, w);
    ctx.fillRect(at[0] - r, at[1] - r, w, r * 2);
    ctx.fillRect(at[0] + r - w, at[1] - r, w, r * 2);
    ctx.globalAlpha = 1;
  }
}
