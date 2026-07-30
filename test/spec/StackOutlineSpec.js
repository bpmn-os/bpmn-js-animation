import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';

/**
 * A stacked node's selection outline is grown to wrap the whole stack, and is sized from an inset of this
 * package's own. diagram-js does not expose the inset it uses — the field was `offset` up to 15.14 and
 * `_outlineOffset` after — and reading it yielded `undefined` against the other version, hence `-undefined`,
 * hence `x="NaN"`, which the SVG discards in silence and the outline collapsed to nothing at the origin.
 * So the geometry must be finite whatever the service happens to carry, and an unstacked node is left to the
 * library.
 */

describe('the outline of a stacked node', function() {

  beforeEach(bootstrap(linearXML));
  afterEach(cleanup);

  const task = () => get('elementRegistry').get('Task_1');

  // selecting an element is what makes diagram-js draw and size its outline
  function outlineOf(element) {
    get('selection').select(null);
    get('selection').select(element);

    return get('elementRegistry').getGraphics(element).querySelector('.djs-outline');
  }

  function geometry(outline) {
    return [ 'x', 'y', 'width', 'height' ].map(name => Number(outline.getAttribute(name)));
  }

  it('is sized from the stack, whatever the service carries', function() {
    const outline = get('outline');

    get('primitives').setStacks(task().id, [ 0, 1, 2 ]);

    // neither the field diagram-js used to carry nor the one it carries now is depended upon
    delete outline.offset;
    delete outline._outlineOffset;

    const geo = geometry(outlineOf(task()));

    expect(geo.every(Number.isFinite), 'the geometry is finite').to.be.true;
    expect(geo[2]).to.be.above(task().width, 'and wraps the stack, which is wider than the node');
  });

  it('leaves an unstacked node to the library', function() {
    const outline = get('outline');

    delete outline.offset;
    delete outline._outlineOffset;

    expect(geometry(outlineOf(task())).every(Number.isFinite)).to.be.true;
  });
});
