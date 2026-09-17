/**
 * One frame of the map, from state.
 *
 * Shared by the page and by scripts/render-preview.mjs, so the headless preview
 * is rendered by exactly the code the browser runs rather than a copy of it.
 */

export const OVERLAY = {
  hoverWash: 'rgba(35, 36, 31, 0.12)',
  hoverLine: '#55564c',
  selectWash: 'rgba(178, 58, 46, 0.16)',
  selectBacking: 'rgba(35, 36, 31, 0.85)',
  selectLine: '#b23a2e',
  marker: '#b23a2e',
  ping: '#b23a2e',
};

/**
 * @param {CanvasRenderingContext2D} ctx  already transformed into world space
 * @param {import('./map.js').GameMap} map
 * @param {object} s
 * @param {number} s.unit       one device pixel, in world units
 * @param {number} s.hovered    association index or -1
 * @param {number} s.selected   association index or -1
 * @param {{index:number, t:number}|null} s.ping
 * @param {boolean} s.drawBase  false when the caller has blitted a cached base
 */
export function renderFrame(ctx, map, { unit, hovered = -1, selected = -1, ping = null, drawBase = true }) {
  if (drawBase) map.draw(ctx, { unit });

  if (hovered >= 0 && hovered !== selected) {
    map.fillRegion(ctx, hovered, OVERLAY.hoverWash);
    map.strokeRegion(ctx, hovered, OVERLAY.hoverLine, 2 * unit);
  }

  if (selected >= 0) {
    // The declination-red line over an ink backing reads on every territory
    // and district colour, like a hand-marked selection on a printed sheet.
    map.fillRegion(ctx, selected, OVERLAY.selectWash);
    map.strokeRegion(ctx, selected, OVERLAY.selectBacking, 4 * unit);
    map.strokeRegion(ctx, selected, OVERLAY.selectLine, 2 * unit);
    map.markAnchor(ctx, selected, unit, OVERLAY.marker);
  }

  if (ping) map.drawPing(ctx, ping.index, unit, ping.t, OVERLAY.ping);
}
