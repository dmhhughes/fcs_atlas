/**
 * Step 4 - Seed the terrain layer.
 *
 * Terrain is an aesthetic layer, not a data claim. Its job is to make each
 * region read as a distinct landscape while staying broadly honest about
 * the landscape: the Southwest should look arid, the Gulf coast swampy, the
 * Corn Belt cultivated. It deliberately does not attempt real landcover
 * classification - a per-pixel NLCD read would be both heavy and, at this tile
 * size, visually muddy. Coherent zones beat accurate noise here.
 *
 * Each tile is back-projected to longitude/latitude through the same projection
 * step 3 rasterised with, then classified by an ordered rule list. Boundaries
 * are jittered so zones interlock raggedly rather than meeting in straight lines.
 *
 * The output is a starting point. tools/terrain-painter.html exists to hand-fix
 * whatever looks wrong, which is expected and normal.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feature } from 'topojson-client';
import { geoAlbersUsa } from 'd3-geo';
import { TILES_W, TILES_H, SS } from './lib/config.mjs';
import { encodePNG, gridToRGBA } from './lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const ATLAS = join(HERE, '..', 'node_modules', 'us-atlas', 'counties-10m.json');

const T = { WATER: 0, FARMLAND: 1, TALLGRASS: 2, FOREST: 3, DESERT: 4, WETLAND: 5, MOUNTAIN: 6 };
const NAMES = ['water', 'farmland', 'tallgrass', 'forest', 'desert', 'wetland', 'mountain'];

const between = (v, lo, hi) => v >= lo && v <= hi;

/**
 * Ordered rules; the first match wins. Coordinates are degrees, so these read
 * as a rough physical geography of the United States.
 */
const RULES = [
  // --- Insets and islands ---------------------------------------------------
  { name: 'alaska interior', t: T.MOUNTAIN, test: (lon, lat) => lat > 60 && between(lon, -155, -140) },
  { name: 'alaska', t: T.FOREST, test: (lon, lat) => lat > 51 && lon < -129 },
  { name: 'hawaii', t: T.FOREST, test: (lon, lat) => between(lat, 18, 23) && lon < -154 },

  // --- Arid west ------------------------------------------------------------
  { name: 'sonoran / chihuahuan', t: T.DESERT, test: (lon, lat) => lat < 34.5 && between(lon, -117, -103) },
  { name: 'mojave', t: T.DESERT, test: (lon, lat) => between(lat, 34, 37.5) && between(lon, -118, -113) },
  { name: 'great basin', t: T.DESERT, test: (lon, lat) => between(lat, 36.5, 42) && between(lon, -120, -112) },
  { name: 'colorado plateau', t: T.DESERT, test: (lon, lat) => between(lat, 34.5, 39) && between(lon, -112, -106) },
  { name: 'trans-pecos', t: T.DESERT, test: (lon, lat) => between(lat, 29, 33) && between(lon, -106, -101.5) },

  // --- Mountains ------------------------------------------------------------
  { name: 'northern rockies', t: T.MOUNTAIN, test: (lon, lat) => between(lat, 42, 49.5) && between(lon, -116, -108) },
  { name: 'southern rockies', t: T.MOUNTAIN, test: (lon, lat) => between(lat, 35, 42) && between(lon, -108.5, -104.5) },
  { name: 'sierra nevada', t: T.MOUNTAIN, test: (lon, lat) => between(lat, 35.5, 40) && between(lon, -121, -117.8) },
  { name: 'cascades', t: T.MOUNTAIN, test: (lon, lat) => between(lat, 42, 49) && between(lon, -122.5, -120) },
  { name: 'appalachians', t: T.MOUNTAIN, test: (lon, lat) => between(lat, 35, 41) && between(lon, -83.5, -78.5) },

  // --- Wetlands -------------------------------------------------------------
  { name: 'south florida', t: T.WETLAND, test: (lon, lat) => lat < 28.6 && lon > -82.5 },
  { name: 'gulf coast', t: T.WETLAND, test: (lon, lat) => lat < 31 && between(lon, -95, -86) },
  { name: 'mississippi delta', t: T.WETLAND, test: (lon, lat) => between(lat, 30, 35.5) && between(lon, -91.8, -89.5) },
  { name: 'atlantic lowland', t: T.WETLAND, test: (lon, lat) => between(lat, 31.5, 35.5) && lon > -80.3 },
  { name: 'chesapeake', t: T.WETLAND, test: (lon, lat) => between(lat, 36.5, 39.5) && between(lon, -77, -75) },

  // --- Forest ---------------------------------------------------------------
  { name: 'pacific northwest', t: T.FOREST, test: (lon, lat) => lat > 41.5 && lon < -119.5 },
  { name: 'northern california', t: T.FOREST, test: (lon, lat) => between(lat, 39, 42) && lon < -121 },
  { name: 'new england', t: T.FOREST, test: (lon, lat) => lat > 41.5 && lon > -76 },
  { name: 'adirondacks / north woods', t: T.FOREST, test: (lon, lat) => lat > 43.5 && between(lon, -95, -73) },
  { name: 'ozarks', t: T.FOREST, test: (lon, lat) => between(lat, 35, 38) && between(lon, -94.5, -90.5) },
  { name: 'southern pine', t: T.FOREST, test: (lon, lat) => between(lat, 30.5, 35) && between(lon, -89.5, -80) },
  { name: 'appalachian foothills', t: T.FOREST, test: (lon, lat) => between(lat, 36, 42) && between(lon, -85, -77) },

  // --- Cultivated -----------------------------------------------------------
  { name: 'central valley', t: T.FARMLAND, test: (lon, lat) => between(lat, 35, 40.5) && between(lon, -122.5, -118.5) },
  { name: 'corn belt', t: T.FARMLAND, test: (lon, lat) => between(lat, 37.5, 45) && between(lon, -99, -83) },
  { name: 'columbia basin', t: T.FARMLAND, test: (lon, lat) => between(lat, 45, 48.5) && between(lon, -121, -117) },
  { name: 'delta farmland', t: T.FARMLAND, test: (lon, lat) => between(lat, 32, 37) && between(lon, -95, -89) },

  // --- Plains ---------------------------------------------------------------
  { name: 'high plains', t: T.TALLGRASS, test: (lon, lat) => between(lon, -105, -96) },
  { name: 'northern plains', t: T.TALLGRASS, test: (lon, lat) => lat > 44 && between(lon, -104, -95) },
];

