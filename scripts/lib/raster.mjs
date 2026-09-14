/**
 * Scanline polygon rasterisation for projected GeoJSON.
 *
 * Written by hand rather than delegating to a canvas because the build needs
 * exact, aliasing-free region ids: a blended edge pixel between association 12
 * and association 13 would decode as association 40-something. Every pixel here
 * is either one region or nothing.
 */

/**
 * Fill one polygon (outer ring plus any holes) using the even-odd rule.
 * Holes fall out naturally: a point inside a hole crosses an even number of edges.
 *
 * @param {number[][][]} rings - [[ [x,y], ... ], ...], ring 0 is the exterior
 * @param {number} width
 * @param {number} height
 * @param {(x:number, y:number) => void} plot
 */
export function fillPolygon(rings, width, height, plot) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(yMin)) return;

  const y0 = Math.max(0, Math.floor(yMin));
  const y1 = Math.min(height - 1, Math.ceil(yMax));
  const xs = [];

  for (let py = y0; py <= y1; py++) {
    const scan = py + 0.5; // sample at pixel centres
    xs.length = 0;

    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % n];
        if (ay === by) continue;
        // Half-open interval stops shared vertices being counted twice.
        if (scan >= Math.min(ay, by) && scan < Math.max(ay, by)) {
          xs.push(ax + ((scan - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = from; px <= to; px++) plot(px, py);
    }
  }
}

/**
 * Project a GeoJSON geometry and rasterise it.
 * Points the projection rejects (geoAlbersUsa returns null outside its regions)
 * break the ring they belong to, so such rings are skipped rather than smeared.
 */
export function rasterizeGeometry(geometry, projection, width, height, plot) {
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
    : [];

  for (const poly of polys) {
    const rings = [];
    let dropped = false;
    for (const ring of poly) {
      const out = [];
      for (const pt of ring) {
        const p = projection(pt);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { dropped = true; break; }
        out.push(p);
      }
      if (dropped) break;
      if (out.length >= 3) rings.push(out);
    }
    if (dropped || !rings.length) continue;
    fillPolygon(rings, width, height, plot);
  }
}

/**
 * Reduce a supersampled boolean mask to tile resolution: a tile is set if any
 * sample in its block is set. Matches the "any non-zero wins" behaviour of the
 * majority downsample below, so a land mask and an id grid agree on coastlines.
 */
export function downsampleAny(src, srcW, srcH, factor) {
  const dstW = Math.floor(srcW / factor);
  const dstH = Math.floor(srcH / factor);
  const dst = new Uint8Array(dstW * dstH);

  for (let ty = 0; ty < dstH; ty++) {
    for (let tx = 0; tx < dstW; tx++) {
      let hit = 0;
      for (let sy = ty * factor; sy < (ty + 1) * factor && !hit; sy++) {
        for (let sx = tx * factor; sx < (tx + 1) * factor; sx++) {
          if (src[sy * srcW + sx]) { hit = 1; break; }
        }
      }
      dst[ty * dstW + tx] = hit;
    }
  }
  return { grid: dst, width: dstW, height: dstH };
}

/**
 * Reduce a supersampled id grid to tile resolution by majority vote.
 *
 * Supersampling then voting is what keeps small regions alive. Sampling a single
 * point per tile would silently erase associations like Fresno-Madera, whose
 * whole territory is a couple of tiles across.
 */
export function downsampleMajority(src, srcW, srcH, factor) {
  const dstW = Math.floor(srcW / factor);
  const dstH = Math.floor(srcH / factor);
  const dst = new Uint16Array(dstW * dstH);
  const tally = new Map();

  for (let ty = 0; ty < dstH; ty++) {
    for (let tx = 0; tx < dstW; tx++) {
      tally.clear();
      for (let sy = ty * factor; sy < (ty + 1) * factor; sy++) {
        for (let sx = tx * factor; sx < (tx + 1) * factor; sx++) {
          const v = src[sy * srcW + sx];
          if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
        }
      }
      let best = 0;
      let bestN = 0;
      for (const [v, n] of tally) {
        // Ties break toward the lower id purely so the build is deterministic.
        if (n > bestN || (n === bestN && v < best)) { best = v; bestN = n; }
      }
      dst[ty * dstW + tx] = best;
    }
  }
  return { grid: dst, width: dstW, height: dstH };
}
