/**
 * Step 2 - Turn FCA territory descriptions into county FIPS sets.
 *
 * Input:  data/associations.raw.json
 * Output: data/associations.json, data/reports/{unmatched,overlap,notes}.md
 *
 * ---------------------------------------------------------------------------
 * Why this is dictionary-driven rather than grammar-driven
 * ---------------------------------------------------------------------------
 * The 55 descriptions are legal prose with no consistent grammar. Across the
 * corpus we see "the Counties of", "the counties of", "all the Counties of",
 * "all of the counties of", "the counties" (no "of"), "the Parishes of",
 * ":" delimited lists, and multi-state clauses like
 * "In the States of Alabama, Mississippi, Louisiana (except ...)".
 *
 * Trying to parse that grammar is a losing game. Instead we establish which
 * state a clause is scoped to, then match county names against the known
 * dictionary of counties *for that state*. Grammar variance stops mattering.
 *
 * ---------------------------------------------------------------------------
 * Policy: a partially-served county counts as served
 * ---------------------------------------------------------------------------
 * Descriptions carve counties up by township, range, and river ("that portion
 * of Borden County lying east of ..."). At 200x125 tiles a partial county is
 * far below one pixel, so any county mentioned at all is treated as served.
 * Crucially this applies symmetrically to exclusions: "all Counties except San
 * Juan and that portion of Rio Arriba lying west of the Continental Divide"
 * removes San Juan entirely but keeps Rio Arriba, because part of it is served.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feature } from 'topojson-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const REPORTS = join(DATA, 'reports');
const ATLAS = join(HERE, '..', 'node_modules', 'us-atlas', 'counties-10m.json');

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/** Strip diacritics so "Mayagüez" matches "Mayaguez". */
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Build a regex fragment that matches a county name tolerantly:
 *   "De Soto"     also matches "DeSoto"
 *   "St. Francis" also matches "St Francis" / "Saint Francis"
 *   "Queen Anne's" also matches "Queen Annes"
 */
function nameToPattern(name) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const SEP = "[\\s.']*";
  let body = deaccent(name).split(/[\s.']+/).filter(Boolean).map(esc).join(SEP);
  // The atlas writes some names solid ("DeWitt", "DeKalb", "LaMoure", "JoDaviess")
  // where FCA writes them apart ("De Witt", "De Kalb", "La Moure"). Accept either.
  // The uppercase lookahead keeps this off ordinary names like Delaware or Lake.
  body = body.replace(/^(De|La|Le|Mc|Mac|Jo|Van)(?=[A-Z])/, `$1${SEP}`);
  // "St." and "Saint" are used interchangeably in the source text.
  body = body.replace(/^St(?![a-z])/, '(?:St|Saint)');
  return body;
}

/** Levenshtein distance, bailing out as soon as it exceeds `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Geography dictionary
// ---------------------------------------------------------------------------

async function loadGeography() {
  const topo = JSON.parse(await readFile(ATLAS, 'utf8'));
  const counties = feature(topo, topo.objects.counties).features;
  const states = feature(topo, topo.objects.states).features;

  const stateFipsByName = new Map();
  const stateNameByFips = new Map();
  for (const s of states) {
    const fips = String(s.id).padStart(2, '0');
    stateFipsByName.set(deaccent(s.properties.name).toLowerCase(), fips);
    stateNameByFips.set(fips, s.properties.name);
  }

  /** stateFips -> [{fips, name, pattern}], longest name first. */
  const countiesByState = new Map();
  const countyNameByFips = new Map();
  for (const c of counties) {
    const fips = String(c.id).padStart(5, '0');
    const st = fips.slice(0, 2);
    if (!countiesByState.has(st)) countiesByState.set(st, []);
    countiesByState.get(st).push({ fips, name: c.properties.name, pattern: nameToPattern(c.properties.name) });
    countyNameByFips.set(fips, c.properties.name);
  }
  for (const list of countiesByState.values()) {
    // Longest first so "Jefferson Davis" wins over "Jefferson", "Deaf Smith"
    // over "Smith", "Lake of the Woods" over "Lake".
    list.sort((a, b) => b.name.length - a.name.length || a.fips.localeCompare(b.fips));
  }

  // State names longest-first so "West Virginia" is tried before "Virginia".
  const stateNames = [...stateFipsByName.keys()].sort((a, b) => b.length - a.length);

  return { countiesByState, stateFipsByName, stateNameByFips, countyNameByFips, stateNames };
}

