/**
 * The site emblem: the same compass rose drawn in the hero marginalia,
 * reused for the favicon and the footer mark so every appearance of the
 * atlas's mark is one shape.
 */

/** Inline SVG markup for the compass emblem, crisp at any scale. */
export function emblemSvg({ fg = '#23241f', bg = null, size = 32 } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ` +
    `shape-rendering="geometricPrecision" aria-hidden="true">` +
    (bg ? `<rect width="64" height="64" fill="${bg}"/>` : '') +
    `<circle cx="32" cy="32" r="27" fill="none" stroke="${fg}" stroke-width="1.5"/>` +
    `<path fill="none" stroke="${fg}" stroke-width="1.5" d="M32 2 L32 8 M32 56 L32 62 M62 32 L56 32 M2 32 L8 32"/>` +
    `<text x="32" y="16" text-anchor="middle" font-size="7" font-family="monospace" fill="${fg}">N</text>` +
    `<path fill="${fg}" d="M32 18 L35.5 28.5 L46 32 L35.5 35.5 L32 46 L28.5 35.5 L18 32 L28.5 28.5 Z"/>` +
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
