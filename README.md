# Farm Credit Territory Atlas

An interactive, pixel-art atlas of every Farm Credit lending association in the
United States. The whole map is on screen at once: hover or click a territory to
see who serves it, travel between neighbouring territories with the arrow keys,
or roll a random one.

**Live:** <https://dmhhughes.github.io/fcs_atlas/>

The map is **generated, not hand-drawn**. The Farm Credit Administration
publishes machine-parseable, county-level territory descriptions for every
institution, so the whole map is a build artifact that can be regenerated when
associations merge, which they do often.

```
npm install
npm run build     # fetch -> parse -> rasterise
npm run serve     # http://localhost:8080
```

## Using it

| Input | Does |
|---|---|
| Hover / click | Highlight a territory / open its signpost |
| Arrow keys (or WASD) | Travel to the neighbouring territory in that direction |
| `R` | Roll a random territory, preferring ones not yet discovered |
| `1` `2` | Colour the map by association or by district bank |
| `Esc` | Clear the selection |
| Find box | Filter the gazetteer; `Enter` opens the first match |

Selecting a territory updates the URL to `#t=<FCA institution number>`, so a link
such as `index.html#t=710454` opens with AgTrust, ACA already chosen.

The **field log** under the map records which territories you have found (kept
in `localStorage`), and the **gazetteer** below lists all 55 associations
grouped by the district bank that funds them. Each carries the atlas grid square
(`A`–`P` by `1`–`10`, matching the rulers around the map) of its territory.

## Design

The page is set at **golden hour**: half past four on an autumn afternoon, sun
low in the west.

- **Light has a direction.** Coastlines facing north and west catch a gold
  highlight and those facing south and east fall into shadow, so the land reads
  as raised relief lit from the setting sun.
- **Sea like a 16-bit overworld.** Distance-to-coast is precomputed and the sea
  is drawn in bands (surf, shallows, deep), with real 5° lines of latitude and
  longitude dotted over open water and sparse amber glints.
- **An atlas plate.** The map sits on a parchment mat with lettered and
  numbered rulers; the directory below is a gazetteer that refers back to them.
- **Palette:** violet sea, soft golden-angle hues for the territories, parchment
  panels, rose and sun-gold accents. Selection is a sun-gold line over a dark
  backing, which stays legible on every territory colour.
- **Type:** Pixelify Sans for display and reading text, Silkscreen for labels
  and grid references. Both are self-hosted in `assets/fonts/`.
- **Emblem:** an 8×8 sprout over a ploughed field, drawn as SVG for the title
  plate, the favicon, and the discovery stamps.
- **Header:** a sunset farm scene rendered at true low resolution (one scene
  pixel is four CSS pixels) with an ordered-dither sky. Only the birds, stars
  and windmill animate, at 8 fps, and only while visible and when motion is
  allowed.

## Pipeline

| Step | Script | Does |
|---|---|---|
| 1 | `1-fetch-fca.mjs` | Scrapes the FCA public directory: roster, 55 association pages, 55 territory PNGs, and the 4 funding banks. Everything is cached in `data/raw/`. |
| 2 | `2-parse-territories.mjs` | Turns territory descriptions into county FIPS sets, resolves overlaps, writes `data/associations.json`. |
| 3 | `3-build-map.mjs` | Projects counties, rasterises at 4× and majority-votes down to a 200×125 tile grid; closes enclaves; writes `data/map.json` (tiles, regions, graticule) and `data/directory.web.json` (associations, banks, stats). |

```
npm test          # geometry, hit testing, keyboard reachability, grouping, no-scroll invariants, parse regressions
npm run preview   # render the map headlessly, through the page's own renderer
npm run coverage  # render any land that no association claims
```

## Source

| File | Role |
|---|---|
| `index.html`, `styles.css` | The page |
| `src/main.js` | Layout, input, selection, roll, field log, gazetteer, search |
| `src/map.js` | Region geometry, hit testing, the golden-hour base renderer |
| `src/render.js` | One frame from state; shared by the page and `npm run preview` |
| `src/navigate.js` | Spatial arrow-key navigation between territories |
| `src/signpost.js` | The details card |
| `src/scene.js` | The header sunset |
| `src/emblem.js` | The 8×8 emblem and favicon |
| `src/tiles.js` | Palette |

## How the territory parsing works

The descriptions are legal prose with no consistent grammar ("the Counties of",
"the counties", "all of the counties of", "the Parishes of", `:`-delimited
lists, multi-state clauses). Rather than parse that grammar, the parser
establishes which **state** a clause is scoped to, then matches names against
the dictionary of counties *for that state*.

Things that turned out to matter:

- **State names are also county names** (Mississippi County, Arkansas; Ohio
  County, Kentucky). A state only opens a scope when introduced by
  "State/Commonwealth of".