/** USPS codes, needed to resolve each association's headquarters county. */
const USPS = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
  ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon',
  PA: 'pennsylvania', PR: 'puerto rico', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};

/**
 * Resolve "Tarrant" + "TX" to 48439. Used as the seed for regions that lose all
 * of their tiles to overlap resolution - growing a region around its real
 * headquarters is more defensible than picking an arbitrary rescue point.
 */
function resolveHqFips(hq, geo) {
  const stateFips = geo.stateFipsByName.get(USPS[hq.state] ?? '');
  if (!stateFips || !hq.county) return null;
  const { fips } = matchCounties(hq.county, stateFips, geo);
  return fips[0] ?? null;
}

// ---------------------------------------------------------------------------
// Clause stripping
// ---------------------------------------------------------------------------

/**
 * Remove clauses that name states without actually granting general territory.
 * These are rare but catastrophic if kept - Horizon Farm Credit's description
 * ends with a clause granting orchardist-only lending across six more states
 * plus Puerto Rico, which would otherwise swallow half the East Coast.
 */
const NARROW_CLAUSES = [
  {
    // "and with respect to the provision of loans to orchardists, all of Puerto Rico, ..."
    re: /(?:;|,)?\s*and\s+with\s+respect\s+to[^.;]*/gi,
    why: 'commodity-specific lending authority, not general chartered territory',
  },
  {
    // "The Association may not exercise any lending authority under Title I ... in the State of New Mexico."
    re: /[^.;]*may\s+not\s+exercise\s+any\s+lending\s+authority[^.]*\.?/gi,
    why: 'restriction sentence that names a state but grants nothing',
  },
];

function stripNarrowClauses(text) {
  const notes = [];
  let out = text;
  for (const { re, why } of NARROW_CLAUSES) {
    out = out.replace(re, (m) => {
      notes.push({ removed: m.trim().replace(/\s+/g, ' '), why });
      return ' ';
    });
  }
  return { text: out, notes };
}

// ---------------------------------------------------------------------------
// Segmentation: split the description into state-scoped clauses
// ---------------------------------------------------------------------------

/**
 * A state name only opens a new scope when introduced by "State(s)/Commonwealth of".
 * This matters: Arkansas has a Mississippi County, Kentucky has an Ohio County,
 * Missouri has a Texas County. Requiring the "State of" preamble keeps those
 * from being mistaken for state scopes.
 */
