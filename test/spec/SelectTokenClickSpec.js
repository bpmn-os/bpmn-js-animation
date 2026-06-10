import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import { getRandomColor } from '../../lib/index.js';

import diagramXML from '../diagram.bpmn';

// Built-in viewer interaction: click a token to select it (blue ring) — sole-select, or
// toggle within the selection with Shift. On by default; `selectTokenOnClick: false` disables.

const POS = { position: { left: 0.5, top: 0.5 } };

function add(node, label) {
  get('primitives').createToken(node, label, getRandomColor(), POS);
}
function clickToken(node, label, shiftKey) {
  get('eventBus').fire('token.click', {
    node, label, sequenceFlow: null, stackIndices: {},
    originalEvent: { shiftKey: !!shiftKey }
  });
}
const selectedLabels = () => get('primitives').getTokens(t => t.selected).map(t => t.label).sort();


describe('click to select token', function() {

  describe('enabled by default', function() {

    beforeEach(bootstrap(diagramXML));
    afterEach(cleanup);

    it('sole-selects on a plain click, clearing the rest', function() {
      add('Task_1', 'A');
      add('Task_2', 'B');

      clickToken('Task_1', 'A');
      expect(selectedLabels()).to.eql([ 'A' ]);

      clickToken('Task_2', 'B');
      expect(selectedLabels()).to.eql([ 'B' ]); // A cleared
    });

    it('toggles off when clicking the sole selection', function() {
      add('Task_1', 'A');

      clickToken('Task_1', 'A');
      expect(selectedLabels()).to.eql([ 'A' ]);

      clickToken('Task_1', 'A');
      expect(selectedLabels()).to.eql([]);
    });

    it('Shift toggles within the selection (multi-select)', function() {
      add('Task_1', 'A');
      add('Task_2', 'B');

      clickToken('Task_1', 'A');
      clickToken('Task_2', 'B', true);
      expect(selectedLabels()).to.eql([ 'A', 'B' ]);

      clickToken('Task_2', 'B', true);
      expect(selectedLabels()).to.eql([ 'A' ]);
    });

  });


  describe('disabled via config', function() {

    beforeEach(bootstrap(diagramXML, { animation: { selectTokenOnClick: false } }));
    afterEach(cleanup);

    it('does not select on click', function() {
      add('Task_1', 'A');
      clickToken('Task_1', 'A');
      expect(selectedLabels()).to.eql([]);
    });

  });

});
