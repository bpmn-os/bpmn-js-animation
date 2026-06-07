/**
 * CSS-color helpers for token identities.
 *
 * Both helpers wrap the `randomcolor` library — the **same coloring scheme as
 * bpmn-js-token-simulation**, so instances/scopes read with the same familiar,
 * well-separated palette:
 *
 *  - `getRandomColor`   — one random color (a thin `randomColor()` pass-through).
 *  - `getDistinctColor` — the `index`-th color of a fixed, contrast-filtered palette
 *                         of 60 `randomColor` values, cycled by index. Successive
 *                         indices step through visually distinct colors; it wraps
 *                         after the palette length.
 *
 * The package never assigns colors itself; callers mint a color per identity and pass
 * it to `createToken`. A **child** token (a start-event child, a fork branch) inherits
 * its parent's color, exactly like a token-simulation scope — there is no per-instance
 * "related shade" ring.
 *
 * Output is a `#rrggbb` hex string (randomColor's default), but any CSS color works
 * downstream.
 */

import randomColor from 'randomcolor';

// Palette size + contrast cutoff, both straight from bpmn-js-token-simulation: 60
// random colors, keeping only those whose YIQ brightness is below 200 (dark enough
// to read as a token dot on a light canvas).
const PALETTE_COUNT = 60;
const YIQ_MAX = 200;

// One random seed per session so the palette varies run-to-run (token-simulation
// re-rolls per load too); pass an explicit `seed` to pin it (e.g. in tests).
const SESSION_SEED = Math.floor(Math.random() * 1e9);

// memoize the filtered palette per seed (building it runs randomColor over 60 colors)
const paletteCache = new Map();

/**
 * One random CSS color — a thin wrapper over `randomColor` (token-simulation's
 * generator). Prefer `getDistinctColor` when minting several in a row: it walks a
 * fixed palette, so successive colors stay well-separated.
 *
 * @param {object} [options] forwarded to `randomColor` (e.g. `{ seed, hue, luminosity }`)
 * @return {string} a CSS color, e.g. `"#3b82c4"`
 */
export function getRandomColor(options = {}) {
  return randomColor(options);
}

/**
 * The `index`-th color of a fixed, contrast-filtered palette (60 `randomColor` values
 * kept under the YIQ cutoff), cycled by `index` — the same scheme
 * bpmn-js-token-simulation uses to color scopes. Each color is visually distinct from
 * its neighbours; the sequence wraps after the palette length.
 *
 * @param {number} index 0,1,2,… — caller tracks its own counter
 * @param {{ seed?: number|string }} [options] `seed` pins the palette (deterministic tests)
 * @return {string} a CSS color, e.g. `"#3b82c4"`
 */
export function getDistinctColor(index, options = {}) {
  const { seed = SESSION_SEED } = options;
  const palette = getPalette(seed);
  const i = ((index % palette.length) + palette.length) % palette.length;
  return palette[i];
}

// --- internals --------------------------------------------------------------

function getPalette(seed) {
  let palette = paletteCache.get(seed);

  if (!palette) {
    palette = randomColor({ count: PALETTE_COUNT, seed }).filter(c => contrastYIQ(c) < YIQ_MAX);
    paletteCache.set(seed, palette);
  }

  return palette;
}

// YIQ brightness of a `#rrggbb` (or `rrggbb`) hex color — token-simulation's
// `getContrastYIQ`. Lower = darker.
function contrastYIQ(hexcolor) {
  const hex = hexcolor.charAt(0) === '#' ? hexcolor.slice(1) : hexcolor;
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}
