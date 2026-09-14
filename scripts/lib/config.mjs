/**
 * World constants shared by the build scripts.
 *
 * scripts/diagnose-coverage.mjs has to reproduce exactly the grid step 3
 * rasterised, so these live in one place rather than being repeated and
 * quietly drifting apart.
 */

export const TILES_W = 200;
export const TILES_H = 125;
export const TILE_SIZE = 16; // -> 3200 x 2000 world pixels
export const SS = 4; // supersample factor used during rasterisation

/**
 * Every association must be walkable. Below this many tiles a region is too
 * small to enter reliably, so it is grown outward from its headquarters.
 */
export const MIN_TILES = 14;
