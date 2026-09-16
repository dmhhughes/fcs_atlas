/**
 * Tile map: region geometry, hit testing, and the survey-sheet renderer.
 *
 * Hit-testing, navigation and the anchor/signpost logic all still work off
 * the tile grid (`assoc[]`) precisely as before. What's drawn is different:
 * `territories[]`/`districts` hold traced vector polygons (see
 * scripts/lib/contour.mjs and scripts/3-build-map.mjs), drawn as straight
 * simplified edges - crisp reference-map linework rather than a tile mosaic.
 */

import { SEA, LIGHT, DISTRICT_COLORS, DISTRICT_FALLBACK, regionColor } from './tiles.js';

export class GameMap {
  constructor(mapData, associations) {
    this.width = mapData.width;
    this.height = mapData.height;
    this.tileSize = mapData.tileSize;
    this.assoc = Int16Array.from(mapData.assoc);
    this.regions = mapData.regions;
    this.graticule = mapData.graticule ?? [];
    this.territories = mapData.territories ?? [];
    this.districts = mapData.districts ?? {};
    this.associations = associations;

    this.worldWidth = this.width * this.tileSize;
    this.worldHeight = this.height * this.tileSize;

    this.regionByIndex = new Map();
    for (const r of this.regions) if (r) this.regionByIndex.set(r.index, r);
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
   * @param {number} opts.unit  one device pixel in world units - hairline
   *                            widths are given in multiples of it. Territory
   *                            edges are traced vector polygons, not tile-
   *                            aligned, so they anti-alias normally.
   */
  draw(ctx, { mode = 'territory', unit = 1 } = {}) {
    // The sea is a single flat tint - no distance banding.
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, this.worldWidth, this.worldHeight);

    this.#drawGraticule(ctx, unit);

    // Land, coloured by mode.
    for (let i = 0; i < this.territories.length; i++) {
      const rings = this.territories[i].rings;
      if (rings.length) this.#fillRings(ctx, rings, this.colorOf(i, mode));
    }

    // Territory hairlines: this alone is the coastline wherever a territory
    // meets open sea, and the internal border wherever it meets another
    // territory - both sides of a shared border trace and stroke
    // independently, which is exactly why the ink has to be solid rather
    // than translucent (see tiles.js).
    for (let i = 0; i < this.territories.length; i++) {
      const rings = this.territories[i].rings;
      if (rings.length) this.#strokeRings(ctx, rings, LIGHT.territoryLine, unit);
    }

    if (mode === 'district') {
      for (const district of Object.values(this.districts)) {
        if (district.rings.length) this.#strokeRings(ctx, district.rings, LIGHT.districtBorder, 2 * unit);
      }
    }
  }

  /** Trace a set of rings into the current path as straight simplified edges. */
  #tracePath(ctx, rings) {
    ctx.beginPath();
    for (const ring of rings) {
      const n = ring.length / 2;
      if (n < 2) continue;
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 1; i < n; i++) ctx.lineTo(ring[i * 2], ring[i * 2 + 1]);
      ctx.closePath();
    }
  }

  #fillRings(ctx, rings, color) {
    ctx.fillStyle = color;
    this.#tracePath(ctx, rings);
    ctx.fill('evenodd'); // rings may include holes; even-odd needs no winding convention
  }

  #strokeRings(ctx, rings, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width);
    this.#tracePath(ctx, rings);
    ctx.stroke();
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

  /** Wash a region's area in a translucent colour, via its traced polygon. */
  fillRegion(ctx, index, color) {
    const rings = this.territories[index]?.rings;
    if (rings?.length) this.#fillRings(ctx, rings, color);
  }

  /** Stroke a region's boundary, via its traced polygon. */
  strokeRegion(ctx, index, color, thickness) {
    const rings = this.territories[index]?.rings;
    if (rings?.length) this.#strokeRings(ctx, rings, color, thickness);
  }

  /**
   * A small ink-backed cross on a region's anchor tile, a fixed size on
   * screen - reads as a section-corner or benchmark mark on the sheet.
   */
  markAnchor(ctx, index, unit, color = '#b23a2e') {
    const at = this.anchorWorld(index);
    if (!at) return;
    const s = 8 * unit;
    const w = 2 * unit;
    const b = 2 * unit;
    ctx.fillStyle = 'rgba(35,36,31,0.85)';
    ctx.fillRect(at[0] - s / 2 - b, at[1] - w / 2 - b, s + b * 2, w + b * 2);
    ctx.fillRect(at[0] - w / 2 - b, at[1] - s / 2 - b, w + b * 2, s + b * 2);
    ctx.fillStyle = color;
    ctx.fillRect(at[0] - s / 2, at[1] - w / 2, s, w);
    ctx.fillRect(at[0] - w / 2, at[1] - s / 2, w, s);
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