function segmentByState(text, geo) {
  const stateAlt = geo.stateNames.map((n) => n.replace(/ /g, '\\s+')).join('|');
  const marker = new RegExp(
    String.raw`\b(?:State|States|Commonwealth|Commonwealths)\s+of\s+((?:${stateAlt})(?:\s*(?:,|and|,\s*and)\s*(?:${stateAlt}))*)`,
    'gi'
  );

  /**
   * Metes-and-bounds descriptions reference states as landmarks rather than
   * granting them: Idaho AgCredit's Owyhee County carve-out runs "thence west
   * along the north boundary line of the State of Nevada", which must not be
   * read as a grant of all seventeen Nevada counties.
   */
  const BOUNDARY_REFERENCE = /(?:boundary|border)\s+(?:line\s+)?of\s+the\s+$|\bthence\b[^.;]{0,60}$/i;

  const hits = [];
  for (const m of text.matchAll(marker)) {
    if (BOUNDARY_REFERENCE.test(text.slice(Math.max(0, m.index - 70), m.index))) continue;
    const listText = m[1];
    // Positions are tracked in absolute coordinates over `text`, because except
    // clauses live in the body and have to be compared against state positions
    // in the list. The captured list sits at the tail of the whole match.
    const listStart = m.index + m[0].length - listText.length;
    const states = [];
    const nameRe = new RegExp(`\\b(?:${stateAlt})\\b`, 'gi');
    for (const s of listText.matchAll(nameRe)) {
      const fips = geo.stateFipsByName.get(deaccent(s[0]).toLowerCase().replace(/\s+/g, ' '));
      if (fips) states.push({ fips, at: listStart + s.index });
    }
    if (states.length) {
      hits.push({ start: m.index, bodyStart: m.index + m[0].length, states, listText });
    }
  }

  return hits.map((h, i) => ({
    states: h.states,
    listText: h.listText,
    bodyStart: h.bodyStart,
    // Text preceding the marker decides "all of the State of X" style whole-state grants.
    lead: text.slice(Math.max(0, h.start - 40), h.start),
    body: text.slice(h.bodyStart, i + 1 < hits.length ? hits[i + 1].start : text.length),
  }));
}

// ---------------------------------------------------------------------------
// County matching
// ---------------------------------------------------------------------------

/** Words that turn a county name into the name of a geographic feature. */
const FEATURE_SUFFIX = /^\s+(?:River|Creek|Bay|Mountains?|Range|Meridian|Baseline|Base|Divide)\b/i;

/** "in all counties," - a statewide grant, unlike "all of the counties of X, Y". */
const ALL_COUNTIES = /\ball\s+counties\b(?!\s+(?:of|in)\b)/i;

/**
 * Is this mention of a county a landmark in boundary prose rather than a grant?
 * Each case below once added a county to a territory that does not include it.
 * Skipping is safe because a county that really is granted is named somewhere
 * else in the clause too: AgHeritage keeps White County despite "the White
 * River", and AgWest keeps Siskiyou despite "the Modoc-Siskiyou County line".
 */
function isLandmark(hay, from, to, countyName, stateName) {
  const before = hay.slice(Math.max(0, from - 12), from);
  const after = hay.slice(to, to + 20);
  const namesFeature = FEATURE_SUFFIX.test(' ' + countyName.split(/\s+/).pop());

  // Legal text capitalises county names: "the north boundary line" is not Boundary County, Idaho.
  if (!/[A-Z]/.test(hay[from])) return true;
  // "the South Canadian River", "San Bernardino Base and Meridian".
  if (FEATURE_SUFFIX.test(after) && !namesFeature) return true;
  // The converse: "the Prairie Dog Town Fork of the Red River" is the river, not Red River County, Texas.
  if (namesFeature && /\bthe\s+$/i.test(before)) return true;
  // Hyphenated boundaries and place names: "the Mendocino-Glenn County line", "the
  // Glenn-Butte County line", "the Butte City-Oroville Highway". Hyphenated county
  // names (Miami-Dade) are matched whole, so they never reach this test.
  if (/[A-Za-z]-$/.test(before) || /^(?:\s+[A-Z][a-z]+)?-[A-Z]/.test(after)) return true;
  // "Twin Falls County, Idaho, thence" names the state, not Idaho County.
  if (countyName === stateName && /\bCount(?:y|ies),\s*$/i.test(before)) return true;
  return false;
}

/**
 * Find every county of `stateFips` named in `text`.
 * Longest names are matched first and their character spans consumed, so
 * "Jefferson Davis" is not also counted as "Jefferson".
 */