- **Metes-and-bounds references are not grants.** "...along the north boundary
  line of the State of Nevada" must not hand Idaho AgCredit all of Nevada.
- **Narrow authorities are not territory.** Horizon Farm Credit's orchardist-only
  clause names six more states plus Puerto Rico.
- **A carve-out is not a county list.** "All of the state of Arizona, except for
  those portions of Mohave and Coconino Counties..." once read as a two-county
  list and dropped thirteen counties, which rendered as sea rather than as an
  error. Carve-out text is kept apart from grant text.
- **Rivers are named after counties.** "The South Canadian River" once added
  Canadian County, Oklahoma. A county name followed by River, Creek, Range and
  the like is skipped.
- **Boundary prose names counties it does not grant.** "The Mendocino-Glenn
  County line", "the Butte City-Oroville Highway", "Twin Falls County, Idaho",
  "the north boundary line", "San Bernardino Base and Meridian" and "the Red
  River" each once added a whole county, and five of them were drawn on the
  map. Hyphenated boundaries, a state named after "County,", lowercase words,
  survey meridians and "the" before a river-named county are all skipped.
  `npm test` pins every case, alongside the genuine grants the same rules could
  over-correct.
- **A statewide grant can also name counties.** American AgCredit lends under
  Title I "in all counties" of New Mexico and under Title II in twelve named
  ones. That is read as all 33, not as a twelve-county list.
- **The source has typos** (`Autaugo`, `Mechlenburg`, `Chattachoochee`,
  `Loraine`, `Green`). Recovered by single-edit distance within the state, and
  logged.
- **Partial counties count as served**, symmetrically for exclusions.

Everything parsed is auditable in `data/reports/`.

## Engineering notes

- **No game loop.** The base map is painted once per layout or view change into
  an offscreen canvas; hover, selection and the selection ping are drawn over a
  blit of it. Nothing is redrawn while the pointer stays inside one territory.
- **Whole-pixel tiles.** Every tile is a whole number of backing pixels. At a
  fractional scale each tile row gets anti-aliased edges that do not composite
  back to opaque, and the sea bleeds through as horizontal seams across the
  map. On large screens tiles are whole *device* pixels shown 1:1; where that
  would waste more than 15% of the width (phones), the map is rendered at a few
  pixels per tile and the single bitmap is resampled by CSS to fill the room.
- **The canvas is sized to the map**, so the parchment frame and the rulers hug
  it exactly.
- **Selecting never scrolls the page.** Arrow keys are handled on the window so
  `preventDefault` always runs; list highlighting never calls `scrollIntoView`;
  `focus()` uses `preventScroll`. Test 7 pins all three.
- **Overlaps:** a county claimed by several associations goes to the smallest
  territory, so compact associations stay visible; the signpost names the rest.
  First South Farm Credit, which loses every tile this way, is grown from its
  real headquarters to stay reachable.
- **No native dependencies.** Rasterisation is hand-written scanline fill and
  the PNG encoder wraps Node's zlib.

## Known limitations

- Puerto Rico is drawn as an island with its own projection; Alaska and Hawaii
  are `geoAlbersUsa` insets. All are ordinary selectable territories.
- Commodity data is not included; FCA does not publish it. The signpost shows it
  if the field is ever populated.
- Virginia's independent cities, Baltimore, St. Louis and the District of
  Columbia belong to no association and are absorbed by the territory around
  them. Any larger unclaimed area is reported by the build as a parsing gap.

## Development environment

`.devcontainer/devcontainer.json` pins Node 24 (Debian, amd64 and arm64) and
runs `npm ci` against the lockfile on creation. Open the folder in VS Code and
choose **Reopen in Container**, or start a GitHub Codespace; every command above
then works unchanged, and port 8080 is forwarded for `npm run serve`. Docker is
the only thing needed on the host.

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`, which runs `npm test`
and then publishes only the files the page loads (`index.html`, `styles.css`,
`src/`, `assets/`, `data/map.json`, `data/directory.web.json`) to GitHub Pages.
The pipeline is not rerun in CI: the committed data is what ships, so a refresh
from the FCA directory is run locally, reviewed in `data/reports/`, and
committed.

## Provenance and credits

Association data: the [FCA public institution
directory](https://apps.fca.gov/FCSPublicDirectory/), a U.S. government work.
County boundaries: [`us-atlas`](https://github.com/topojson/us-atlas) (ISC),
from U.S. Census cartographic boundary files. Type: Pixelify Sans and
Silkscreen, self-hosted under the SIL Open Font License 1.1
(`assets/fonts/OFL.txt`).

This is an independent project, not affiliated with or endorsed by the Farm
Credit Administration or any Farm Credit System institution. Territory shapes
are approximate; the FCA directory is the authoritative source.

## License

The code is MIT-licensed; see [`LICENSE`](LICENSE). The fonts keep their own
license.
