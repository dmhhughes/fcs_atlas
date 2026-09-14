/**
 * Step 1 - Fetch the FCA public directory.
 *
 * Pulls the institution roster, then one detail page (and one territory map PNG)
 * per lending association. Every response is cached under data/raw/, so re-runs
 * cost nothing and the .gov host is hit at most once per file.
 *
 * Output: data/raw/*.html, data/raw/maps/*.png, data/associations.raw.json
 *
 * The detail pages are ASP.NET WebForms with stable control ids
 * (ctl00_cphMainContent_fvInstitution_lblTerritoryDesc and friends), so we select
 * on the id suffix rather than scraping by position.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as cheerio from 'cheerio';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const RAW = join(DATA, 'raw');
const MAPS = join(RAW, 'maps');

const BASE = 'https://apps.fca.gov/FCSPublicDirectory';
const ROSTER_URL = `${BASE}/PubSearchInstitution.aspx`;
const DETAIL_URL = (u) => `${BASE}/PubViewInst.aspx?u=${u}`;
const MAP_URL = (u) => `${BASE}/MapHandler1.ashx?u=${u}`;

// Be a polite guest on a government host: one request at a time, with a pause.
const DELAY_MS = 500;
const UA =
  'fcs_atlas/0.1 (educational map project; +https://github.com/dmhhughes/fcs_atlas)';

/**
 * The directory lists banks and service corporations alongside the associations.
 * Only the associations hold chartered territories, so only they are drawn on
 * the map - but the four funding banks are kept, because every association
 * belongs to one and they make the natural grouping for the directory list.
 */
const FUNDING_BANKS = new Set([
  610000, // Farm Credit Bank of Texas
  620000, // AgFirst Farm Credit Bank
  622000, // AgriBank, FCB
  925000, // CoBank, ACB
]);
// Service corporations (Funding Corp, Farmer Mac, AgVantis, ...) all sit at 2000000+.
const isServiceCorp = (uninum) => uninum >= 2_000_000;
const isAssociation = (uninum) => !FUNDING_BANKS.has(uninum) && !isServiceCorp(uninum);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch `url`, caching the body at `cachePath`. Returns text (or a Buffer if binary). */
async function cached(url, cachePath, { binary = false } = {}) {
  if (existsSync(cachePath)) {
    return binary ? readFile(cachePath) : readFile(cachePath, 'utf8');
  }
  process.stdout.write(`  fetching ${url}\n`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);

  const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  await writeFile(cachePath, body);
  await sleep(DELAY_MS);
  return body;
}

/** Collapse the non-breaking spaces and ragged whitespace that WebForms emits. */
const clean = (s) =>
  (s ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

/** Read an ASP.NET label by the tail of its control id. */
function label($, suffix, { preserveBreaks = false } = {}) {
  const el = $(`[id$="_${suffix}"]`).first();
  if (!el.length) return '';
  if (preserveBreaks) {
    // <br> separates one state's territory clause from the next; keep that structure.
    el.find('br').replaceWith('\n');
  }
  return clean(el.text());
}

/** Parse the roster table into {uninum, name, district, hqState, ceo} rows. */
function parseRoster(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('a[href*="PubViewInst.aspx?u="]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const uninum = Number(href.match(/u=(\d+)/)?.[1]);
    if (!Number.isFinite(uninum)) return;
    if (rows.some((r) => r.uninum === uninum)) return; // page repeats some links

    const cells = $(a).closest('tr').find('td').map((_, td) => clean($(td).text())).get();
    rows.push({
      uninum,
      name: clean($(a).text()),
      district: cells[2] ?? '',
      hqState: cells[3] ?? '',
      ceo: cells[4] ?? '',
    });
  });

  return rows;
}

/** Pull the fields we care about out of one institution detail page. */
function parseDetail(html, rosterRow) {
  const $ = cheerio.load(html);

  const addressRaw = label($, 'lblCharterAddress', { preserveBreaks: true });
  // Last line is "City, ST 12345"; everything before it is the street address.
  const lines = addressRaw.split('\n').map(clean).filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  const m = lastLine.match(/^(.*),\s*([A-Z]{2})\s+([\d-]+)$/);

  return {
    uninum: rosterRow.uninum,
    name: label($, 'lblInstName') || rosterRow.name,
    shortName: label($, 'lblShortName'),
    status: label($, 'lblStatusAndDesc'),
    district: rosterRow.district,
    ceo: label($, 'lblCEO') || rosterRow.ceo,
    chair: label($, 'lblChairman'),
    phone: label($, 'lblPhone'),
    url: $('[id$="_hlWebURL"]').first().attr('href') ?? '',
    hq: {
      address: m ? lines.slice(0, -1).join(', ') : addressRaw.replace(/\n/g, ', '),
      city: m ? clean(m[1]) : '',
      state: m ? m[2] : rosterRow.hqState,
      zip: m ? m[3] : '',
      county: label($, 'lblCharterCounty'),
    },
    charterDate: label($, 'lblCharterDate'),
    charterNumber: label($, 'lblCharterNbr'),
    rssd: label($, 'lblRSSD'),
    // The legally-operative text. Step 2 parses this into county FIPS codes;
    // it is retained verbatim here so the derived map is always auditable.
    territoryText: label($, 'lblTerritoryDesc', { preserveBreaks: true }),
    comment: label($, 'lblComment', { preserveBreaks: true }),
  };
}

async function main() {
  await mkdir(MAPS, { recursive: true });

  console.log('Roster:');
  const rosterHtml = await cached(ROSTER_URL, join(RAW, 'roster.html'));
  const roster = parseRoster(rosterHtml);
  const associations = roster.filter((r) => isAssociation(r.uninum));

  console.log(
    `  ${roster.length} institutions listed -> ${associations.length} lending associations ` +
      `(dropped ${roster.length - associations.length} banks + service corps)`
  );
  if (associations.length < 40 || associations.length > 80) {
    throw new Error(
      `Expected roughly 55 associations, got ${associations.length}. ` +
        `The roster page layout probably changed - check data/raw/roster.html.`
    );
  }

  console.log('Funding banks:');
  const banks = [];
  for (const row of roster.filter((r) => FUNDING_BANKS.has(r.uninum))) {
    const html = await cached(DETAIL_URL(row.uninum), join(RAW, `${row.uninum}.html`));
    banks.push(parseDetail(html, row));
  }
  banks.sort((a, b) => a.district.localeCompare(b.district));
  await writeFile(join(DATA, 'banks.raw.json'), JSON.stringify(banks, null, 2));
  console.log(`  ${banks.length}: ${banks.map((b) => b.district).join(', ')}`);

  console.log('Detail pages:');
  const out = [];
  for (const row of associations) {
    const html = await cached(DETAIL_URL(row.uninum), join(RAW, `${row.uninum}.html`));
    const rec = parseDetail(html, row);

    if (!rec.territoryText) {
      console.warn(`  !! ${row.uninum} ${row.name}: no territory description found`);
    }
    // Ground truth for verifying the step-2 parser by eye.
    await cached(MAP_URL(row.uninum), join(MAPS, `${row.uninum}.png`), { binary: true });

    out.push(rec);
  }

  out.sort((a, b) => a.uninum - b.uninum);
  const target = join(DATA, 'associations.raw.json');
  await writeFile(target, JSON.stringify(out, null, 2));

  const missing = out.filter((r) => !r.territoryText).length;
  console.log(`\nWrote ${out.length} associations -> ${target}`);
  if (missing) console.log(`  ${missing} without territory text (needs investigation)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