function matchCounties(text, stateFips, geo) {
  const list = geo.countiesByState.get(stateFips) ?? [];
  const stateName = geo.stateNameByFips.get(stateFips);
  const hay = deaccent(text);
  const consumed = new Array(hay.length).fill(false);
  const found = new Map(); // name -> fips (dedup by name for city/county collisions)

  for (const c of list) {
    const re = new RegExp(`\\b${c.pattern}\\b`, 'gi');
    for (const m of hay.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      let overlaps = false;
      for (let i = from; i < to; i++) if (consumed[i]) { overlaps = true; break; }
      if (overlaps) continue;

      // Boundary descriptions cite counties, rivers and meridians constantly:
      // "the South Canadian River" would otherwise add Canadian County,
      // Oklahoma to a territory that never mentions it.
      if (isLandmark(hay, from, to, c.name, stateName)) continue;

      for (let i = from; i < to; i++) consumed[i] = true;

      // Virginia independent cities share names with their surrounding county
      // (Fairfax, Franklin, Richmond, Roanoke), as do Baltimore MD and St. Louis MO.
      // Counties always hold the lower FIPS; prefer them. The cities are far
      // below one tile in size, so this cannot affect the rendered map.
      const prev = found.get(c.name);
      if (prev === undefined || c.fips < prev) found.set(c.name, c.fips);
    }
  }

  // Whatever text was not consumed by a county match - used to detect parse misses.
  const leftoverOf = () => {
    let s = '';
    for (let i = 0; i < hay.length; i++) s += consumed[i] ? ' ' : hay[i];
    return s;
  };

  // Second pass: the FCA text contains genuine misspellings ("Green" for Greene,
  // "Autaugo" for Autauga, "Mechlenburg" for Mecklenburg, "Loraine" for Lorain).
  // Recover them by near-miss against this state's counties only. The threshold
  // is a single edit on names of 5+ characters, which is tight enough to reject
  // coincidences like "Denison" (a railroad in a survey description) -> "Denton",
  // and every correction is reported so the guesses stay auditable.
  const corrections = [];
  const taken = new Set(found.values());
  for (const tok of suspiciousLeftovers(leftoverOf())) {
    const norm = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (norm.length < 5) continue;
    // Exactly one edit. An exact name left over is one the first pass skipped
    // on purpose as a landmark ("the Mendocino-Glenn County line"); treating it
    // as a typo of itself would put the county straight back.
    const hit = list.find(
      (c) => !taken.has(c.fips) && editDistance(norm, c.name.toLowerCase().replace(/[^a-z]/g, ''), 1) === 1
    );
    if (!hit) continue;

    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    for (const m of hay.matchAll(re)) {
      for (let i = m.index; i < m.index + m[0].length; i++) consumed[i] = true;
    }
    found.set(hit.name, hit.fips);
    taken.add(hit.fips);
    corrections.push({ from: tok, to: hit.name, fips: hit.fips });
  }

  return { fips: [...found.values()], leftover: leftoverOf(), corrections };
}

/** Words that may legitimately appear capitalised without being a missed county. */
const LEFTOVER_STOPWORDS = new Set(
  `in the of and or state states commonwealth commonwealths county counties parish parishes
   city cities all portion portions part parts that those lying north south east west
   line block blocks township townships range ranges river continental divide except for
   inclusive thence along same to below cap rock association its subsidiaries shall be
   following territory continuing entire with respect provision loans a an and/or
   valley known as area areas boundary boundaries mile miles`
    .split(/\s+/)
    .filter(Boolean)
);

