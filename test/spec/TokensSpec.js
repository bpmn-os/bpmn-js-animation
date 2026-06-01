import { expect } from 'chai';

import {
  bootstrap,
  cleanup,
  get,
  dots,
  marker
} from '../TestHelper';

import { getRandomColor } from '../../lib/index.js';

import diagramXML from '../diagram.bpmn';

function dotAt(node) {
  return document.querySelector(`.bts-token-count[data-node-id="${node}"]`);
}

function tok(node, label) {
  return get('tokens').getTokens(t => t.node === node && t.label === label)[0];
}

function transition(node, label, flow) {
  return { node, label, flow };
}


describe('tokens', function() {

  // duration 0 => animations land instantly, so most assertions are synchronous
  beforeEach(bootstrap(diagramXML, { tokenAnimation: { duration: 0 } }));
  afterEach(cleanup);


  describe('createToken', function() {

    it('renders a colored dot with the label on hover', function() {
      get('tokens').createToken('StartEvent_1', 'A', 'tomato');

      expect(dots()).to.have.length(1);

      const dot = dots()[0];

      expect(dot.getAttribute('title')).to.equal('A');
      expect(dot.dataset.label).to.equal('A');
      expect(dot.dataset.nodeId).to.equal('StartEvent_1');
      expect(dot.getAttribute('style')).to.contain('tomato');
    });


    it('accepts any CSS color', function() {
      const tokens = get('tokens');

      tokens.createToken('Task_1', 'A', 'rgb(49, 130, 189)');
      tokens.createToken('Task_2', 'B', '#3399ff');
      tokens.createToken('Task_3', 'C', 'hsl(120, 60%, 45%)');

      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(49, 130, 189)');
      expect(dotAt('Task_2').getAttribute('style')).to.contain('#3399ff');
      expect(dotAt('Task_3').getAttribute('style')).to.contain('hsl(120, 60%, 45%)');
    });


    it('replaces an existing token at the same (node, label)', function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.createToken('StartEvent_1', 'A', 'steelblue');

      expect(dots()).to.have.length(1);
      expect(dots()[0].getAttribute('style')).to.contain('steelblue');
    });


    it('requires a color', function() {
      expect(() => get('tokens').createToken('StartEvent_1', 'A')).to.throw(/color is required/);
    });


    it('rejects an unknown node', function() {
      expect(() => get('tokens').createToken('Nope', 'A', 'tomato')).to.throw(/unknown node/);
    });

  });


  describe('sendToken', function() {

    it('moves a token along a single flow', async function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const result = await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      expect(result.map(t => t.node)).to.eql([ 'Task_1' ]);
      expect(tok('Task_1', 'A')).to.exist;
      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dotAt('Task_1')).to.exist;
      expect(dotAt('StartEvent_1')).to.not.exist;
    });


    it('splits a token across several flows', async function() {
      const tokens = get('tokens');

      tokens.createToken('Gateway_1', 'A', 'tomato');

      const result = await tokens.sendToken([
        transition('Gateway_1', 'A', 'Flow_3'),
        transition('Gateway_1', 'A', 'Flow_4')
      ]);

      expect(result.map(t => t.node).sort()).to.eql([ 'Task_2', 'Task_3' ]);
      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(2);
      expect(dotAt('Task_2')).to.exist;
      expect(dotAt('Task_3')).to.exist;
    });


    it('keeps the color across a move', async function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'rgb(1, 2, 3)');
      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      expect(tok('Task_1', 'A').color).to.equal('rgb(1, 2, 3)');
      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(1, 2, 3)');
    });


    it('settles an in-flight transition before the next send (no overlap)', async function() {

      // a real (non-zero) duration so the first transition is genuinely in flight
      cleanup();
      await bootstrap(diagramXML, { tokenAnimation: { duration: 40 } })();

      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      // first transition left in flight
      const p1 = tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      // a second send while p1 is still animating must settle it first
      const p2 = tokens.sendToken([ transition('Task_1', 'A', 'Flow_2') ]);

      const [ landed1 ] = await Promise.all([ p1, p2 ]);

      expect(landed1[0].node).to.equal('Task_1');  // p1 was settled at its target
      expect(tok('Gateway_1', 'A')).to.exist;       // p2 landed
      expect(tok('Task_1', 'A')).to.not.exist;
      expect(dots()).to.have.length(1);
    });


    it('rewinds along an incoming flow', async function() {
      const tokens = get('tokens');

      tokens.createToken('Task_1', 'A', 'tomato');

      // Flow_1 is StartEvent_1 -> Task_1; sending from Task_1 along it rewinds
      const result = await tokens.sendToken([ transition('Task_1', 'A', 'Flow_1') ]);

      expect(result.map(t => t.node)).to.eql([ 'StartEvent_1' ]);
      expect(tok('StartEvent_1', 'A')).to.exist;
      expect(tok('Task_1', 'A')).to.not.exist;
    });


    it('joins several sources into one node (rewind of a split)', async function() {
      const tokens = get('tokens');

      tokens.createToken('Task_2', 'A', 'tomato');
      tokens.createToken('Task_3', 'A', 'tomato');

      // send both back along their incoming flows -> both land at Gateway_1
      const result = await tokens.sendToken([
        transition('Task_2', 'A', 'Flow_3'),
        transition('Task_3', 'A', 'Flow_4')
      ]);

      expect(result.map(t => t.node)).to.eql([ 'Gateway_1', 'Gateway_1' ]);
      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(1); // merged
      expect(tok('Gateway_1', 'A')).to.exist;
    });


    it('rejects a flow not connected to the node', async function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      let err;
      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_2') ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/is not connected to/);
    });

  });


  describe('removeToken', function() {

    it('removes the token and its dot', function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.removeToken('StartEvent_1', 'A');

      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dots()).to.have.length(0);
    });

  });


  describe('overflow', function() {

    it('caps visible dots and shows a "+N" marker', function() {
      const tokens = get('tokens');

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      // default maxVisible = 3, 5 > 3 + 1 -> 3 dots + "+2"
      expect(dots()).to.have.length(3);
      expect(marker()).to.exist;
      expect(marker().textContent.trim()).to.equal('+2');
    });


    it('shows all when overflow would be just one', function() {
      const tokens = get('tokens');

      for (let i = 1; i <= 4; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      expect(dots()).to.have.length(4);
      expect(marker()).to.not.exist;
    });


    it('respects a custom maxVisible', function() {
      cleanup();

      return bootstrap(diagramXML, { tokenAnimation: { maxVisible: 1 } })().then(() => {
        const tokens = get('tokens');

        for (let i = 1; i <= 3; i++) {
          tokens.createToken('Gateway_1', 'S' + i, 'tomato');
        }

        expect(dots()).to.have.length(1);
        expect(marker().textContent.trim()).to.equal('+2');
      });
    });

  });


  describe('events', function() {

    it('fires token.click with { node, label }', function() {
      const tokens = get('tokens');

      let fired;
      get('eventBus').on('token.click', e => (fired = e));

      tokens.createToken('Task_1', 'A', 'tomato');
      dotAt('Task_1').click();

      expect(fired).to.exist;
      expect(fired.node).to.equal('Task_1');
      expect(fired.label).to.equal('A');
    });


    it('fires token.overflow.click with the hidden tokens', function() {
      const tokens = get('tokens');

      let fired;
      get('eventBus').on('token.overflow.click', e => (fired = e));

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      marker().click();

      expect(fired).to.exist;
      expect(fired.node).to.equal('Gateway_1');
      expect(fired.hidden).to.have.length(2);
    });

  });


  describe('setDuration', function() {

    it('changes the global transition duration', function() {
      get('tokens').setDuration(250);

      expect(get('animation').getDuration()).to.equal(250);
    });

  });


  describe('getRandomColor', function() {

    it('returns a CSS hsl() color', function() {
      expect(getRandomColor()).to.match(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

  });

});
