# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive pixel-art atlas of the ~55 U.S. Farm Credit lending associations. A Node build pipeline scrapes the Farm Credit Administration's public directory, parses each association's legal territory description into county FIPS codes, and rasterises them into a 200×125 tile map. A static page (plain ES modules, no bundler, no runtime dependencies) renders that map on a canvas. `README.md` covers user-facing behaviour, the design, and the full list of territory-parsing pitfalls. Read it before touching `scripts/2-parse-territories.mjs`.

## Commands

```
npm install
npm run build      # fetch -> parse -> map (all three steps)
npm run serve      # static dev server, http://localhost:8080 (PORT env overrides)
npm test           # scripts/test-map.mjs
npm run preview    # headless render of the map into data/reports/preview-*.png
npm run coverage   # renders land no association claims -> data/reports/coverage-holes.png
```

Individual steps: `npm run fetch`, `npm run parse`, `npm run map`.

The same commands work inside the dev container (`.devcontainer/`, Node 24, `npm ci` on create, port 8080 forwarded). Headless-Edge screenshots (below) run on the host against the forwarded port.

`npm test` is a single script of seven numbered checks that runs in about a second. There is no per-test filter, so run it whole. There is no linter or formatter. The page must be served over HTTP, because ES modules and `fetch()` fail under `file://`.

## Pipeline gotchas

- **Step 1 caches everything in `data/raw/`** (gitignored) and skips files already there. Delete files to re-scrape. It is sequential with a 500ms delay against a `.gov` host, so keep it that way.
- **Unclaimed land renders exactly like sea.** A county the parser drops shows up as coastline, not as an error; this is how 13 Arizona counties once vanished silently. After any parser change, check `data/reports/unmatched.md` and `overlap.md`, and run `npm run coverage`. Step 3 also reports any unassigned land pocket larger than 24 tiles.
- **World constants live in `scripts/lib/config.mjs`.** `TILES_W`, `TILES_H`, `SS` and `MIN_TILES` are shared because `diagnose-coverage.mjs` must reproduce exactly the grid step 3 rasterised. Change them there, never in one script.

## Architecture

**Data flow.** FCA directory → `data/raw/` → `associations.raw.json` (step 1) → `associations.json` (step 2) → `map.json` + `directory.web.json` (step 3). The browser loads only the last two.

- `associations.json` is the full audit record. It keeps the verbatim `territoryText`, and it has both `counties` (everything chartered) and `ownedCounties` (what the association actually gets on the map). Where charters overlap, the **smallest territory wins** so compact associations stay visible, and the others are listed in `sharedWith`. An association left with nothing is grown from its HQ county (First South Farm Credit is the case that needs this).
- `map.json` holds `assoc[]` (0-based association index per tile, -1 = sea), `regions[]` (`{uninum, index, tileCount, anchor}`) and `graticule` polylines. The world is 3200×2000 px (16px tiles).
- `directory.web.json` is `{stats, banks, associations}`, trimmed down for the browser.

**Browser** (`src/`):

- `main.js` owns state, layout, input and the DOM. `map.js` (`GameMap`) owns region geometry, hit testing and the base-map drawing. `render.js` draws one frame from state and is **shared with `scripts/render-preview.mjs`**. Put drawing changes in `map.js`/`render.js`, never inline in `main.js`, or the headless preview stops matching the page.
- **There is no animation loop.** The base map is painted into an offscreen canvas once per layout or view change; hover, selection and the selection ping draw over a copy of it. Anything that changes the base (view mode, palette) must set `baseDirty`.
- **Every tile is a whole number of backing pixels.** At a fractional scale, each tile row gets anti-aliased edges that don't composite back to opaque, and the sea shows through as horizontal seams across the map. `unit` is one backing pixel in world units, and every stroke width is a multiple of it. `layout()` has two paths: whole device pixels shown 1:1, or a small integer tile size resampled by CSS when rounding down would waste more than 15% of the width (phones).
- **The atlas grid is tied to the world size.** `CELL = 200` world px gives 16×10 squares (A–P, 1–10). The rulers, the HUD, the signpost and the gazetteer grid references all depend on it.
- **Arrow keys** move between irregular regions using the cone-scored nearest anchor (`navigate.js`). Test 4 asserts every region is reachable this way.
- `#t=<uninum>` deep-links to a territory. The discovery log is in `localStorage` under `fcs-atlas:discovered`.

## Constraints

- **Test 7 checks `main.js` source by regex.** It guards a scroll-jump bug that happened twice: `highlightListItem` must not call `scrollIntoView`, `canvas.focus()` must pass `preventScroll`, and arrow keys must be handled on `window` with `preventDefault`. Restructuring those spots can fail the test even if the behaviour is correct. Keep the behaviour, and update the test if the structure changes.
- **The preview's canvas shim implements only** `fillStyle`, `fillRect`, `globalAlpha` and `save`/`translate`/`restore`. Colours must be hex, `rgb()`/`rgba()`, or space-separated `hsl()`; anything else draws magenta and is reported. New canvas APIs in `map.js`/`render.js` need the shim extended.
- **Keep the `Atlas Digits` `@font-face`** first in `--f-display`. It swaps in Silkscreen digits because Pixelify Sans' 5 reads as an S ("55" became "SS", "150" became "180").
- **No native dependencies.** The dev machine is Windows on ARM. The rasteriser and PNG encoder in `scripts/lib/` are hand-written to avoid `node-canvas`, and the dev container image must stay multi-arch (amd64 + arm64).

## Repository and deployment

- Public repo: `github.com/dmhhughes/fcs_atlas`, MIT-licensed. The site is `https://dmhhughes.github.io/fcs_atlas/`, so every URL the page loads must stay relative; a leading `/` breaks under the Pages subpath.
- **Pushing to `main` deploys.** `.github/workflows/pages.yml` runs `npm test` and then copies an explicit file list into the Pages artifact: `index.html`, `styles.css`, `src/`, `assets/`, `data/map.json`, `data/directory.web.json`. A new file the page fetches must be added to that list, or it 404s on the live site while working locally.
- CI never runs the pipeline. The committed `data/` files are what ships.
- `.devcontainer/` pins Node 24 and runs `npm ci`. `.gitattributes` forces LF so the Windows checkout, the container and CI see the same bytes.
- `data/reports/*.png` is gitignored; the `.md` reports are committed as the parse audit.

## Verifying UI changes

`npm test` and `npm run preview` never touch the DOM. For the real page, Microsoft Edge can screenshot headlessly while `npm run serve` is running:

```
msedge --headless=new --user-data-dir=<fresh dir> --virtual-time-budget=6000 --window-size=1280,1500 --screenshot=<out.png> http://localhost:8080/
```

- Launch it with `Start-Process -Wait`. The launcher returns before the file is written.
- Chromium won't size a window narrower than about 500px. For phone widths, load the page inside a fixed-width `<iframe>` on a wrapper page. Add `--force-device-scale-factor=2` or `3` for high-DPI.
- Headless mode can't hover. Use `#t=<uninum>` to capture a selected state.
- CSS animations can freeze under virtual time, so never make readability depend on an animation finishing. The signpost's entrance moves but doesn't fade for this reason.
