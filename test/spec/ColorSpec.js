import { expect } from 'chai';

import {
  getRandomColor,
  getDistinctColor
} from '../../lib/index.js';

const HEX_RE = /^#[0-9a-f]{6}$/i;

// YIQ brightness of a `#rrggbb` hex color (token-simulation's getContrastYIQ)
function contrastYIQ(hex) {
  const h = hex.slice(1);
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}


describe('color', function() {

  describe('getRandomColor', function() {

    it('returns a hex color', function() {
      expect(getRandomColor()).to.match(HEX_RE);
    });

    it('is deterministic given a seed', function() {
      expect(getRandomColor({ seed: 42 })).to.equal(getRandomColor({ seed: 42 }));
    });

  });


  describe('getDistinctColor', function() {

    it('returns a hex color', function() {
      expect(getDistinctColor(0, { seed: 1 })).to.match(HEX_RE);
    });

    it('is deterministic given a seed', function() {
      expect(getDistinctColor(3, { seed: 1 })).to.equal(getDistinctColor(3, { seed: 1 }));
    });

    it('walks distinct colors across a run (the palette has no immediate repeats)', function() {
      const colors = [];
      for (let i = 0; i < 16; i++) {
        colors.push(getDistinctColor(i, { seed: 1 }));
      }
      // every entry within the palette length is unique
      expect(new Set(colors).size).to.equal(colors.length);
    });

    it('cycles the palette (wraps after its length)', function() {
      const first = getDistinctColor(0, { seed: 1 });

      // the palette length is the first index > 0 whose color repeats index 0
      let len = 1;
      while (getDistinctColor(len, { seed: 1 }) !== first && len < 100) {
        len++;
      }

      // index len wraps to index 0, and one before it does not
      expect(getDistinctColor(len, { seed: 1 })).to.equal(first);
      expect(getDistinctColor(len + 3, { seed: 1 })).to.equal(getDistinctColor(3, { seed: 1 }));
    });

    it('keeps every palette color under the contrast cutoff (readable on a light canvas)', function() {
      for (let i = 0; i < 30; i++) {
        expect(contrastYIQ(getDistinctColor(i, { seed: 1 }))).to.be.lessThan(200);
      }
    });

    it('varies the palette with the seed', function() {
      const a = getDistinctColor(0, { seed: 1 });
      const b = getDistinctColor(0, { seed: 2 });
      expect(a).to.not.equal(b);
    });

  });

});