/** Look for capitalised words we failed to consume - a sign the parser missed a county. */
function suspiciousLeftovers(leftover) {
  const out = new Set();
  for (const m of leftover.matchAll(/\b[A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+)?\b/g)) {
    const tok = m[0].trim();
    const words = tok.toLowerCase().split(/\s+/);
    if (words.every((w) => LEFTOVER_STOPWORDS.has(w))) continue;
    if (/^(T\d|R\d)/i.test(tok)) continue; // township/range designators
    out.add(tok);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// "except" handling
// ---------------------------------------------------------------------------

/** An except clause that carves up a county rather than removing whole ones. */
const SUBCOUNTY_EXCEPT =
  /^\s*(?:for\s+)?(?:those\s+portions?|that\s+portion|that\s+part|the\s+portion|Township|Townships|T\d)/i;

/**
 * Split a clause body into the part that grants territory and the parts that
 * remove whole counties. Sub-county carve-outs are folded back into the grant,
 * because a partially-excepted county is still partially served.
 */
function splitExcepts(body) {
  const parts = body.split(/\bexcept\b/i);
  let include = parts[0];
  const partialAdds = []; // counties only partly excepted, so still served
  const excludes = [];

  for (let i = 1; i < parts.length; i++) {
    const rest = parts[i];
    if (SUBCOUNTY_EXCEPT.test(rest)) {
      // A carve-out of a county, not a removal of whole ones. Any county it
      // names is still partly served, so it is recorded as a partial add - but
      // deliberately NOT folded into `include`. Folding it in is what made
      // "all of the state of Arizona, except for those portions of Mohave and
      // Coconino Counties north of the Colorado River" read as a two-county
      // list for Arizona, silently dropping thirteen counties from the map.
      //
      // Only the carve-out itself is diverted; whatever follows it is grant
      // text again, as in "Elbert (except Townships 11S-13S), Garfield, ...".
      const stop = rest.search(/[;.)]/);
      partialAdds.push(stop === -1 ? rest : rest.slice(0, stop));
      if (stop !== -1) include += ' ' + rest.slice(stop + 1);
      continue;
    }
    // A whole-county exclusion runs until the clause ends.
    const stop = rest.search(/[;.)]/);
    let exclusion = stop === -1 ? rest : rest.slice(0, stop);
    // "...and Webster, and that part of Ouachita Parish west of the river"
    // - Ouachita is only partly excepted, so it stays served. This is kept apart
    // from `include` deliberately: it is a carve-out of an exclusion, not a grant,
    // and letting it into `include` would make a whole-state clause such as
    // "the States of Alabama, Mississippi, Louisiana (except ...)" look like a
    // one-county list for Louisiana.
    const partial = exclusion.search(/\band that (?:portion|part) of\b/i);
    if (partial !== -1) {
      partialAdds.push(exclusion.slice(partial));
      exclusion = exclusion.slice(0, partial);
    }
    excludes.push({ text: exclusion, at: body.indexOf(rest) });
    if (stop !== -1) include += ' ' + rest.slice(stop);
  }

  return { include, partialAdds: partialAdds.join(' '), excludes };
}

// ---------------------------------------------------------------------------
// Per-association parse
// ---------------------------------------------------------------------------

