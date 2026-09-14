/**
 * Diagnostic: which land is missing from the map, and why.
 *
 * A county with no association renders with assoc = -1, which is exactly how
 * ocean renders - so unchartered land silently becomes sea. This rasterises
 * ALL counties and compares against the chartered layer to find the holes.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feature } from 'topojson-client';
import { geoAlbersUsa } from 'd3-geo';
import { rasterizeGeometry, downsampleMajority } from './lib/raster.mjs';
import { encodePNG, gridToRGBA } from './lib/png.mjs';
import { TILES_W, TILES_H, SS } from './lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const ATLAS = join(HERE, '..', 'node_modules', 'us-atlas', 'counties-10m.json');

const associations = JSON.parse(await readFile(join(DATA, 'associations.json'), 'utf8'));
const mapJson = JSON.parse(await readFile(join(DATA, 'map.json'), 'utf8'));
const topo = JSON.parse(await readFile(ATLAS, 'utf8'));
const counties = feature(topo, topo.objects.counties).features;
const states = feature(topo, topo.objects.states).features;
const nation = feature(topo, topo.objects.nation);

const stateName = new Map(states.map((s) => [String(s.id).padStart(2, '0'), s.properties.name]));
const chartered = new Set(associations.flatMap((a) => a.counties));

// --- Which counties have no association at all? ------------------------------
const uncovered = counties
  .map((c) => String(c.id).padStart(5, '0'))
  .filter((f) => !chartered.has(f));

const byState = new Map();
for (const f of uncovered) {
  const st = f.slice(0, 2);
  if (!byState.has(st)) byState.set(st, []);
  byState.get(st).push(f);
}

const nameOf = new Map(counties.map((c) => [String(c.id).padStart(5, '0'), c.properties.name]));

console.log(`Counties with no association: ${uncovered.length} of ${counties.length}\n`);
for (const [st, list] of [...byState].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${(stateName.get(st) ?? st).padEnd(28)} ${String(list.length).padStart(3)}  ` +
    list.slice(0, 10).map((f) => nameOf.get(f)).join(', ') + (list.length > 10 ? ', ...' : ''));
}

// --- Rasterise all land, to see what the map is dropping ---------------------
const RW = TILES_W * SS;
const RH = TILES_H * SS;
const projection = geoAlbersUsa().fitSize([RW, RH], nation);

const allLand = new Uint16Array(RW * RH);
let unprojectable = 0;
for (const c of counties) {
  const fips = String(c.id).padStart(5, '0');
  if (fips.startsWith('72')) continue; // Puerto Rico is placed separately
  let painted = false;
  rasterizeGeometry(c.geometry, projection, RW, RH, (x, y) => {
    allLand[y * RW + x] = chartered.has(fips) ? 1 : 2;
    painted = true;
  });
  if (!painted) unprojectable++;
}
console.log(`\nCounties that produced no pixels at all: ${unprojectable}`);

const { grid } = downsampleMajority(allLand, RW, RH, SS);

// Compare against the built map.
let holes = 0;
let charteredButMissing = 0;
for (let i = 0; i < grid.length; i++) {
  const built = mapJson.assoc[i] >= 0;
  if (grid[i] === 2 && !built) holes++;
  if (grid[i] === 1 && !built) charteredButMissing++;
}
console.log(`Tiles that are land but drawn as ocean:`);
console.log(`  unchartered land  : ${holes}`);
console.log(`  chartered but lost: ${charteredButMissing}`);

// --- Render the diagnostic ---------------------------------------------------
const PALETTE = {
  0: [24, 40, 72, 255],    // true ocean
  1: [70, 90, 80, 255],    // chartered land
  2: [235, 60, 140, 255],  // land with NO association - the holes
};
const combined = new Uint8Array(grid.length);
for (let i = 0; i < grid.length; i++) {
  combined[i] = grid[i] === 2 ? 2 : grid[i] === 1 ? 1 : 0;
}
const img = gridToRGBA(combined, TILES_W, TILES_H, 4, (v) => PALETTE[v]);
await writeFile(join(DATA, 'reports', 'coverage-holes.png'), encodePNG(img.width, img.height, img.rgba));
console.log('\nWrote data/reports/coverage-holes.png (pink = land with no association)');
