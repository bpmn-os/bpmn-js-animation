import { expect } from 'chai';

import { bootstrapPanel, cleanup, get, rows, rowNode } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';

// StartEvent_1 --Flow_1--> Task_1 --Flow_2--> EndEvent_1

const INSTANT = { animation: { animationDuration: 0 } };

// A token resting on `Flow_1` at the start event, which is what `sendToken` travels.
function departing(label) {
  return get('primitives').createToken('StartEvent_1', label, '#3399ff', { sequenceFlow: 'Flow_1' });
}

function hop(label) {
  return get('primitives').sendToken([ { node: 'StartEvent_1', label, sequenceFlow: 'Flow_1' } ]);
}

describe('TokenPanel', function() {

  describe('rows', function() {

    beforeEach(bootstrapPanel(linearXML, INSTANT));
    afterEach(cleanup);

    it('lists a token per node and label', function() {
      get('primitives').createToken('Task_1', 'I1', '#3399ff');
      get('primitives').createToken('EndEvent_1', 'I1', '#3399ff');

      expect(rows()).to.have.length(2);
      expect(rows().map(rowNode)).to.eql([ 'Task_1', 'EndEvent_1' ]);
    });

    it('keeps the row when its token hops, retagging the node', async function() {
      departing('I1');

      const row = rows()[0];
      expect(rowNode(row)).to.equal('StartEvent_1');

      await hop('I1');

      expect(rows()).to.have.length(1);
      expect(rows()[0]).to.equal(row);
      expect(rowNode(row)).to.equal('Task_1');
    });

    it('drops the row when its token is consumed at the node it reached', async function() {
      departing('I1');
      await hop('I1');

      get('primitives').removeToken('Task_1', 'I1', { sequenceFlow: 'Flow_1' });

      expect(rows()).to.have.length(0);
    });

  });

  describe('the host body renderer', function() {

    let drawn;

    beforeEach(bootstrapPanel(linearXML, {
      ...INSTANT,
      tokenPanel: {
        renderTokenDetail: (token, el) => {
          drawn.push({ node: token.node, label: token.label });
          el.textContent = `${token.node}/${token.label}`;
        }
      }
    }));

    beforeEach(function() {
      drawn = [];
    });

    afterEach(cleanup);

    it('makes every row expandable and draws its body', function() {
      get('primitives').createToken('Task_1', 'I1', '#3399ff');

      const row = rows()[0];
      expect(row.classList.contains('bjs-collapsible-entry-expandable')).to.be.true;
      expect(row.querySelector('.bjs-collapsible-entry-arrow')).to.exist;
      expect(row.querySelector('.bjs-collapsible-entry-entries').textContent).to.equal('Task_1/I1');
      expect(drawn).to.eql([ { node: 'Task_1', label: 'I1' } ]);
    });

    it('draws the body again when the row updates', function() {
      get('primitives').createToken('Task_1', 'I1', '#3399ff');
      drawn = [];

      get('primitives').setState('Task_1', 'I1', { animate: 'bounce' });

      expect(drawn).to.eql([ { node: 'Task_1', label: 'I1' } ]);
    });

    it('draws the body again, for the node it reached, when the token hops', async function() {
      departing('I1');
      drawn = [];

      await hop('I1');

      expect(drawn).to.eql([ { node: 'Task_1', label: 'I1' } ]);
      expect(rows()[0].querySelector('.bjs-collapsible-entry-entries').textContent).to.equal('Task_1/I1');
    });

  });

  describe('without a body renderer', function() {

    beforeEach(bootstrapPanel(linearXML, INSTANT));
    afterEach(cleanup);

    // A row with no body is not expandable and offers no caret to click. It may still *render* an
    // inert one, which is how the side panel keeps a plain row the same shape as an expandable one,
    // so what is asserted is that no usable caret is there rather than that no element is.
    it('leaves the rows unexpandable', function() {
      get('primitives').createToken('Task_1', 'I1', '#3399ff');

      const row = rows()[0];
      expect(row.classList.contains('bjs-collapsible-entry-expandable')).to.be.false;
      expect(row.querySelector('.bjs-collapsible-entry-arrow:not([disabled])')).to.not.exist;
      expect(row.querySelector('.bjs-collapsible-entry-entries')).to.not.exist;
    });

  });

});
