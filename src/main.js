/**
 * Entry point: the atlas page.
 *
 * The whole map is always on screen, so there is no camera and no game loop.
 * The base map is painted once per layout or view change into an offscreen
 * canvas; hover, selection and the selection ping are drawn over a blit of it,
 * so a redraw costs a single image copy plus a few hundred rectangles.
 */

import { GameMap } from './map.js';
import { renderFrame } from './render.js';
import { Signpost } from './signpost.js';
import { neighborInDirection, nearestRegion } from './navigate.js';
import { mountScene } from './scene.js';
import { emblemSvg, installFavicon } from './emblem.js';
import { SEA_BANDS, DISTRICT_COLORS, DISTRICT_FALLBACK } from './tiles.js';

const KEY_DIRECTIONS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};
const MODE_KEYS = { 1: 'territory', 2: 'district' };

/** Atlas grid: 200 world px squares give 16 columns (A-P) by 10 rows (1-10). */
const CELL = 200;
const COLS = 'ABCDEFGHIJKLMNOP';

const STORE = 'fcs-atlas:discovered';
const DEEP_SEA = SEA_BANDS[SEA_BANDS.length - 1];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function boot() {
  installFavicon('#ffd76a', '#1c1530');
  for (const el of document.querySelectorAll('[data-emblem]')) {
    el.innerHTML = emblemSvg({ fg: 'currentColor', size: Number(el.dataset.size) || 32 });
  }
  const sceneCanvas = document.getElementById('scene');
  if (sceneCanvas) mountScene(sceneCanvas);

  const [mapData, directory] = await Promise.all([
    fetch('data/map.json').then((r) => r.json()),
    fetch('data/directory.web.json').then((r) => r.json()),
  ]);

  const { associations, banks = [], stats = {} } = directory;
  const map = new GameMap(mapData, associations);
  const bankByDistrict = new Map(banks.map((b) => [b.district, b]));
  const indexByUninum = new Map(associations.map((a, i) => [a.uninum, i]));

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const base = document.createElement('canvas');
  const baseCtx = base.getContext('2d', { alpha: false });
  const plate = document.getElementById('plate');
  const atlas = plate.closest('.atlas') ?? plate.parentElement;
  const hud = document.getElementById('hud');
  let lastDpr = 0;

  const signpost = new Signpost(document.getElementById('signpost'), associations, {
    onClose: () => clearSelection(),
  });

  const anchors = new Map();
  for (const r of map.regions) if (r) anchors.set(r.index, map.anchorWorld(r.index));

  let hovered = -1;
  let selected = -1;
  let mode = 'territory';
  let ping = null;
  let pingFrame = 0;
  let rolling = false;
  let baseDirty = true;

  // Layout state, all set by layout().
  let dpr = 1;
  let scale = 1; // CSS px per world px
  let bscale = 1; // backing-store px per world px
  let unit = 1; // world px per backing-store px
  let originX = 0; // CSS px
  let originY = 0;
  let originDevX = 0; // device px
  let originDevY = 0;

  const discovered = loadDiscovered();

  fillStats(stats, associations, banks);
  buildRulers();

  // --- Grid references -------------------------------------------------------
  function gridRef(index) {
    const at = map.anchorWorld(index);
    if (!at) return '';
    const col = Math.min(COLS.length - 1, Math.floor(at[0] / CELL));
    const row = Math.min(Math.round(map.worldHeight / CELL) - 1, Math.floor(at[1] / CELL));
    return `${COLS[col]}${row + 1}`;
  }

  // --- Layout ----------------------------------------------------------------
  /**
   * Fit the world into the canvas, quantised so each tile is a whole number of
   * device pixels. At an arbitrary scale every tile row gets fractional edges,
   * canvas anti-aliases them, and adjacent rows fail to composite to opaque -
   * the sea bleeds through as horizontal seams across the whole map.
   */
  function layout() {
    dpr = window.devicePixelRatio || 1;

    // The canvas is sized to exactly the quantised map, so the plate's frame
    // and rulers hug the map rather than framing a band of empty sea. The room
    // available is measured from the section, which does not depend on the
    // canvas - measuring the canvas itself would feed back into the layout.
    const cs = getComputedStyle(plate);
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
      (parseFloat(cs.getPropertyValue('--ruler-w')) || 0);
    const availW = Math.max(160, atlas.clientWidth - chrome);
    const availH = Math.max(160, window.innerHeight * 0.78);

    const fit = Math.min(availW / map.worldWidth, availH / map.worldHeight);

    // Two ways to size the backing store, and both keep every tile a whole
    // number of backing pixels, so neither brings back the row seams.
    //  - Crisp: whole device pixels per tile, shown 1:1. Exact, but on small
    //    screens rounding down can throw away a third of the width.
    //  - Scaled: render at a few pixels per tile, then let CSS resample that
    //    single bitmap to fill the room.
    // Crisp wins whenever it still fills at least 85% of the space.
    const ideal = dpr * fit * map.tileSize;
    const crisp = Math.floor(ideal) >= 1 && Math.floor(ideal) / ideal >= 0.85;
    const tilePx = crisp ? Math.floor(ideal) : Math.max(2, Math.ceil(ideal));
    const devW = tilePx * map.width;
    const devH = tilePx * map.height;
    const cssW = crisp ? devW / dpr : map.worldWidth * fit;
    const cssH = crisp ? devH / dpr : map.worldHeight * fit;
    if (devW === canvas.width && devH === canvas.height && dpr === lastDpr &&
        canvas.style.width === `${cssW}px`) return;
    lastDpr = dpr;

    canvas.width = devW;
    canvas.height = devH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    // Upscaled pixel art stays pixelated; a downscale is smoothed, which reads
    // far better than nearest-neighbour silently dropping rows of pixels.
    canvas.style.imageRendering = cssW * dpr >= devW - 0.5 ? 'pixelated' : 'auto';
    scale = cssW / map.worldWidth;
    bscale = tilePx / map.tileSize;
    unit = map.tileSize / tilePx;

    originDevX = 0;
    originDevY = 0;
    originX = 0;
    originY = 0;

    // The rulers read these to line their squares up with the painted map.
    plate.style.setProperty('--ox', `${originX}px`);
    plate.style.setProperty('--oy', `${originY}px`);
    plate.style.setProperty('--cell', `${CELL * scale}px`);

    baseDirty = true;
    render();
  }

  const worldTransform = (c) => c.setTransform(bscale, 0, 0, bscale, originDevX, originDevY);

  const toWorld = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return [(clientX - rect.left - originX) / scale, (clientY - rect.top - originY) / scale];
  };

  // --- Rendering -------------------------------------------------------------
  function paintBase() {
    base.width = canvas.width;
    base.height = canvas.height;
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.fillStyle = DEEP_SEA;
    baseCtx.fillRect(0, 0, base.width, base.height);
    worldTransform(baseCtx);
    baseCtx.imageSmoothingEnabled = false;
    map.draw(baseCtx, { mode, unit });
    baseDirty = false;
  }

  function render() {
    if (!canvas.width) return;
    if (baseDirty) paintBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0);
    worldTransform(ctx);
    renderFrame(ctx, map, { mode, unit, hovered, selected, ping, drawBase: false });
  }

  function startPing(index) {
    if (reducedMotion()) return;
    cancelAnimationFrame(pingFrame);
    const t0 = performance.now();
    const DURATION = 560;
    const step = (now) => {
      const t = (now - t0) / DURATION;
      ping = t < 1 ? { index, t } : null;
      render();
      if (ping) pingFrame = requestAnimationFrame(step);
    };
    pingFrame = requestAnimationFrame(step);
  }

  // --- HUD -------------------------------------------------------------------
  function updateHud() {
    const i = hovered >= 0 ? hovered : selected;
    hud.replaceChildren();
    if (i < 0) {
      const hint = document.createElement('span');
      hint.className = 'hud-hint';
      hint.textContent = 'Hover a territory · arrows to travel · R to roll';
      hud.append(hint);
      return;
    }
    const a = associations[i];
    const parts = [
      ['hud-ref', gridRef(i)],
      ['hud-name', a.name],
      ['hud-hq', [a.hq.city, a.hq.state].filter(Boolean).join(', ')],
    ];
    for (const [cls, text] of parts) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      hud.append(span);
    }
  }

  // --- Selection -------------------------------------------------------------
  function setHovered(index) {
    if (index === hovered || rolling) return;
    hovered = index;
    canvas.style.cursor = index >= 0 ? 'pointer' : 'default';
    updateHud();
    render();
  }

  function setSelected(index, { announceIt = true } = {}) {
    if (index == null || index < 0) return;
    selected = index;
    const a = associations[index];
    const isNew = !discovered.has(a.uninum);
    discovered.add(a.uninum);
    saveDiscovered(discovered);

    signpost.show(a, {
      gridRef: gridRef(index),
      color: DISTRICT_COLORS[a.district] ?? DISTRICT_FALLBACK,
      bank: bankByDistrict.get(a.district),
      isNew,
    });
    highlightListItem(a.uninum);
    refreshLog();
    updateHud();
    startPing(index);
    render();
    // Keep the URL pointing at the chosen territory, so it can be shared.
    history.replaceState(null, '', `#t=${a.uninum}`);
    if (announceIt) {
      announce(`${a.name}, ${a.hq.city}, ${a.hq.state}. Grid ${gridRef(index)}.${isNew ? ' New discovery.' : ''}`);
    }
  }

  function clearSelection() {
    selected = -1;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    signpost.hide();
    highlightListItem(null);
    updateHud();
    render();
  }

  // --- Roll: a random territory, preferring ones not yet discovered ----------
  const rollButton = document.getElementById('roll');

  function roll() {
    if (rolling) return;
    const placed = [...anchors.keys()];
    const fresh = placed.filter((i) => i !== selected && !discovered.has(associations[i].uninum));
    const pool = fresh.length ? fresh : placed.filter((i) => i !== selected);
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (target === undefined) return;

    if (reducedMotion()) { setSelected(target); return; }

    // A short shuffle across the map before landing, slowing as it goes.
    rolling = true;
    rollButton.classList.add('is-rolling');
    let n = 0;
    const FLASHES = 8;
    const tick = () => {
      if (n < FLASHES) {
        hovered = placed[Math.floor(Math.random() * placed.length)];
        render();
        n++;
        setTimeout(tick, 55 + n * 14);
        return;
      }
      hovered = -1;
      rolling = false;
      rollButton.classList.remove('is-rolling');
      setSelected(target);
    };
    tick();
  }
  rollButton.addEventListener('click', roll);

  // --- Pointer ---------------------------------------------------------------
  canvas.addEventListener('pointermove', (e) => {
    setHovered(map.regionAtWorld(...toWorld(e.clientX, e.clientY)));
  });
  canvas.addEventListener('pointerleave', () => setHovered(-1));

  canvas.addEventListener('click', (e) => {
    const index = map.regionAtWorld(...toWorld(e.clientX, e.clientY));
    // preventScroll matters: focusing an element normally scrolls it into view,
    // which yanks the page around on every click.
    canvas.focus({ preventScroll: true });
    if (index < 0) clearSelection();
    else setSelected(index);
  });

  // --- Keyboard --------------------------------------------------------------
  // Bound to the window rather than the canvas. On a canvas-only listener the
  // arrow keys do nothing until the canvas happens to have focus, and until
  // then the browser applies its default action instead - scrolling the page
  // down to the gazetteer. Handling them here means preventDefault always runs.
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') { clearSelection(); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); roll(); return; }
    if (MODE_KEYS[e.key]) { setMode(MODE_KEYS[e.key]); return; }

    const direction = KEY_DIRECTIONS[e.code];
    if (!direction) return;
    e.preventDefault(); // stop arrow keys scrolling the page

    if (selected < 0) {
      setSelected(nearestRegion(anchors, map.worldWidth / 2, map.worldHeight / 2));
      return;
    }
    const next = neighborInDirection(anchors, selected, direction);
    if (next !== null) setSelected(next);
  });

  // --- View modes ------------------------------------------------------------
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));

  function setMode(next) {
    mode = next;
    for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    document.getElementById('directory').dataset.mode = mode;
    renderLegend();
    refreshSwatches();
    baseDirty = true;
    render();
  }

  function renderLegend() {
    const legend = document.getElementById('legend');
    legend.replaceChildren();
    const item = (color, label) => {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = color;
      li.append(sw, document.createTextNode(label));
      legend.append(li);
    };

    if (mode === 'district') {
      for (const b of banks) item(DISTRICT_COLORS[b.district] ?? DISTRICT_FALLBACK, `${b.district} · ${b.name}`);
    } else {
      const li = document.createElement('li');
      li.className = 'legend-note';
      li.textContent = `${associations.length} colours, one for each association`;
      legend.append(li);
    }
  }

  // --- Discovery log ---------------------------------------------------------
  const logOrder = [];

  function refreshLog() {
    const count = [...discovered].filter((u) => indexByUninum.has(u)).length;
    document.getElementById('log-count').textContent = String(count);
    document.getElementById('log-total').textContent = String(associations.length);
    const bar = document.getElementById('log-bar');
    [...bar.children].forEach((cell, k) => {
      cell.classList.toggle('is-found', discovered.has(logOrder[k]));
    });
    for (const el of document.querySelectorAll('.entry')) {
      el.classList.toggle('is-found', discovered.has(Number(el.dataset.uninum)));
    }
    const done = count === associations.length;
    document.getElementById('log').classList.toggle('is-complete', done);
  }

  document.getElementById('log-reset').addEventListener('click', () => {
    if (!discovered.size) return;
    if (!confirm('Clear your discovery log?')) return;
    discovered.clear();
    saveDiscovered(discovered);
    refreshLog();
    if (selected >= 0) signpost.show(associations[selected], {
      gridRef: gridRef(selected),
      color: DISTRICT_COLORS[associations[selected].district] ?? DISTRICT_FALLBACK,
      bank: bankByDistrict.get(associations[selected].district),
    });
  });

  // --- Gazetteer ---------------------------------------------------------------
  function buildGazetteer() {
    const root = document.getElementById('directory');
    root.replaceChildren();
    const bar = document.getElementById('log-bar');
    bar.replaceChildren();

    const groups = banks.length
      ? banks
      : [...new Set(associations.map((a) => a.district))].sort().map((d) => ({ district: d, name: d }));

    for (const bank of groups) {
      const members = associations
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.district === bank.district)
        .sort((x, y) => x.a.name.localeCompare(y.a.name));
      if (!members.length) continue;

      const section = document.createElement('section');
      section.className = 'bank';
      section.style.setProperty('--district', DISTRICT_COLORS[bank.district] ?? DISTRICT_FALLBACK);

      const head = document.createElement('header');
      head.className = 'bank-head';
      head.innerHTML =
        '<span class="bank-chip" aria-hidden="true"></span>' +
        '<div class="bank-text"><h3 class="bank-name"></h3><p class="bank-meta"></p></div>' +
        '<span class="bank-count"></span>';
      head.querySelector('.bank-name').textContent = `${bank.district} District`;
      head.querySelector('.bank-meta').textContent =
        [bank.name, bank.hq ? `${bank.hq.city}, ${bank.hq.state}` : null].filter(Boolean).join(' · ');
      head.querySelector('.bank-count').textContent = String(members.length);
      section.append(head);

      const list = document.createElement('ul');
      list.className = 'entries';

      for (const { a, i } of members) {
        const placed = anchors.has(i);
        const ref = placed ? gridRef(i) : '—';

        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'entry';
        button.dataset.uninum = String(a.uninum);
        button.dataset.index = String(i);
        button.dataset.search = [a.name, a.hq.city, a.hq.state, a.district, ref, ...(a.states ?? [])]
          .join(' ')
          .toLowerCase();
        button.innerHTML =
          '<span class="entry-swatch" aria-hidden="true"></span>' +
          '<span class="entry-main"><span class="entry-line"><span class="entry-name"></span>' +
          '<span class="entry-leader" aria-hidden="true"></span><span class="entry-ref"></span></span>' +
          '<span class="entry-hq"></span></span>' +
          `<span class="entry-stamp" title="Discovered">${emblemSvg({ fg: 'currentColor', size: 16 })}</span>`;
        button.querySelector('.entry-name').textContent = a.name;
        button.querySelector('.entry-ref').textContent = ref;
        button.querySelector('.entry-hq').textContent = [a.hq.city, a.hq.state].filter(Boolean).join(', ');
        button.setAttribute('aria-label', `${a.name}, ${a.hq.city}, ${a.hq.state}, grid ${ref}`);

        if (!placed) button.disabled = true;
        else button.addEventListener('click', () => {
          setSelected(i);
          plate.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
        });

        li.append(button);
        list.append(li);

        const cell = document.createElement('span');
        cell.className = 'log-cell';
        cell.title = a.name;
        bar.append(cell);
        logOrder.push(a.uninum);
      }

      section.append(list);
      root.append(section);
    }
    document.getElementById('region-count').textContent = String(associations.length);
  }

  function refreshSwatches() {
    for (const el of document.querySelectorAll('.entry')) {
      const i = Number(el.dataset.index);
      el.querySelector('.entry-swatch').style.background = map.colorOf(i, mode);
    }
  }

  // --- Search ------------------------------------------------------------------
  const search = document.getElementById('search');
  const searchStatus = document.getElementById('search-status');

  function applySearch() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const section of document.querySelectorAll('.bank')) {
      let inSection = 0;
      for (const el of section.querySelectorAll('.entry')) {
        const hit = !q || el.dataset.search.includes(q);
        el.parentElement.hidden = !hit;
        if (hit) inSection++;
      }
      section.hidden = inSection === 0;
      shown += inSection;
    }
    searchStatus.textContent = q
      ? shown ? `${shown} of ${associations.length} shown` : 'No association matches that'
      : '';
  }

  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = [...document.querySelectorAll('.entry')].find((el) => !el.parentElement.hidden && !el.disabled);
    if (first) first.click();
  });

  // --- Go ------------------------------------------------------------------------
  buildGazetteer();
  setMode(mode);
  refreshLog();
  updateHud();

  new ResizeObserver(layout).observe(atlas);
  window.addEventListener('resize', layout);
  layout();

  // A shared link such as index.html#t=710454 opens with that territory chosen.
  selectFromHash();
  window.addEventListener('hashchange', selectFromHash);

  function selectFromHash() {
    const m = location.hash.match(/^#t=(\d+)$/);
    if (!m) return;
    const i = indexByUninum.get(Number(m[1]));
    if (i !== undefined && anchors.has(i) && i !== selected) setSelected(i, { announceIt: false });
  }

  // Rulers, legend and swatches need the grid and palette; they are ready now.
  function buildRulers() {
    const top = document.getElementById('ruler-top');
    const left = document.getElementById('ruler-left');
    const rows = Math.round(map.worldHeight / CELL);
    top.replaceChildren();
    left.replaceChildren();
    for (let c = 0; c < Math.round(map.worldWidth / CELL); c++) {
      const s = document.createElement('span');
      s.style.setProperty('--i', c);
      s.textContent = COLS[c];
      top.append(s);
    }
    for (let r = 0; r < rows; r++) {
      const s = document.createElement('span');
      s.style.setProperty('--i', r);
      s.textContent = String(r + 1);
      left.append(s);
    }
  }
}

