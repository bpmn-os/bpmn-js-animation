/**
 * CSS-color helpers for token identities.
 *
 * All three helpers share one idea: map a color onto a **2D plane** (hue/saturation
 * as Cartesian coordinates `x = s·cosH, y = s·sinH`, at a fixed lightness) and place
 * colors on a **circle** in that plane. They differ only in how they step around it:
 *
 *  - `getRandomColor`     — a single random point (legacy; no spacing guarantees).
 *  - `getDistinctColor`   — the i-th of an endless, maximally-distinct sequence:
 *                           a random session phase + deterministic golden-angle steps,
 *                           so successive colors never cluster and never exactly repeat.
 *  - `getRelatedColors`   — N evenly-spaced shades on a small ring around a base color,
 *                           so a parent token's instances read as one "family".
 *
 * The package never assigns colors itself; callers mint a color per identity and pass
 * it to `createToken`. Output is always an `hsl(...)` string, but any CSS color works
 * downstream. Working in HSL keeps every result in gamut (no clamping artifacts).
 */

const TAU = Math.PI * 2;

// The golden angle — the "most irrational" rotation, so stepping by it spreads a
// sequence as far apart as possible (and never lands on the same point twice).
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad (137.5°)

const DEFAULT_SATURATION = 0.65; // matches getRandomColor's 65%
const DEFAULT_LIGHTNESS = 0.45;  // matches getRandomColor's 45%

// Ring radius for related shades, in saturation/chroma units. Small = tightly
// related to the parent. Tunable.
const DEFAULT_RELATED_RADIUS = 0.18;

// One random phase per session: `getDistinctColor` defaults to it so the palette
// doesn't always begin on the same color, while the per-index golden-angle steps
// stay fully deterministic. Pass an explicit `startAngle` to pin it (e.g. in tests).
const SESSION_PHASE = Math.random() * TAU;

/**
 * Generate a random, reasonably distinct CSS color.
 *
 * Returns an `hsl(...)` string with a random hue and fixed saturation/lightness.
 * Prefer `getDistinctColor` when minting several colors in a row — random hue has no
 * memory, so two draws can land close by chance.
 *
 * @param {{ saturation?: number, lightness?: number }} [options]
 * @return {string} a CSS color, e.g. `"hsl(207, 65%, 45%)"`
 */
export function getRandomColor(options = {}) {
  const {
    saturation = 65,
    lightness = 45
  } = options;

  const hue = Math.floor(Math.random() * 360);

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * The `index`-th color of an endless, maximally-distinct sequence.
 *
 * Walks a circle of `radius` (in saturation units) around `center` in the hue/sat
 * plane, at angle `startAngle + index * step`. With the golden-angle `step`, the
 * sequence is evenly spread and never exactly repeats; `startAngle` defaults to a
 * random per-session phase (so it doesn't always start on the same color) and is
 * injectable for deterministic tests.
 *
 * @param {number} index  0,1,2,… — caller tracks its own counter
 * @param {{ center?: {x:number,y:number}, radius?: number, step?: number,
 *           startAngle?: number, lightness?: number }} [options]
 * @return {string} a CSS `hsl(...)` color
 */
export function getDistinctColor(index, options = {}) {
  const {
    center = { x: 0, y: 0 },
    radius = DEFAULT_SATURATION,
    step = GOLDEN_ANGLE,
    startAngle = SESSION_PHASE,
    lightness = DEFAULT_LIGHTNESS
  } = options;

  const angle = startAngle + index * step;
  const point = {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle)
  };

  return fromPlane(point, lightness);
}

/**
 * `count` related shades arranged on a ring around `base`.
 *
 * Every shade sits at the same `radius` from the base point (so they're equally
 * "related" to the parent) and they're spaced `2π/count` apart (so none coincide).
 * The ring's `startAngle` defaults to random per call — so the orientation, and the
 * first shade's color, vary per spawn — and is injectable for deterministic tests.
 * Lightness defaults to the base color's lightness.
 *
 * @param {string} base   a CSS color (`hsl(...)` or hex)
 * @param {number} count  number of shades
 * @param {{ radius?: number, startAngle?: number, lightness?: number }} [options]
 * @return {string[]} `count` CSS `hsl(...)` colors
 */
export function getRelatedColors(base, count, options = {}) {
  if (count <= 0) {
    return [];
  }

  const { h, s, l } = parseColor(base);
  const {
    radius = DEFAULT_RELATED_RADIUS,
    startAngle = Math.random() * TAU,
    lightness = l
  } = options;

  const basePoint = toPlane(h, s);
  const colors = [];

  for (let i = 0; i < count; i++) {
    const angle = startAngle + (i * TAU) / count;
    const point = {
      x: basePoint.x + radius * Math.cos(angle),
      y: basePoint.y + radius * Math.sin(angle)
    };
    colors.push(fromPlane(point, lightness));
  }

  return colors;
}

// --- internals --------------------------------------------------------------

// Hue (degrees) + saturation (0..1) → Cartesian point in the chroma plane.
function toPlane(hueDeg, saturation) {
  const rad = (hueDeg * Math.PI) / 180;
  return { x: saturation * Math.cos(rad), y: saturation * Math.sin(rad) };
}

// Cartesian point → an `hsl(...)` string at the given lightness. Saturation is the
// distance from the origin, clamped to [0,1] (so the result is always in gamut).
function fromPlane(point, lightness) {
  const hueDeg = ((Math.atan2(point.y, point.x) * 180) / Math.PI + 360) % 360;
  const saturation = clamp01(Math.hypot(point.x, point.y));
  return hslString(hueDeg, saturation, lightness);
}

function hslString(hueDeg, saturation, lightness) {
  return `hsl(${Math.round(hueDeg)}, ${Math.round(saturation * 100)}%, ${Math.round(
    clamp01(lightness) * 100
  )}%)`;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const HSL_RE = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i;

// Parse an hsl() or hex color → { h: 0..360, s: 0..1, l: 0..1 }.
function parseColor(color) {
  if (typeof color !== 'string') {
    throw new Error('getRelatedColors: base color must be a string, got ' + color);
  }

  const hsl = HSL_RE.exec(color);
  if (hsl) {
    return {
      h: parseFloat(hsl[1]),
      s: parseFloat(hsl[2]) / 100,
      l: parseFloat(hsl[3]) / 100
    };
  }

  const hex = parseHex(color);
  if (hex) {
    return rgbToHsl(hex.r, hex.g, hex.b);
  }

  throw new Error('getRelatedColors: unsupported base color "' + color + '" (use hsl() or hex)');
}

function parseHex(color) {
  let hex = color.trim();
  if (hex[0] !== '#') {
    return null;
  }
  hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) {
    return null;
  }
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255
  };
}

// Standard RGB (0..1 each) → HSL with h in degrees, s/l in 0..1.
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }

  return { h, s, l };
}
