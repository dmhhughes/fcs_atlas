/**
 * The site emblem: a benchmark disk (the brass survey markers USGS crews set
 * into rock and concrete) with the atlas's compass rose set into its center,
 * reused for the hero, the favicon and the footer mark so every appearance of
 * the atlas's mark is one shape.
 */

let emblemInstances = 0;

/** Inline SVG markup for the emblem, crisp at any scale. */
export function emblemSvg({ fg = '#23241f', bg = null, size = 32 } = {}) {
  // Unique per call: multiple emblems can be on the page at once (hero,
  // footer), and SVG ids are global to the document, not scoped per <svg>.
  const uid = `emblem${emblemInstances++}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ` +
    `shape-rendering="geometricPrecision" aria-hidden="true">` +
    (bg ? `<rect width="64" height="64" fill="${bg}"/>` : '') +
    // Disk rim: a plain edge, a reeded ring, then the register line the
    // engraved legend sits on.
    `<circle cx="32" cy="32" r="30" fill="none" stroke="${fg}" stroke-width="1.2"/>` +
    `<circle cx="32" cy="32" r="27.5" fill="none" stroke="${fg}" stroke-width="2.2" stroke-dasharray="0.8 1.6"/>` +
    `<circle cx="32" cy="32" r="23" fill="none" stroke="${fg}" stroke-width="0.6"/>` +
    `<path id="${uid}-top" d="M11.16,22.28 A23,23 0 0 1 52.84,22.28" fill="none" stroke="none"/>` +
    `<path id="${uid}-bot" d="M52.84,41.72 A23,23 0 0 1 11.16,41.72" fill="none" stroke="none"/>` +
    `<text font-family="monospace" font-size="4" letter-spacing="0.3" fill="${fg}">` +
    `<textPath href="#${uid}-top" startOffset="50%" text-anchor="middle">TERRITORY ATLAS</textPath></text>` +
    `<text font-family="monospace" font-size="4" letter-spacing="0.3" fill="${fg}">` +
    `<textPath href="#${uid}-bot" startOffset="50%" text-anchor="middle">FARM CREDIT SYSTEM</textPath></text>` +
    // The compass rose, set into the disk's center.
    `<circle cx="32" cy="32" r="10" fill="none" stroke="${fg}" stroke-width="0.8"/>` +
    `<path fill="none" stroke="${fg}" stroke-width="0.8" d="M32,20.5 L32,23.5 M32,40.5 L32,43.5 M40.5,32 L43.5,32 M20.5,32 L23.5,32"/>` +
    `<text x="32" y="26.3" text-anchor="middle" font-size="2.6" font-family="monospace" fill="${fg}">N</text>` +
    `<path fill="${fg}" d="M32,26.81 L33.30,30.70 L37.19,32 L33.30,33.30 L32,37.19 L30.70,33.30 L26.81,32 L30.70,30.70 Z"/>` +
    `</svg>`
  );
}

/** Point the document favicon at the emblem. */
export function installFavicon(fg, bg) {
  const link = document.querySelector('link[rel="icon"]') ?? document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(emblemSvg({ fg, bg, size: 64 }))}`;
  document.head.append(link);
}
