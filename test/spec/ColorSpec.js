import { expect } from 'chai';

import {
  getRandomColor,
  getDistinctColor,
  getRelatedColors
} from '../../lib/index.js';

const HSL_RE = /^hsl\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)%\)$/;

function parse(hsl) {
  const m = HSL_RE.exec(hsl);
  expect(m, `"${hsl}" is not a valid hsl() string`).to.exist;
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

// shortest distance between two hues on the 0..360 circle
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}


describe('color', function() {

  describe('getRandomColor', function() {

    it('returns a valid hsl() string', function() {
      parse(getRandomColor());
    });

    it('honors saturation/lightness options', function() {
      const { s, l } = parse(getRandomColor({ saturation: 50, lightness: 30 }));
      expect(s).to.equal(50);
      expect(l).to.equal(30);
    });

  });


  describe('getDistinctColor', function() {

    it('is deterministic given an explicit startAngle', function() {
      const a = getDistinctColor(3, { startAngle: 0 });
      const b = getDistinctColor(3, { startAngle: 0 });
      expect(a).to.equal(b);
    });

    it('keeps lightness fixed across the sequence', function() {
      for (let i = 0; i < 8; i++) {
        expect(parse(getDistinctColor(i, { startAngle: 0 })).l).to.equal(45);
      }
    });

    it('spreads successive colors far apart in hue', function() {
      // golden-angle steps ⇒ adjacent indices are ~137.5° apart
      for (let i = 0; i < 12; i++) {
        const h1 = parse(getDistinctColor(i, { startAngle: 0 })).h;
        const h2 = parse(getDistinctColor(i + 1, { startAngle: 0 })).h;
        expect(hueGap(h1, h2)).to.be.greaterThan(60);
      }
    });

    it('does not repeat a hue within a reasonable run', function() {
      const hues = [];
      for (let i = 0; i < 16; i++) {
        hues.push(Math.round(parse(getDistinctColor(i, { startAngle: 0 })).h));
      }
      // every pair is at least a few degrees apart
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          expect(hueGap(hues[i], hues[j])).to.be.greaterThan(5);
        }
      }
    });

    it('rotates with startAngle (no fixed first color)', function() {
      const a = parse(getDistinctColor(0, { startAngle: 0 })).h;
      const b = parse(getDistinctColor(0, { startAngle: Math.PI })).h;
      expect(hueGap(a, b)).to.be.greaterThan(60);
    });

  });


  describe('getRelatedColors', function() {

    it('returns the requested count', function() {
      expect(getRelatedColors('hsl(207, 65%, 45%)', 4, { startAngle: 0 })).to.have.length(4);
    });

    it('returns [] for count <= 0', function() {
      expect(getRelatedColors('hsl(207, 65%, 45%)', 0)).to.deep.equal([]);
    });

    it('is deterministic given an explicit startAngle', function() {
      const a = getRelatedColors('hsl(207, 65%, 45%)', 3, { startAngle: 0 });
      const b = getRelatedColors('hsl(207, 65%, 45%)', 3, { startAngle: 0 });
      expect(a).to.deep.equal(b);
    });

    it('keeps shades in the same family (close hue to the base)', function() {
      const base = 207;
      const shades = getRelatedColors(`hsl(${base}, 65%, 45%)`, 4, { startAngle: 0 });
      shades.forEach(c => {
        expect(hueGap(parse(c).h, base)).to.be.lessThan(60);
      });
    });

    it('defaults lightness to the base color', function() {
      const shades = getRelatedColors('hsl(207, 65%, 30%)', 3, { startAngle: 0 });
      shades.forEach(c => expect(parse(c).l).to.equal(30));
    });

    it('makes the shades distinct from each other', function() {
      const shades = getRelatedColors('hsl(207, 65%, 45%)', 4, { startAngle: 0 });
      const set = new Set(shades);
      expect(set.size).to.equal(shades.length);
    });

    it('accepts a hex base color', function() {
      const shades = getRelatedColors('#3b82c4', 3, { startAngle: 0 });
      expect(shades).to.have.length(3);
      shades.forEach(parse);
    });

    it('throws on an unsupported base color', function() {
      expect(() => getRelatedColors('rebeccapurple', 2)).to.throw(/unsupported/);
    });

  });

});
