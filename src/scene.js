/**
 * The header scene: a farm at half past four, sun going down in the west.
 *
 * Drawn at true low resolution - one scene pixel is four CSS pixels - with an
 * ordered (Bayer) dither for the sky, the way 16-bit sunsets were done. The
 * static landscape is rendered once per resize into an offscreen canvas; only
 * the birds, the windmill and the stars are redrawn, at eight frames a second,
 * and only while the header is on screen and motion is allowed.
 */

const PX = 4; // CSS pixels per scene pixel
const H = 56; // scene height in scene pixels
const FPS = 8;

const SKY = ['#1c1530', '#2b2147', '#3a2d5c', '#5b3f7e', '#8e4a86', '#c4577f', '#e8746a', '#f5a54a', '#ffd76a'];
const FIELDS = ['#9c6d2c', '#6f7a30', '#b07e33', '#5e4a2b', '#86702e'];
const INK = '#1c1224';
const HILL = '#5e4470';
const HAZE = '#7a4f7e';
const SUN = '#ffd76a';
const SUN_CORE = '#fff1b0';
const GLOW = '#f5a54a';
const LIT = '#ffd76a';

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));

// Silhouettes. '#' is ink, 'o' is a lit window.
const BARN = [
  '......####......',
  '....########....',
  '...##########...',
  '..############..',
  '.##############.',
  '################',
  '.##############.',
  '.#####oo#######.',
  '.#####oo#######.',
  '.##############.',
  '.#####....#####.',
  '.#####....#####.',
];
const SILO = [
  '..##..', '.####.', '######', '######', '######', '######', '######', '######',
  '######', '######', '######', '######', '######', '######', '######', '######',
];
const TREE = [
  '...###...', '..#####..', '.#######.', '#########', '#########', '#########',
  '.#######.', '..#####..', '....#....', '....#....', '....#....', '...###...',
];
const TOWER = [
  '....#....', '...###...', '...#.#...', '...#.#...', '..#...#..', '..#.#.#..',
  '..#...#..', '.#..#..#.', '.#.....#.', '.#..#..#.', '#.......#', '#...#...#',
];

