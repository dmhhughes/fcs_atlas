/**
 * Step 3 - Rasterise association territories into the tile grid.
 *
 * Input:  data/associations.json, us-atlas counties
 * Output: data/map.json, data/reports/map-debug.png, data/reports/regions.md
 *
 * Pipeline: project counties -> supersampled id raster -> majority-vote downsample
 * -> guarantee every association is reachable -> despeckle -> place signposts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feature } from 'topojson-client';
import { geoAlbersUsa, geoConicEqualArea, geoCentroid, geoGraticule, geoPath } from 'd3-geo';
import { rasterizeGeometry, downsampleMajority, downsampleAny } from './lib/raster.mjs';
import { encodePNG, gridToRGBA } from './lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const REPORTS = join(DATA, 'reports');
const ATLAS = join(HERE, '..', 'node_modules', 'us-atlas', 'counties-10m.json');

import { TILES_W, TILES_H, TILE_SIZE, SS, MIN_TILES } from './lib/config.mjs';

// Puerto Rico sits outside geoAlbersUsa entirely. Rather than adopt a composite
// projection for a single association, it is drawn with its own equal-area
// projection and placed as an island in open ocean, which suits the genre as
// well as it suits the geography. The slot is searched for rather than
// hard-coded, so the island can never land on top of the mainland.
// Kept narrow enough to fit the Atlantic gap east of Florida rather than being
// pushed west into the Gulf, and to stay proportionate to the other regions.
const PR_SIZE = { w: 17, h: 8 }; // tiles

/**
 * Find an empty box of `boxW` x `boxH` raster pixels, preferring the bottom-right
 * so Puerto Rico stays south-east of Florida. Uses a summed-area table so each
 * candidate is an O(1) test.
 */
function findEmptyBox(raster, W, H, boxW, boxH, margin) {
  const sat = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      sat[(y + 1) * (W + 1) + x + 1] =
        (raster[y * W + x] ? 1 : 0) +
        sat[y * (W + 1) + x + 1] +
        sat[(y + 1) * (W + 1) + x] -
        sat[y * (W + 1) + x];
    }
  }
  const occupied = (x, y, w, h) =>
    sat[(y + h) * (W + 1) + x + w] - sat[y * (W + 1) + x + w] -
    sat[(y + h) * (W + 1) + x] + sat[y * (W + 1) + x];

  const padW = boxW + margin * 2;
  const padH = boxH + margin * 2;
  for (let y = H - padH; y >= 0; y -= 2) {
    for (let x = W - padW; x >= 0; x -= 2) {
      if (occupied(x, y, padW, padH) === 0) return [x + margin, y + margin];
    }
  }
  return null;
}

