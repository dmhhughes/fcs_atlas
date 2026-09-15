/**
 * Map and navigation tests.
 *
 * Drives the real GameMap and navigation code over the built data. These are
 * the failure modes that inspecting the picture cannot catch: territories that
 * cannot be hit with a mouse, territories no sequence of arrow keys can reach,
 * and associations missing from the directory listing.
 *
 * Run: npm test
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const { GameMap } = await import('../src/map.js');
const { neighborInDirection, nearestRegion, DIRECTIONS } = await import('../src/navigate.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const mapData = JSON.parse(await readFile(join(DATA, 'map.json'), 'utf8'));
const { associations, banks } = JSON.parse(
  await readFile(join(DATA, 'directory.web.json'), 'utf8')
);
const map = new GameMap(mapData, associations);

console.log(`Map ${map.width}x${map.height}, ${associations.length} associations, ${banks.length} banks\n`);

// --- 1. Region geometry ------------------------------------------------------
let before = failures.length;
const seenAnchors = new Set();

for (const region of map.regions) {
  if (!region) { check(false, 'a region is missing entirely'); continue; }
  const name = associations[region.index]?.name ?? 'unknown';
  const [x, y] = region.anchor;

  check(map.isLand(x, y), `${name}: anchor (${x},${y}) is ocean`);
  check(
    map.assocAt(x, y) === region.index,
    `${name}: anchor sits on ${associations[map.assocAt(x, y)]?.name ?? 'ocean'}, not its own territory`
  );
  check(!seenAnchors.has(`${x},${y}`), `${name}: anchor shares a tile with another region`);
  seenAnchors.add(`${x},${y}`);

  // Precomputed geometry must exist, or the region cannot be highlighted.
  check(map.runs.get(region.index)?.length > 0, `${name}: no fill runs`);
  check(map.outlines.get(region.index)?.length > 0, `${name}: no outline segments`);
}
console.log(`1. region geometry         ${failures.length === before ? 'ok' : 'FAIL'} (${map.regions.length} regions)`);

// --- 2. Fill runs cover exactly the region ----------------------------------
before = failures.length;
{
  const counted = new Map();
  for (const [index, runs] of map.runs) {
    let n = 0;
    for (let k = 0; k < runs.length; k += 3) n += runs[k + 1] - runs[k] + 1;
    counted.set(index, n);
  }
  const actual = new Map();
  for (const v of map.assoc) if (v >= 0) actual.set(v, (actual.get(v) ?? 0) + 1);

  for (const [index, n] of actual) {
    check(
      counted.get(index) === n,
      `${associations[index].name}: fill runs cover ${counted.get(index)} tiles, region has ${n}`
    );
  }
}
console.log(`2. fill run coverage       ${failures.length === before ? 'ok' : 'FAIL'}`);

// --- 3. Mouse hit testing ----------------------------------------------------
// Every region must be clickable: its anchor, in world pixels, must hit-test
// back to itself through the same path a pointer event takes.
before = failures.length;
for (const region of map.regions.filter(Boolean)) {
  const [wx, wy] = map.anchorWorld(region.index);
  const hit = map.regionAtWorld(wx, wy);
  check(
    hit === region.index,
    `${associations[region.index].name}: anchor hit-tests to ${hit >= 0 ? associations[hit].name : 'ocean'}`
  );
}
console.log(`3. pointer hit testing     ${failures.length === before ? 'ok' : 'FAIL'}`);

// --- 4. Keyboard reachability ------------------------------------------------
// Arrow keys must be able to get from the starting region to every other one.
// A region that no direction ever selects is invisible to keyboard users.
before = failures.length;
const anchors = new Map();
for (const r of map.regions) if (r) anchors.set(r.index, map.anchorWorld(r.index));

const start = nearestRegion(anchors, map.worldWidth / 2, map.worldHeight / 2);
const reached = new Set([start]);
const queue = [start];
while (queue.length) {
  const from = queue.shift();
  for (const dir of Object.keys(DIRECTIONS)) {
    const next = neighborInDirection(anchors, from, dir);
    if (next === null || reached.has(next)) continue;
    reached.add(next);
    queue.push(next);
  }
}
const stranded = [...anchors.keys()].filter((i) => !reached.has(i));
check(
  stranded.length === 0,
  `unreachable by arrow keys: ${stranded.map((i) => associations[i].name).join(', ')}`
);
console.log(
  `4. keyboard reachability   ${stranded.length === 0 ? 'ok' : 'FAIL'} ` +
    `(${reached.size}/${anchors.size} from ${associations[start].name})`
);

// Moving in a direction and back should not land somewhere absurd; check that
// every direction from every region either yields nothing or yields a region
// genuinely on that side.
before = failures.length;
let wrongSide = 0;
for (const [index, at] of anchors) {
  for (const [dir, [dx, dy]] of Object.entries(DIRECTIONS)) {
    const next = neighborInDirection(anchors, index, dir);
    if (next === null) continue;
    const to = anchors.get(next);
    if ((to[0] - at[0]) * dx + (to[1] - at[1]) * dy <= 0) wrongSide++;
  }
}
check(wrongSide === 0, `${wrongSide} navigation moves went the wrong way`);
console.log(`5. navigation direction    ${wrongSide === 0 ? 'ok' : 'FAIL'}`);

// --- 6. Directory grouping ---------------------------------------------------
before = failures.length;
const districts = new Set(banks.map((b) => b.district));
check(banks.length === 4, `expected 4 district banks, found ${banks.length}`);

const grouped = new Map();
for (const a of associations) {
  check(districts.has(a.district), `${a.name}: district "${a.district}" has no bank`);
  grouped.set(a.district, (grouped.get(a.district) ?? 0) + 1);
}
const total = [...grouped.values()].reduce((s, n) => s + n, 0);
check(total === associations.length, `grouping covers ${total} of ${associations.length} associations`);

const onMap = new Set(map.regions.filter(Boolean).map((r) => r.uninum));
const missing = associations.filter((a) => !onMap.has(a.uninum));
check(missing.length === 0, `${missing.length} associations are listed but not drawn`);

console.log(
  `6. directory grouping      ${failures.length === before ? 'ok' : 'FAIL'} ` +
    `(${[...grouped].map(([d, n]) => `${d}:${n}`).join(' ')})`
);

// --- 7. Page must not scroll on selection ------------------------------------
// Selecting a territory used to jerk the page down to the directory. There is no
// DOM in this harness, so these are source-level invariants - crude, but they
// pin down the exact three causes rather than letting the bug come back a third
// time. Each maps to a real regression: a scrollIntoView in the list-highlight
// path, a focus() call without preventScroll, and an arrow-key handler bound to
// the canvas, which leaves the browser to scroll whenever the canvas is unfocused.
before = failures.length;
{
  const src = await readFile(join(HERE, '..', 'src', 'main.js'), 'utf8');

  const highlight = src.match(/function highlightListItem[\s\S]*?\n}/)?.[0] ?? '';
  check(highlight.length > 0, 'highlightListItem not found in main.js');
  check(
    !highlight.includes('scrollIntoView'),
    'highlightListItem scrolls the page when a territory is selected'
  );

  for (const m of src.matchAll(/canvas\.focus\(([^)]*)\)/g)) {
    check(
      m[1].includes('preventScroll'),
      `canvas.focus(${m[1]}) will scroll the page; pass { preventScroll: true }`
    );
  }

  check(
    /window\.addEventListener\('keydown'/.test(src),
    'arrow keys must be handled on window, or the page scrolls while the canvas is unfocused'
  );
  check(
    !/canvas\.addEventListener\('keydown'/.test(src),
    'a canvas-bound keydown handler cannot preventDefault unless the canvas has focus'
  );

  const handler = src.match(/window\.addEventListener\('keydown'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  check(handler.includes('preventDefault'), 'arrow-key handler does not call preventDefault');
}
console.log(`7. no scroll on selection  ${failures.length === before ? 'ok' : 'FAIL'}`);

// --- 8. Territory parse regressions ------------------------------------------
// Boundary prose names counties it does not grant, and each county below was
// once parsed as a grant - confirmed against the FCA's own territory maps. The
// controls beside them are genuine grants the same rules could over-correct.
before = failures.length;
{
  const full = JSON.parse(await readFile(join(DATA, 'associations.json'), 'utf8'));
  const byUninum = new Map(full.map((a) => [a.uninum, a]));
  const has = (uninum, fips) => byUninum.get(uninum)?.counties.includes(fips);
  const nameOf = (uninum) => byUninum.get(uninum)?.name ?? uninum;

  const NOT_GRANTED = [
    [810586, '48387', 'Red River, TX', '"the Prairie Dog Town Fork of the Red River"'],
    [725031, '16049', 'Idaho County, ID', '"Twin Falls County, Idaho, thence"'],
    [725031, '16021', 'Boundary, ID', '"the north boundary line"'],
    [725466, '06045', 'Mendocino, CA', '"the Mendocino-Glenn County line"'],
    [725466, '06007', 'Butte, CA', '"the Butte City-Oroville Highway"'],
    [725355, '06071', 'San Bernardino, CA', '"San Bernardino Base and Meridian"'],
  ];
  for (const [uninum, fips, county, source] of NOT_GRANTED) {
    check(!has(uninum, fips), `${nameOf(uninum)}: ${county} parsed as a grant from ${source}`);
  }

  const GRANTED = [
    [725466, '06011', 'Colusa, CA'],
    [725466, '06021', 'Glenn, CA'],
    [725031, '16083', 'Twin Falls, ID'],
    [725031, '16073', 'Owyhee, ID'],
    [710454, '48387', 'Red River, TX'],
    [710812, '48387', 'Red River, TX'],
    [710981, '22081', 'Red River Parish, LA'],
    [725355, '06093', 'Siskiyou, CA'],
    [725355, '06049', 'Modoc, CA'],
    [720376, '12086', 'Miami-Dade, FL'],
    [725203, '06071', 'San Bernardino, CA'],
  ];
  for (const [uninum, fips, county] of GRANTED) {
    check(has(uninum, fips), `${nameOf(uninum)}: lost ${county}`);
  }

  // "in all counties, the lending authorities granted under Title I" is statewide.
  const nm = byUninum.get(725203)?.counties.filter((f) => f.startsWith('35')).length;
  check(nm === 33, `American AgCredit: ${nm} of New Mexico's 33 counties, expected all`);
}
console.log(`8. territory regressions   ${failures.length === before ? 'ok' : 'FAIL'}`);

// --- Result ------------------------------------------------------------------
console.log();
if (failures.length) {
  console.log(`FAILED (${failures.length})`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All checks passed.');
