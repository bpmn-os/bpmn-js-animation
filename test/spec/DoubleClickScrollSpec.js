import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import diagramXML from '../diagram.bpmn';

// Built-in viewer interaction: double-click a stacked node to scroll its instances
// (Shift = backward). On by default; `config.animation.scrollOnDoubleClick: false` disables.

function fireDblClick(id, shiftKey) {
  get('eventBus').fire('element.dblclick', {
    element: get('elementRegistry').get(id),
    originalEvent: { shiftKey: !!shiftKey }
  });
}

// replace scrollStack with a recorder (timing-independent)
function spyScroll() {
  const calls = [];
  get('primitives').scrollStack = (node, dir) => {
    calls.push([ node, dir ]);
    return Promise.resolve();
  };
  return calls;
}


describe('double-click to scroll', function() {

  describe('enabled by default', function() {

    beforeEach(bootstrap(diagramXML));
    afterEach(cleanup);

    it('scrolls a stacked node forward, Shift = backward', function() {
      get('primitives').setStackSize('Task_1', 3);
      const calls = spyScroll();

      fireDblClick('Task_1');
      fireDblClick('Task_1', true);

      expect(calls).to.eql([ [ 'Task_1', 'forward' ], [ 'Task_1', 'backward' ] ]);
    });

    it('ignores a node that is not stacked', function() {
      const calls = spyScroll();
      fireDblClick('Task_1'); // no stack set
      expect(calls).to.have.length(0);
    });

  });


  describe('disabled via config', function() {

    beforeEach(bootstrap(diagramXML, { animation: { scrollOnDoubleClick: false } }));
    afterEach(cleanup);

    it('does not scroll on double-click', function() {
      get('primitives').setStackSize('Task_1', 3);
      const calls = spyScroll();

      fireDblClick('Task_1');

      expect(calls).to.have.length(0);
    });

  });

});