// --- Helpers ---------------------------------------------------------------------

function fillStats(stats, associations, banks) {
  const set = (id, n) => {
    const el = document.getElementById(id);
    if (el && Number.isFinite(n)) el.textContent = n.toLocaleString('en-US');
  };
  set('stat-associations', stats.associations ?? associations.length);
  set('stat-banks', stats.banks ?? banks.length);
  set('stat-counties', stats.counties);
  set('stat-states', stats.states);
}

function loadDiscovered() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.map(Number) : []);
  } catch {
    return new Set();
  }
}

function saveDiscovered(set) {
  try {
    localStorage.setItem(STORE, JSON.stringify([...set]));
  } catch {
    // Private mode or storage disabled: the log simply lasts for this visit.
  }
}

/**
 * Mark the matching gazetteer entry, without scrolling to it. Selecting a
 * territory on the map must never move the page: the map is what the reader is
 * looking at, and the gazetteer lives below the fold.
 */
function highlightListItem(uninum) {
  for (const el of document.querySelectorAll('.entry')) {
    el.classList.toggle('is-selected', uninum !== null && el.dataset.uninum === String(uninum));
  }
}

function announce(message) {
  document.getElementById('live').textContent = message;
}

boot().catch((err) => {
  console.error(err);
  const box = document.getElementById('boot-error');
  if (!box) return;
  box.hidden = false;
  box.textContent = `Could not start: ${err.message}. Run "npm run build" then "npm run serve".`;
});
