/**
 * Palette - "golden hour".
 *
 * The map is lit as if at half past four on an autumn afternoon: warm, low
 * light from the west over a violet sea.
 */

/**
 * The sea, banded by distance from the coast like a 16-bit overworld: a bright
 * surf ring, shallows, then deep water. Index = tiles from the nearest land.
 */
export const SEA_BANDS = ['#2a2150', '#4a3a7c', '#3b2f6b', '#32285e', '#2a2150'];

/** Low sun from the west-northwest: lit coasts face it, shadowed coasts don't. */
export const LIGHT = {
  highlight: 'rgba(255, 215, 106, 0.55)',
  shadow: 'rgba(22, 12, 34, 0.55)',
  glint: '#f5a54a',
  graticule: 'rgba(185, 168, 214, 0.28)',
  border: 'rgba(43, 27, 18, 0.42)',
  districtBorder: 'rgba(28, 16, 10, 0.9)',
};

/** One colour per funding bank, for the district view and the gazetteer. */
export const DISTRICT_COLORS = {
  AgFirst: '#e0648f',
  AgriBank: '#f0a543',
  CoBank: '#9b86d6',
  Texas: '#7fb58f',
};
export const DISTRICT_FALLBACK = '#b9a8d6';

/**
 * Deterministic colour per association, spaced around the wheel by the golden
 * angle so neighbours stay distinguishable. Held a little softer than full
 * saturation so 55 hues still sit inside the dusk palette.
 */
export function regionColor(index) {
  const hue = (index * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} 46% 60%)`;
}

/** Stable per-tile pseudo-random value in [0,1). */
export function tileNoise(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