async function main() {
  await mkdir(REPORTS, { recursive: true });

  const associations = JSON.parse(await readFile(join(DATA, 'associations.json'), 'utf8'));
  const topo = JSON.parse(await readFile(ATLAS, 'utf8'));
  const counties = feature(topo, topo.objects.counties).features;
  const nation = feature(topo, topo.objects.nation);

  // Region ids are 1-based in the raster so that 0 can mean "ocean".
  const indexOf = new Map(associations.map((a, i) => [a.uninum, i]));
  const ownerFips = new Map();
  for (const a of associations) {
    for (const f of a.ownedCounties) ownerFips.set(f, indexOf.get(a.uninum) + 1);
  }

  const RW = TILES_W * SS;
  const RH = TILES_H * SS;
  const raster = new Uint16Array(RW * RH);

  // --- Projections ---------------------------------------------------------
  const mainland = geoAlbersUsa().fitSize([RW, RH], nation);
  const isPR = (fips) => fips.startsWith('72');

  // --- Rasterise the mainland (plus the Alaska and Hawaii insets) -----------
  // Every county is drawn into a land mask, whether chartered or not. Without
  // it, land belonging to no association is indistinguishable from sea, and
  // holes in the map look like coastline.
  const landRaster = new Uint8Array(RW * RH);
  let painted = 0;
  for (const c of counties) {
    const fips = String(c.id).padStart(5, '0');
    if (isPR(fips)) continue; // handled as an island below
    const id = ownerFips.get(fips);
    rasterizeGeometry(c.geometry, mainland, RW, RH, (x, y) => {
      const k = y * RW + x;
      landRaster[k] = 1;
      if (id) raster[k] = id;
    });
    if (id) painted++;
  }

  // --- Place Puerto Rico in whatever ocean is actually free ------------------
  const prFeatures = counties.filter((c) => isPR(String(c.id).padStart(5, '0')));
  const boxW = PR_SIZE.w * SS;
  const boxH = PR_SIZE.h * SS;
  const slot = findEmptyBox(raster, RW, RH, boxW, boxH, SS * 2);
  let prShifted = null;
  if (!slot) {
    console.warn('  !! no free ocean found for Puerto Rico; it will be omitted');
  } else {
    const prProj = geoConicEqualArea()
      .parallels([17.9, 18.5])
      .rotate([66.4, 0])
      .fitSize([boxW, boxH], { type: 'FeatureCollection', features: prFeatures });
    prShifted = (pt) => {
      const p = prProj(pt);
      return p ? [p[0] + slot[0], p[1] + slot[1]] : null;
    };
    for (const c of prFeatures) {
      const id = ownerFips.get(String(c.id).padStart(5, '0'));
      if (!id) continue;
      rasterizeGeometry(c.geometry, prShifted, RW, RH, (x, y) => {
        const k = y * RW + x;
        landRaster[k] = 1;
        raster[k] = id;
      });
      painted++;
    }
    console.log(
      `  Puerto Rico placed at tile (${Math.round(slot[0] / SS)}, ${Math.round(slot[1] / SS)})`
    );
  }
  console.log(`Rasterised ${painted} chartered counties at ${RW}x${RH} (${SS}x supersample)`);

  // --- Downsample ----------------------------------------------------------
  const { grid } = downsampleMajority(raster, RW, RH, SS);
  const { grid: land } = downsampleAny(landRaster, RW, RH, SS);
  const W = TILES_W;
  const H = TILES_H;

  // --- Close holes in the land ---------------------------------------------
  // Some county-equivalents belong to no association: Virginia's 38 independent
  // cities, Baltimore City, St. Louis City, the District of Columbia. They sit
  // inside territory that IS served, so leaving them unassigned punches holes
  // that render as sea. Small pockets are absorbed by their surroundings; a
  // large one means a real parsing failure and is reported rather than smoothed
  // over, which is how an entire missing Arizona would announce itself.
  const MAX_ENCLAVE = 24;
  const gaps = [];
  {
    const seen = new Uint8Array(W * H);
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== 0 || !land[i] || seen[i]) continue;

      const component = [];
      const queue = [i];
      seen[i] = 1;
      while (queue.length) {
        const k = queue.pop();
        component.push(k);
        const x = k % W;
        const y = (k / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (seen[n] || grid[n] !== 0 || !land[n]) continue;
          seen[n] = 1;
          queue.push(n);
        }
      }
      gaps.push(component);
    }

    let filled = 0;
    for (const component of gaps) {
      if (component.length > MAX_ENCLAVE) continue;
      // Repeatedly take the most common assigned neighbour until the pocket
      // is closed; pockets are a handful of tiles, so this settles at once.
      let pending = component;
      for (let pass = 0; pass < MAX_ENCLAVE && pending.length; pass++) {
        const next = [];
        for (const k of pending) {
          const votes = new Map();
          const x = k % W;
          const y = (k / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const v = grid[ny * W + nx];
            if (v) votes.set(v, (votes.get(v) ?? 0) + 1);
          }
          if (!votes.size) { next.push(k); continue; }
          let best = 0;
          let bestN = 0;
          for (const [v, n] of votes) if (n > bestN || (n === bestN && v < best)) { best = v; bestN = n; }
          grid[k] = best;
          filled++;
        }
        if (next.length === pending.length) break; // no progress
        pending = next;
      }
    }

    const large = gaps.filter((c) => c.length > MAX_ENCLAVE);
    console.log(`  land with no association: ${gaps.reduce((n, c) => n + c.length, 0)} tiles ` +
      `in ${gaps.length} pockets -> filled ${filled}`);
    if (large.length) {
      console.log(`  !! ${large.length} LARGE unassigned area(s), biggest ${Math.max(...large.map((c) => c.length))} tiles`);
      console.log(`     This is a territory parsing gap, not a coastline. Check data/reports/unmatched.md.`);
    }
  }

  const tileCount = () => {
    const n = new Array(associations.length + 1).fill(0);
    for (let i = 0; i < grid.length; i++) n[grid[i]]++;
    return n;
  };

  // --- Reachability: every association must own walkable tiles --------------
  const notes = [];
  const fipsToTiles = new Map(); // built lazily for HQ seeding
  {
    // Which tile does each county sit on? The spherical centroid is projected
    // through the same projection used to draw it, so seeds stay geographically
    // honest. (geoPath is not usable here: the Puerto Rico projection is a plain
    // function rather than a projection object with a .stream method.)
    for (const c of counties) {
      const fips = String(c.id).padStart(5, '0');
      const projection = isPR(fips) ? prShifted : mainland;
      if (!projection) continue;
      const p = projection(geoCentroid(c));
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      fipsToTiles.set(fips, [
        Math.min(W - 1, Math.max(0, Math.floor(p[0] / SS))),
        Math.min(H - 1, Math.max(0, Math.floor(p[1] / SS))),
      ]);
    }
  }

  /** Grow region `id` outward from a seed until it holds `target` tiles. */
  function growRegion(id, seed, target, counts) {
    const [sx, sy] = seed;
    // Breadth-first over land tiles, converting the largest neighbours first.
    const queue = [[sx, sy]];
    const seen = new Set([sy * W + sx]);
    let gained = 0;
    const taken = [];

    while (queue.length && counts[id] + gained < target) {
      const [x, y] = queue.shift();
      const i = y * W + x;
      const cur = grid[i];
      if (cur !== id && cur !== 0) {
        // Never strip a donor below the floor it is itself entitled to.
        if (counts[cur] - 1 >= MIN_TILES) {
          grid[i] = id;
          counts[cur]--;
          gained++;
          taken.push(cur);
        }
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (seen.has(k) || grid[k] === 0) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    counts[id] += gained;
    return { gained, donors: [...new Set(taken)] };
  }

  let counts = tileCount();
  for (const [i, a] of associations.entries()) {
    const id = i + 1;
    if (counts[id] >= MIN_TILES) continue;

    // Seed at the headquarters county when we know it, else at the territory's
    // own centroid. First South Farm Credit is the reason this exists: it is
    // chartered across all of Alabama and Mississippi but loses every tile to
    // the smaller associations layered inside it.
    let seed = a.hq.fips ? fipsToTiles.get(a.hq.fips) : null;
    if (!seed) {
      const anchor = a.counties.map((f) => fipsToTiles.get(f)).filter(Boolean);
      if (anchor.length) {
        seed = [
          Math.round(anchor.reduce((s, p) => s + p[0], 0) / anchor.length),
          Math.round(anchor.reduce((s, p) => s + p[1], 0) / anchor.length),
        ];
      }
    }
    if (!seed) {
      notes.push(`- **${a.name}** has ${counts[id]} tiles and no usable seed; left as is.`);
      continue;
    }

    const before = counts[id];
    const { gained, donors } = growRegion(id, seed, MIN_TILES, counts);
    notes.push(
      `- **${a.name}**: ${before} -> ${counts[id]} tiles ` +
        `(+${gained} grown from HQ ${a.hq.county || '?'}, ${a.hq.state}` +
        (donors.length ? `, taken from ${donors.map((d) => associations[d - 1].name).join('; ')}` : '') +
        `)`
    );
  }

  // --- Despeckle: remove single-tile islands --------------------------------
  let despeckled = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = grid[i];
      if (!v) continue;
      const neigh = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        neigh.push(grid[ny * W + nx]);
      }
      if (neigh.some((n) => n === v)) continue;
      const land = neigh.filter(Boolean);
      if (land.length) { grid[i] = land[0]; despeckled++; }
    }
  }

  // --- Region stats and signposts -------------------------------------------
  counts = tileCount();
  const regions = [];
  for (const [i, a] of associations.entries()) {
    const id = i + 1;
    const tiles = [];
    for (let k = 0; k < grid.length; k++) if (grid[k] === id) tiles.push(k);
    if (!tiles.length) { regions.push(null); continue; }

    const cx = tiles.reduce((s, k) => s + (k % W), 0) / tiles.length;
    const cy = tiles.reduce((s, k) => s + Math.floor(k / W), 0) / tiles.length;
    // The anchor must sit on a tile the region actually owns, so snap the
    // centroid to the nearest owned tile - centroids of crescent-shaped regions
    // routinely land outside them. It drives keyboard navigation and labelling.
    let best = tiles[0];
    let bestD = Infinity;
    for (const k of tiles) {
      const d = ((k % W) - cx) ** 2 + (Math.floor(k / W) - cy) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    regions.push({
      uninum: a.uninum,
      index: i,
      tileCount: tiles.length,
      anchor: [best % W, Math.floor(best / W)],
    });
  }

  // --- Write ----------------------------------------------------------------
  // assoc[] holds 0-based association indices, -1 for ocean.
  const assoc = new Int16Array(grid.length);
  for (let i = 0; i < grid.length; i++) assoc[i] = grid[i] - 1;

  const landTiles = [...assoc].filter((v) => v >= 0).length;

  // Graticule: real 5-degree lines of latitude and longitude, projected through
  // the same composite projection as the counties, so they bend correctly and
  // appear in the Alaska and Hawaii insets too. Recorded as polylines in world
  // pixels; the browser draws them as dotted lines over the sea only.
  const graticule = [];
  {
    const toWorld = TILE_SIZE / SS;
    let line = null;
    const recorder = {
      beginPath() {},
      moveTo(x, y) { line = [Math.round(x * toWorld), Math.round(y * toWorld)]; graticule.push(line); },
      lineTo(x, y) { line?.push(Math.round(x * toWorld), Math.round(y * toWorld)); },
      closePath() {},
      arc() {},
    };
    geoPath(mainland, recorder)(geoGraticule().step([5, 5])());
  }

  await writeFile(
    join(DATA, 'map.json'),
    JSON.stringify({
      width: W,
      height: H,
      tileSize: TILE_SIZE,
      assoc: [...assoc],
      regions,
      graticule: graticule.filter((l) => l.length >= 4),
    })
  );

  // The browser needs none of the per-county arrays or the verbatim legal text,
  // which together are 80% of associations.json. Ship a slim payload instead,
  // bundled with the four funding banks that the directory list groups by.
  let banks = [];
  try {
    banks = JSON.parse(await readFile(join(DATA, 'banks.raw.json'), 'utf8')).map((b) => ({
      uninum: b.uninum,
      name: b.name,
      district: b.district,
      ceo: b.ceo,
      url: b.url,
      hq: { city: b.hq.city, state: b.hq.state },
    }));
  } catch {
    console.warn('  !! data/banks.raw.json missing - run `npm run fetch` to group by district');
  }

  await writeFile(
    join(DATA, 'directory.web.json'),
    JSON.stringify({
      stats: {
        associations: associations.length,
        banks: banks.length,
        counties: new Set(associations.flatMap((a) => a.ownedCounties)).size,
        states: new Set(associations.flatMap((a) => a.states)).size,
      },
      banks,
      associations: associations.map((a) => ({
        uninum: a.uninum,
        name: a.name,
        district: a.district,
        ceo: a.ceo,
        phone: a.phone,
        url: a.url,
        hq: { city: a.hq.city, state: a.hq.state, county: a.hq.county },
        states: a.states,
        countyCount: a.counties.length,
        sharedWith: a.sharedWith,
        commodity: a.commodity,
      })),
    })
  );

  // --- Debug image ----------------------------------------------------------
  const palette = (id) => {
    if (!id) return [24, 40, 72, 255]; // ocean
    const h = (id * 137.508) % 360;
    const [r, g, b] = hslToRgb(h / 360, 0.55, 0.55);
    return [r, g, b, 255];
  };
  const img = gridToRGBA(grid, W, H, 4, palette);
  await writeFile(join(REPORTS, 'map-debug.png'), encodePNG(img.width, img.height, img.rgba));

  await writeFile(
    join(REPORTS, 'regions.md'),
    `# Tile regions\n\n` +
      `${W}x${H} tiles, ${landTiles} land (${((landTiles / grid.length) * 100).toFixed(1)}%).\n` +
      `Despeckled ${despeckled} orphan tiles.\n\n` +
      `## Regions grown to stay reachable\n\n` +
      (notes.length ? notes.join('\n') : 'None needed.') +
      `\n\n## Tile counts\n\n` +
      regions
        .filter(Boolean)
        .sort((a, b) => a.tileCount - b.tileCount)
        .map((r) => `- ${String(r.tileCount).padStart(4)}  ${associations[r.index].name}`)
        .join('\n') + '\n'
  );

  // --- Summary --------------------------------------------------------------
  const missing = regions.filter((r) => !r);
  const small = regions.filter((r) => r && r.tileCount < MIN_TILES);
  console.log(`Tile grid ${W}x${H}: ${landTiles} land tiles, ${grid.length - landTiles} ocean`);
  console.log(`  regions placed : ${regions.filter(Boolean).length}/${associations.length}`);
  console.log(`  grown for reach: ${notes.length}`);
  console.log(`  despeckled     : ${despeckled}`);
  if (small.length) {
    console.log(`  !! below ${MIN_TILES} tiles: ${small.map((r) => associations[r.index].name).join(', ')}`);
  }
  if (missing.length) {
    console.log(`  !! MISSING ENTIRELY: ${missing.length}`);
    process.exitCode = 1;
  }
  console.log(`\nWrote data/map.json and data/reports/{map-debug.png,regions.md}`);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
