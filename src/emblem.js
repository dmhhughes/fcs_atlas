/**
 * The site emblem: a sprout rising over a ploughed field, on an 8x8 grid.
 * Mirror-symmetric, and drawn the same way everywhere it appears - the title
 * plate and the favicon.
 */

export const EMBLEM = [
  '...##...',
  '###..###',
  '##....##',
  '..#..#..',
  '...##...',
  '........',
  '..####..',
  '########',
];

/** Inline SVG markup for the emblem, crisp at any integer scale. */
export function emblemSvg({ fg = '#2b1d14', bg = null, size = 32, pad = 0 } = {}) {
  const n = 8 + pad * 2;
  const rects = [];
  EMBLEM.forEach((row, y) => {
    for (let x = 0; x < 8; x++) {
      if (row[x] === '#') rects.push(`<rect x="${x + pad}" y="${y + pad}" width="1" height="1"/>`);
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" aria-hidden="true">` +
    (bg ? `<rect width="${n}" height="${n}" fill="${bg}"/>` : '') +
    `<g fill="${fg}">${rects.join('')}</g></svg>`
  );
}

/** Point the document favicon at the emblem. */
export function installFavicon(fg, bg) {
  const link = document.querySelector('link[rel="icon"]') ?? document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(emblemSvg({ fg, bg, size: 64, pad: 1 }))}`;
  document.head.append(link);
}
