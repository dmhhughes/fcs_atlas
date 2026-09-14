/**
 * One frame of the map, from state.
 *
 * Shared by the page and by scripts/render-preview.mjs, so the headless preview
 * is rendered by exactly the code the browser runs rather than a copy of it.
 */

export const OVERLAY = {
  hoverWash: 'rgba(247, 230, 196, 0.18)',
  hoverLine: '#f7e6c4',
  selectWash: 'rgba(255, 215, 106, 0.24)',
  selectBacking: 'rgba(28, 16, 10, 0.9)',
  selectLine: '#ffd76a',
  marker: '#e85d8f',
  ping: '#e85d8f',
};

/**
 * @param {CanvasRenderingContext2D} ctx  already transformed into world space
 * @param {import('./map.js').GameMap} map
 * @param {object} s
 * @param {string} s.mode       territory | district
 * @param {number} s.unit       one device pixel, in world units
 * @param {number} s.hovered    association index or -1
 * @param {number} s.selected   association index or -1
 * @param {{index:number, t:number}|null} s.ping
 * @param {boolean} s.drawBase  false when the caller has blitted a cached base
 */
export function renderFrame(ctx, map, { mode, unit, hovered = -1, selected = -1, ping = null, drawBase = true }) {
  if (drawBase) map.draw(ctx, { mode, unit });

  if (hovered >= 0 && hovered !== selected) {
    map.fillRegion(ctx, hovered, OVERLAY.hoverWash);
    map.strokeRegion(ctx, hovered, OVERLAY.hoverLine, 2 * unit);
  }

  if (selected >= 0) {
    // The low sun "spotlights" the chosen territory: a gold line over a dark
    // backing, which reads on every territory and district colour.
    map.fillRegion(ctx, selected, OVERLAY.selectWash);
    map.strokeRegion(ctx, selected, OVERLAY.selectBacking, 4 * unit);
    map.strokeRegion(ctx, selected, OVERLAY.selectLine, 2 * unit);
    map.markAnchor(ctx, selected, unit, OVERLAY.marker);
  }

  if (ping) map.drawPing(ctx, ping.index, unit, ping.t, OVERLAY.ping);
}