/** Stable per-tile pseudo-random value in [0,1). Mirrors src/tiles.js. */
function noise(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

async function main() {
  const map = JSON.parse(await readFile(join(DATA, 'map.json'), 'utf8'));
  const topo = JSON.parse(await readFile(ATLAS, 'utf8'));
  const nation = feature(topo, topo.objects.nation);

  const RW = TILES_W * SS;
  const RH = TILES_H * SS;
  const projection = geoAlbersUsa().fitSize([RW, RH], nation);

  const terrain = new Uint8Array(map.assoc.length);
  const tally = new Map();
  let unprojectable = 0;

  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const i = ty * map.width + tx;
      if (map.assoc[i] < 0) { terrain[i] = T.WATER; continue; }

      // Jitter the sample point so zone boundaries interlock raggedly instead
      // of meeting along straight lines, which is what sells them as routes.
      // Kept modest: large jitter reads as organic on a continental view but as
      // scattered noise at the zoom the player actually walks around in.
      const jx = (noise(tx, ty) - 0.5) * 0.9;
      const jy = (noise(tx + 7919, ty - 104729) - 0.5) * 0.9;
      const p = projection.invert([(tx + 0.5) * SS, (ty + 0.5) * SS]);

      if (!p || !Number.isFinite(p[0])) {
        // Puerto Rico is drawn with its own projection, so it does not invert
        // here. It is tropical: treat it as wetland.
        terrain[i] = T.WETLAND;
        unprojectable++;
        continue;
      }

      const lon = p[0] + jx;
      const lat = p[1] + jy;
      const rule = RULES.find((r) => r.test(lon, lat));
      terrain[i] = rule ? rule.t : T.FARMLAND;
      tally.set(rule?.name ?? 'default farmland', (tally.get(rule?.name ?? 'default farmland') ?? 0) + 1);
    }
  }

  // --- Smooth into coherent zones -------------------------------------------
  // Rule boundaries plus jitter leave isolated single tiles, which read as noise
  // rather than landscape. A couple of majority passes over the 8-neighbourhood
  // consolidate them into blobs while keeping the edges ragged.
  const SMOOTH_PASSES = 2;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const src = terrain.slice();
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const i = ty * map.width + tx;
        if (map.assoc[i] < 0) continue;

        const votes = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            const k = ny * map.width + nx;
            if (map.assoc[k] < 0) continue; // do not let the sea vote
            votes.set(src[k], (votes.get(src[k]) ?? 0) + 1);
          }
        }
        let best = src[i];
        let bestN = votes.get(best) ?? 0;
        for (const [t, n] of votes) if (n > bestN) { best = t; bestN = n; }
        terrain[i] = best;
      }
    }
  }

  map.terrain = [...terrain];
  await writeFile(join(DATA, 'map.json'), JSON.stringify(map));

  // Debug render, using the same palette the browser does.
  const PALETTE = [
    [27, 43, 77], [200, 166, 81], [90, 160, 74], [47, 107, 60],
    [217, 182, 120], [79, 143, 122], [138, 128, 115],
  ];
  const img = gridToRGBA(terrain, map.width, map.height, 4, (t) => [...PALETTE[t], 255]);
  await writeFile(
    join(DATA, 'reports', 'terrain-debug.png'),
    encodePNG(img.width, img.height, img.rgba)
  );

  const counts = new Array(NAMES.length).fill(0);
  for (const t of terrain) counts[t]++;
  const land = terrain.filter((t) => t !== T.WATER).length;

  console.log(`Seeded terrain for ${land} land tiles`);
  for (const [i, n] of counts.entries()) {
    if (i === T.WATER || !n) continue;
    console.log(`  ${NAMES[i].padEnd(10)} ${String(n).padStart(5)}  ${((n / land) * 100).toFixed(1)}%`);
  }
  if (unprojectable) console.log(`  (${unprojectable} island tiles defaulted to wetland)`);
  console.log(`\nWrote data/map.json. Hand-tune with tools/terrain-painter.html.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
