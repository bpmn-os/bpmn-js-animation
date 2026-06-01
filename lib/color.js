/**
 * Generate a random, reasonably distinct CSS color.
 *
 * This is a convenience for callers who want a color per token "identity"
 * (e.g. per instance): call it once, then pass the returned string to
 * `createToken` and reuse it for that identity so related tokens stay
 * consistent. The package never assigns colors itself.
 *
 * Returns an `hsl(...)` string with a random hue and fixed saturation/lightness,
 * so colors are vivid and uniformly readable. Any CSS color works downstream,
 * so you can equally pass your own palette instead of using this.
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