function parseTerritory(rec, geo) {
  const warnings = [];
  const raw = rec.territoryText.replace(/\s+/g, ' ').trim();
  const { text, notes } = stripNarrowClauses(raw);
  for (const n of notes) warnings.push(`stripped clause (${n.why}): "${n.removed.slice(0, 120)}"`);

  const segments = segmentByState(text, geo);
  if (!segments.length) {
    warnings.push('NO STATE SCOPE FOUND - territory could not be parsed at all');
    return { counties: [], warnings, wholeStates: [] };
  }

  const counties = new Set();
  const wholeStates = [];

  for (const seg of segments) {
    const { include, partialAdds, excludes } = splitExcepts(seg.body);

    for (const st of seg.states) {
      const hit = matchCounties(include, st.fips, geo);
      const stateName = geo.stateNameByFips.get(st.fips);
      const all = geo.countiesByState.get(st.fips) ?? [];

      let granted;
      if (ALL_COUNTIES.test(include)) {
        // "In the State of New Mexico, in all counties, the lending authorities
        // granted under Title I of the Act, and, in the counties of Chaves, ...
        // the lending authorities granted under Title II": a statewide grant that
        // also names counties for a second authority. Naming them must not
        // shrink the grant to those counties, which once cost American AgCredit
        // 21 of New Mexico's 33.
        granted = new Set(all.map((c) => c.fips));
        wholeStates.push(stateName);
      } else if (hit.fips.length > 0) {
        granted = new Set(hit.fips);
      } else {
        // No counties named for this state. Either a whole-state grant, or a
        // parse failure. The distinguishing signal is whether the clause
        // actually introduces a county list ("the Counties of", "Parishes of",
        // or a ":" list). Mere length is not a signal: in a multi-state clause
        // like "the States of Alabama, Mississippi, Louisiana (except for the
        // Parishes of ...)", the body is long but belongs to a sibling state.
        const introducesList =
          /\b(?:count(?:y|ies)|parish(?:es)?|municipios?)\s+of\b/i.test(include) ||
          /:\s*[A-Z]/.test(include);
        if (introducesList) {
          warnings.push(
            `PARSE FAILURE in ${stateName}: clause introduces a county list but matched ` +
              `no known counties: "${include.trim().slice(0, 160)}"`
          );
          continue;
        }
        granted = new Set(all.map((c) => c.fips));
        wholeStates.push(stateName);
      }

      // A county that is only partly excepted is still partly served, so it is
      // added back regardless of which branch produced the grant.
      if (partialAdds) {
        for (const f of matchCounties(partialAdds, st.fips, geo).fips) granted.add(f);
      }

      // Apply exclusions, scoped to the nearest preceding state in a multi-state
      // list: "Alabama, Mississippi, Louisiana (except for the Parishes of ...)"
      // removes parishes from Louisiana only. Both positions are absolute.
      for (const ex of excludes) {
        if (seg.states.length > 1) {
          const exAt = seg.bodyStart + (ex.at ?? 0);
          const holder = [...seg.states].reverse().find((s) => s.at <= exAt) ?? seg.states.at(-1);
          if (holder.fips !== st.fips) continue;
        }
        for (const f of matchCounties(ex.text, st.fips, geo).fips) granted.delete(f);
      }

      for (const f of granted) counties.add(f);

      for (const c of hit.corrections ?? []) {
        warnings.push(`spelling recovered in ${stateName}: "${c.from}" -> ${c.to} (${c.fips})`);
      }
      const miss = suspiciousLeftovers(hit.leftover);
      if (miss.length) {
        warnings.push(`unmatched tokens in ${stateName}: ${miss.slice(0, 12).join(', ')}`);
      }
    }
  }

  return { counties: [...counties].sort(), warnings, wholeStates };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(REPORTS, { recursive: true });
  const geo = await loadGeography();
  const raw = JSON.parse(await readFile(join(DATA, 'associations.raw.json'), 'utf8'));

  const parsed = raw.map((rec) => {
    const { counties, warnings, wholeStates } = parseTerritory(rec, geo);
    const states = [...new Set(counties.map((f) => geo.stateNameByFips.get(f.slice(0, 2))))].sort();
    return { ...rec, counties, states, wholeStates, warnings };
  });

  // ---- Overlap resolution -------------------------------------------------
  // Several counties are chartered to more than one association. A tile can only
  // be one region, so the smallest territory wins: without this rule the compact
  // single-county associations would be painted over by their large neighbours
  // and become unreachable on the map. Everyone else is recorded in sharedWith.
  const claims = new Map(); // fips -> [uninum]
  for (const a of parsed) {
    for (const f of a.counties) {
      if (!claims.has(f)) claims.set(f, []);
      claims.get(f).push(a.uninum);
    }
  }
  const sizeOf = new Map(parsed.map((a) => [a.uninum, a.counties.length]));
  const owner = new Map(); // fips -> winning uninum
  const sharedWith = new Map(parsed.map((a) => [a.uninum, new Set()]));
  const contested = [];

  for (const [fips, uninums] of claims) {
    const sorted = [...uninums].sort((x, y) => sizeOf.get(x) - sizeOf.get(y) || x - y);
    owner.set(fips, sorted[0]);
    if (sorted.length > 1) {
      contested.push({ fips, winner: sorted[0], others: sorted.slice(1) });
      for (const u of sorted) for (const v of sorted) if (u !== v) sharedWith.get(u).add(v);
    }
  }

  const nameOf = new Map(parsed.map((a) => [a.uninum, a.name]));
  const out = parsed.map((a) => ({
    uninum: a.uninum,
    name: a.name,
    shortName: a.shortName,
    district: a.district,
    ceo: a.ceo,
    phone: a.phone,
    url: a.url,
    hq: { ...a.hq, fips: resolveHqFips(a.hq, geo) },
    charterDate: a.charterDate,
    states: a.states,
    counties: a.counties,
    ownedCounties: a.counties.filter((f) => owner.get(f) === a.uninum),
    sharedWith: [...sharedWith.get(a.uninum)].sort(),
    commodity: null, // reserved; see plan open item 3
    territoryText: a.territoryText,
  }));

  await writeFile(join(DATA, 'associations.json'), JSON.stringify(out, null, 2));

  // ---- Reports ------------------------------------------------------------
  const warned = parsed.filter((a) => a.warnings.length);
  const failures = parsed.filter((a) => a.warnings.some((w) => /PARSE FAILURE|NO STATE SCOPE/.test(w)));

  await writeFile(
    join(REPORTS, 'unmatched.md'),
    `# Territory parse warnings\n\n` +
      `${parsed.length} associations parsed. ${warned.length} produced warnings, ` +
      `${failures.length} produced hard failures.\n\n` +
      (warned.length
        ? warned
            .map((a) => `## ${a.uninum} ${a.name}\n\n` + a.warnings.map((w) => `- ${w}`).join('\n'))
            .join('\n\n')
        : 'No warnings.\n')
  );

  await writeFile(
    join(REPORTS, 'overlap.md'),
    `# Contested counties\n\n` +
      `${contested.length} of ${claims.size} chartered counties are claimed by more than one ` +
      `association. The smallest territory wins the tile; the rest appear in \`sharedWith\`.\n\n` +
      contested
        .map(
          (c) =>
            `- \`${c.fips}\` ${geo.countyNameByFips.get(c.fips)}, ` +
            `${geo.stateNameByFips.get(c.fips.slice(0, 2))} -> **${nameOf.get(c.winner)}** ` +
            `(also: ${c.others.map((u) => nameOf.get(u)).join('; ')})`
        )
        .join('\n') + '\n'
  );

  // ---- Console summary ----------------------------------------------------
  const totalCounties = [...geo.countiesByState.values()].reduce((n, l) => n + l.length, 0);
  console.log(`Parsed ${parsed.length} associations`);
  console.log(`  counties covered : ${claims.size} of ${totalCounties} county-equivalents`);
  console.log(`  contested        : ${contested.length}`);
  console.log(`  with warnings    : ${warned.length}`);
  console.log(`  hard failures    : ${failures.length}`);

  const empty = parsed.filter((a) => !a.counties.length);
  if (empty.length) {
    console.log(`\n  !! ${empty.length} association(s) resolved to ZERO counties:`);
    for (const a of empty) console.log(`     ${a.uninum} ${a.name}`);
  }

  console.log('\n  Smallest territories:');
  for (const a of [...parsed].sort((x, y) => x.counties.length - y.counties.length).slice(0, 6)) {
    console.log(`     ${String(a.counties.length).padStart(3)} counties  ${a.name}`);
  }
  console.log('\n  Largest territories:');
  for (const a of [...parsed].sort((x, y) => y.counties.length - x.counties.length).slice(0, 4)) {
    console.log(`     ${String(a.counties.length).padStart(3)} counties  ${a.name}`);
  }

  console.log(`\nWrote data/associations.json and data/reports/{unmatched,overlap}.md`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
