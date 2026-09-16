/**
 * Marching squares contour tracing + Douglas-Peucker simplification.
 *
 * Traces the boundary of a binary raster mask into closed polygon rings.
 * Corner samples are the mask values themselves (0/1), so every edge
 * crossing lands exactly at the midpoint between two samples - the standard
 * construction for tracing pixel regions, and the reason coordinates below
 * come out on the half-integer lattice (x.5, y.5).
 *
 * A cell always has an even number of active edges (0, 2 or 4) because the
 * four corner values form a cycle, and a cycle of binary values has an even
 * number of transitions. 4-active cells are the marching-squares "saddle":
 * the two diagonal corners could be read as connected or as two separate
 * points touching only at a corner. This traces them as separate (each "on"
 * corner cut off on its own), matching what a 2-active cell does for a lone
 * corner - so saddle handling falls out of the same rule instead of a
 * special case.
 */

const EDGE_POINT = {
  N: (cx, cy) => [cx + 0.5, cy],
  E: (cx, cy) => [cx + 1, cy + 0.5],
  S: (cx, cy) => [cx + 0.5, cy + 1],
  W: (cx, cy) => [cx, cy + 0.5],
};

/**
 * Trace every closed boundary ring of `inside` (region vs. not) within a
 * width x height grid, via marching squares.
 *
 * @param {(x:number, y:number) => boolean} inside
 * @param {number} width
 * @param {number} height
 * @param {{x0:number,y0:number,x1:number,y1:number}} [bounds] - tile range
 *        (inclusive) known to contain the region, to skip scanning the rest
 *        of a much larger grid. Defaults to the whole grid.
 * @returns {number[][]} one flat [x0,y0,x1,y1,...] array per ring
 */
export function traceMask(inside, width, height, bounds) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? false : inside(x, y));

  const x0 = Math.max(-1, (bounds?.x0 ?? 0) - 1);
  const y0 = Math.max(-1, (bounds?.y0 ?? 0) - 1);
  const x1 = Math.min(width - 1, bounds?.x1 ?? width - 1);
  const y1 = Math.min(height - 1, bounds?.y1 ?? height - 1);

  // Undirected graph over crossing points: every active point ends up with
  // degree exactly 2, so the graph is a disjoint union of simple cycles.
  const adj = new Map();
  const key = (x, y) => x * 2 + ',' + y * 2; // half-integers -> exact integer keys
  const link = (a, b) => {
    let la = adj.get(a.key);
    if (!la) adj.set(a.key, (la = { pt: a.pt, to: [] }));
    la.to.push(b.key);
    let lb = adj.get(b.key);
    if (!lb) adj.set(b.key, (lb = { pt: b.pt, to: [] }));
    lb.to.push(a.key);
  };

  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const TL = at(cx, cy);
      const TR = at(cx + 1, cy);
      const BR = at(cx + 1, cy + 1);
      const BL = at(cx, cy + 1);
      const aN = TL !== TR;
      const aE = TR !== BR;
      const aS = BL !== BR;
      const aW = TL !== BL;
      const count = aN + aE + aS + aW;
      if (count === 0) continue;

      let pairs;
      if (count === 2) {
        const edges = [];
        if (aN) edges.push('N');
        if (aE) edges.push('E');
        if (aS) edges.push('S');
        if (aW) edges.push('W');
        pairs = [edges];
      } else {
        // count === 4: the saddle. TL+BR on picks one diagonal's isolation
        // pattern, TR+BL on picks the other.
        pairs = TL && BR ? [['W', 'N'], ['E', 'S']] : [['N', 'E'], ['S', 'W']];
      }

      for (const [e1, e2] of pairs) {
        const p1 = EDGE_POINT[e1](cx, cy);
        const p2 = EDGE_POINT[e2](cx, cy);
        link({ key: key(p1[0], p1[1]), pt: p1 }, { key: key(p2[0], p2[1]), pt: p2 });
      }
    }
  }

  const rings = [];
  const visited = new Set();
  for (const startKey of adj.keys()) {
    if (visited.has(startKey)) continue;
    const ring = [];
    let prevKey = null;
    let curKey = startKey;
    while (curKey !== undefined && !visited.has(curKey)) {
      visited.add(curKey);
      const node = adj.get(curKey);
      ring.push(node.pt[0], node.pt[1]);
      const next = node.to[0] === prevKey ? node.to[1] : node.to[0];
      prevKey = curKey;
      curKey = next;
      if (curKey === startKey) break;
    }
    if (ring.length >= 6) rings.push(ring);
  }
  return rings;
}

/**
 * Douglas-Peucker on an open path (both endpoints are always kept).
 * @param {number[]} points - flat [x0,y0,x1,y1,...]
 * @param {number} epsilon
 * @returns {number[]}
 */
export function simplify(points, epsilon) {
  const n = points.length / 2;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;
  const stack = [[0, n - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi <= lo + 1) continue;

    const x0 = points[lo * 2];
    const y0 = points[lo * 2 + 1];
    const dx = points[hi * 2] - x0;
    const dy = points[hi * 2 + 1] - y0;
    const len2 = dx * dx + dy * dy;

    let maxD2 = -1;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const px = points[i * 2] - x0;
      const py = points[i * 2 + 1] - y0;
      const d2 = len2 === 0
        ? px * px + py * py
        : ((dx * py - dy * px) ** 2) / len2;
      if (d2 > maxD2) { maxD2 = d2; maxI = i; }
    }

    if (maxD2 > eps2) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * Douglas-Peucker on a closed ring: simplified as an open path through the
 * seam back to its own start, then the duplicated closing point is dropped.
 *
 * A ring's two "endpoints" for that open path are the same point (it's
 * closed), so if nothing in between clears epsilon, simplify() has nothing
 * to keep but that one duplicated point - a degenerate 1-point result, not a
 * polygon. That would either vanish from the fill (a hole where a small
 * region used to be, rendering as sea - see CLAUDE.md's "unclaimed land
 * renders as sea" warning) or break path building outright. Falling back to
 * the unsimplified ring keeps tiny features valid instead; they're already
 * small, so skipping simplification on them costs nothing.
 */
export function simplifyRing(ring, epsilon) {
  if (ring.length < 8) return ring.slice();
  const closed = ring.concat([ring[0], ring[1]]);
  const out = simplify(closed, epsilon);
  const result = out.slice(0, -2);
  return result.length >= 6 ? result : ring.slice();
}
