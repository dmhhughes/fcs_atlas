/**
 * Palette - "the quadrangle".
 *
 * The map reads as a flat printed survey sheet: paper and ink, hypsometric
 * tints instead of a lit landscape, no directional light.
 */

/** The sea: one flat chart tint, no distance banding. */
export const SEA = '#4a616b';

/**
 * Flat ink linework - no raking light on a printed chart. Territory and
 * district lines are solid (not translucent): each side of a shared border
 * is traced and stroked independently (see map.js), so two adjacent
 * territories' hairlines sit almost but not quite on top of each other -
 * translucent ink would show that as a faint double line.
 */
export const LIGHT = {
  // Every territory polygon is stroked with this, always - it reads as the
  // coastline wherever the territory borders open sea, and as the internal
  // border wherever it borders another territory. One line style, no need to
  // tell the two apart.
  territoryLine: '#23241f',
  graticule: 'rgba(138, 90, 50, 0.32)',
  districtBorder: '#23241f',
};

/** One colour per funding bank, for the district view and the gazetteer. */
export const DISTRICT_COLORS = {
  AgFirst: '#7c5a34',
  AgriBank: '#5e7a4c',
  CoBank: '#8a5c6e',
  Texas: '#b08a3e',
};
export const DISTRICT_FALLBACK = '#9c8760';

/**
 * Deterministic colour per association, spaced around the wheel by the golden
 * angle so neighbours stay distinguishable. Held to an earth/vegetation hue
 * arc and low saturation so 55 tints read as hypsometric shading rather than
 * confetti; blue is left to the sea and red to the selection accent.
 */
export function regionColor(index) {
  const hue = 25 + ((index * 137.508) % 125);
  return `hsl(${hue.toFixed(1)} 38% 54%)`;
}

/** Stable per-tile pseudo-random value in [0,1). */
export function tileNoise(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