export function mountScene(canvas) {
  const ctx = canvas.getContext('2d');
  const still = document.createElement('canvas');
  const stillCtx = still.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let W = 0;
  let horizon = 0;
  let sunX = 0;
  let millX = 0;
  let frame = 0;
  let timer = null;
  let visible = true;

  function layout() {
    const cssW = canvas.getBoundingClientRect().width || 960;
    W = Math.ceil(cssW / PX);
    canvas.width = W;
    canvas.height = H;
    canvas.style.height = `${H * PX}px`;
    still.width = W;
    still.height = H;
    horizon = Math.round(H * 0.62);
    sunX = Math.round(W * 0.22);
    millX = Math.round(W * 0.86);
    paintStill();
    draw();
  }

  function put(c, x, y, color) {
    c.fillStyle = color;
    c.fillRect(x, y, 1, 1);
  }

  function sprite(c, rows, x0, bottom) {
    const y0 = bottom - rows.length + 1;
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '#') put(c, x0 + x, y0 + y, INK);
        else if (row[x] === 'o') put(c, x0 + x, y0 + y, LIT);
      }
    });
  }

  function paintStill() {
    const c = stillCtx;

    // Sky: dithered gradient from night overhead to gold at the horizon.
    for (let y = 0; y < horizon; y++) {
      const t = (y / (horizon - 1)) * (SKY.length - 1);
      const i = Math.min(SKY.length - 2, Math.floor(t));
      const f = t - i;
      for (let x = 0; x < W; x++) {
        put(c, x, y, f > BAYER[y & 3][x & 3] ? SKY[i + 1] : SKY[i]);
      }
    }

    // Sun: a disc half below the horizon, with a dithered halo.
    const sunY = horizon - 2;
    const R = 10;
    for (let y = sunY - R - 6; y < horizon; y++) {
      for (let x = sunX - R - 6; x <= sunX + R + 6; x++) {
        const d = Math.hypot(x - sunX, y - sunY);
        if (d <= R) put(c, x, y, d < R - 3 ? SUN_CORE : SUN);
        else if (d <= R + 6 && (R + 6 - d) / 6 > BAYER[y & 3][x & 3] + 0.25) put(c, x, y, GLOW);
      }
    }

    // Distant hills, with haze dithered along their ridge.
    for (let x = 0; x < W; x++) {
      const h = Math.round(3 + 2 * Math.sin(x * 0.07) + 1.4 * Math.sin(x * 0.19 + 1.3) + Math.sin(x * 0.41));
      for (let y = horizon - h; y < horizon; y++) {
        put(c, x, y, y === horizon - h && BAYER[y & 3][x & 3] > 0.5 ? HAZE : HILL);
      }
    }

    // Fields in perspective: stripes that thicken toward the viewer, each
    // with a top edge catching the low light, strongest beneath the sun.
    let y = horizon;
    let band = 0;
    let thick = 1;
    while (y < H) {
      const color = FIELDS[band % FIELDS.length];
      for (let k = 0; k < thick && y + k < H; k++) {
        for (let x = 0; x < W; x++) {
          let col = color;
          if (k === 0) {
            const reach = Math.max(0, 1 - Math.abs(x - sunX) / (W * 0.55));
            if (reach > BAYER[(y + k) & 3][x & 3]) col = GLOW;
          }
          put(c, x, y + k, col);
        }
      }
      y += thick;
      band++;
      thick = Math.min(9, Math.round(thick * 1.45) + (band % 2));
    }

    // Silhouettes on the horizon. The tree stands in front of the sun.
    const ground = horizon + 1;
    sprite(c, TREE, Math.round(W * 0.1), ground);
    sprite(c, TREE, Math.round(W * 0.1) + 8, ground + 1);
    const farm = Math.round(W * 0.62);
    sprite(c, SILO, farm, ground);
    sprite(c, BARN, farm + 7, ground);
    sprite(c, TOWER, millX - 4, ground);

    // Fence lines.
    for (const [a, b] of [[0.46, 0.6], [0.7, 0.8]]) {
      const x0 = Math.round(W * a);
      const x1 = Math.round(W * b);
      for (let x = x0; x <= x1; x++) {
        put(c, x, ground - 2, INK);
        if ((x - x0) % 4 === 0) { put(c, x, ground - 3, INK); put(c, x, ground - 1, INK); }
      }
    }
  }

  function draw() {
    ctx.drawImage(still, 0, 0);

    // Windmill blades, two frames.
    const hubY = horizon + 1 - TOWER.length;
    put(ctx, millX, hubY, INK);
    const arms = frame % 2
      ? [[1, 1], [2, 2], [3, 3], [-1, -1], [-2, -2], [-3, -3], [1, -1], [2, -2], [3, -3], [-1, 1], [-2, 2], [-3, 3]]
      : [[0, 1], [0, 2], [0, 3], [0, -1], [0, -2], [0, -3], [1, 0], [2, 0], [3, 0], [-1, 0], [-2, 0], [-3, 0]];
    for (const [dx, dy] of arms) put(ctx, millX + dx, hubY + dy, INK);

    // Birds drifting west to east, wings flapping.
    for (let b = 0; b < 3; b++) {
      const span = W + 20;
      const x = Math.round(((frame * 0.6 + b * 37) % span) - 10);
      const y = 9 + b * 4 + (b === 1 ? 2 : 0);
      const up = (frame + b) % 4 < 2;
      put(ctx, x, y + (up ? 0 : 1), INK);
      put(ctx, x + 1, y + (up ? 1 : 0), INK);
      put(ctx, x + 2, y + (up ? 0 : 1), INK);
    }

    // A few early stars in the night band.
    for (let s = 0; s < 14; s++) {
      const x = Math.round((s * 97.3 + 11) % W);
      const y = 1 + ((s * 7) % 7);
      if ((s + frame) % 5 !== 0) put(ctx, x, y, s % 3 ? '#b9a8d6' : '#f7e6c4');
    }
  }

  function tick() {
    frame++;
    draw();
  }

  function sync() {
    const run = visible && !reduced.matches;
    if (run && !timer) timer = setInterval(tick, 1000 / FPS);
    if (!run && timer) { clearInterval(timer); timer = null; }
  }

  new ResizeObserver(layout).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }).observe(canvas);
  reduced.addEventListener?.('change', sync);
  layout();
  sync();
}
