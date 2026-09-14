/**
 * Spatial navigation between territories.
 *
 * Territories are an irregular mosaic, not a grid, so "the region to the left"
 * has no indexed answer. Each candidate is scored by how far it lies along the
 * requested direction versus how far it strays off-axis; anything outside a
 * cone around the direction is rejected outright. This is the same approach
 * browsers use for spatial focus navigation, and it behaves predictably on
 * shapes as awkward as AgWest or Farm Credit East.
 */

export const DIRECTIONS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** How far off-axis a candidate may sit, as a ratio of its on-axis distance. */
const CONE = 1.8;

/** Off-axis distance is penalised this much relative to on-axis distance. */
const DRIFT_PENALTY = 2.2;

/**
 * @param {Map<number, [number, number]>} anchors  region index -> world position
 * @param {number} from      region index to move away from
 * @param {string} direction one of DIRECTIONS
 * @returns {number|null}    the region index to move to
 */
export function neighborInDirection(anchors, from, direction) {
  const vec = DIRECTIONS[direction];
  const origin = anchors.get(from);
  if (!vec || !origin) return null;

  const [dx, dy] = vec;
  let best = null;
  let bestScore = Infinity;

  for (const [index, at] of anchors) {
    if (index === from) continue;

    const vx = at[0] - origin[0];
    const vy = at[1] - origin[1];
    const along = vx * dx + vy * dy;
    if (along <= 0) continue; // behind us

    const drift = Math.abs(vx * dy - vy * dx); // perpendicular distance
    if (drift > along * CONE) continue; // outside the cone

    const score = along + drift * DRIFT_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }

  return best;
}

/**
 * Nearest region to a point, used to seed the selection and to recover when a
 * direction has no candidate at all.
 */
export function nearestRegion(anchors, x, y, exclude = -1) {
  let best = null;
  let bestD = Infinity;
  for (const [index, at] of anchors) {
    if (index === exclude) continue;
    const d = (at[0] - x) ** 2 + (at[1] - y) ** 2;
    if (d < bestD) { bestD = d; best = index; }
  }
  return best;
}
