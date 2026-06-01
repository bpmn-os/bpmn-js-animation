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

function transition(node, label, sequenceFlow, state) {
  return { node, label, sequenceFlow, state };
}


describe('tokens', function() {

  // duration 0 => animations land instantly, so most assertions are synchronous
  beforeEach(bootstrap(diagramXML, { tokenAnimation: { animationDuration: 0 } }));
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


    it('replaces an existing token at the same identity', function() {
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


  describe('state', function() {

    it('defaults to below-left, bouncing', function() {
      get('tokens').createToken('Task_1', 'A', 'tomato');

      const dot = dots()[0];

      expect(dot.dataset.position).to.equal('below-left');
      expect(dot.dataset.bounce).to.equal('true');
      expect(dot.classList.contains('bts-bounce')).to.be.true;
    });


    it('honors an explicit position and bounce', function() {
      get('tokens').createToken('Task_1', 'A', 'tomato', { position: 'center-middle', bounce: false });

      const dot = dots()[0];

      expect(dot.dataset.position).to.equal('center-middle');
      expect(dot.classList.contains('bts-bounce')).to.be.false;
    });


    it('rests on a sequence flow', function() {
      get('tokens').createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });

      const dot = dotAt('Gateway_1');

      expect(dot.dataset.sequenceFlow).to.equal('Flow_3');
      expect(dot.dataset.position).to.equal('');
    });


    it('renders distinct positions as separate overlays', function() {
      const tokens = get('tokens');

      tokens.createToken('Task_1', 'A', 'tomato', { position: 'above-left' });
      tokens.createToken('Task_1', 'B', 'steelblue', { position: 'below-right' });

      // two location clusters -> two overlay containers
      expect(document.querySelectorAll('.bts-token-count-parent')).to.have.length(2);
    });


    it('rejects position and sequenceFlow together', function() {
      expect(() => get('tokens').createToken('Task_1', 'A', 'tomato', { position: 'center-middle', sequenceFlow: 'Flow_2' }))
        .to.throw(/mutually exclusive/);
    });


    it('rejects an invalid position', function() {
      expect(() => get('tokens').createToken('Task_1', 'A', 'tomato', { position: 'middle-center' }))
        .to.throw(/invalid position/);
    });


    describe('setState (partial merge)', function() {

      it('toggles bounce without moving', function() {
        const tokens = get('tokens');

        tokens.createToken('Task_1', 'A', 'tomato', { position: 'center-middle', bounce: true });
        tokens.setState('Task_1', 'A', { bounce: false });

        const t = tok('Task_1', 'A');

        expect(t.state.position).to.equal('center-middle');
        expect(t.state.bounce).to.equal(false);
        expect(dotAt('Task_1').classList.contains('bts-bounce')).to.be.false;
      });


      it('setting position clears sequenceFlow', function() {
        const tokens = get('tokens');

        tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
        tokens.setState('Gateway_1', 'A', { position: 'center-right' }, 'Flow_3');

        const t = tok('Gateway_1', 'A');

        expect(t.state.sequenceFlow).to.equal(null);
        expect(t.state.position).to.equal('center-right');
      });

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


    it('lands in the given state', async function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1', { position: 'center-middle', bounce: false }) ]);

      expect(tok('Task_1', 'A').state.position).to.equal('center-middle');
      expect(dotAt('Task_1').classList.contains('bts-bounce')).to.be.false;
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
      await bootstrap(diagramXML, { tokenAnimation: { animationDuration: 40 } })();

      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const p1 = tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);
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


    it('rejects a flow not connected to the node', async function() {
      const tokens = get('tokens');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      let err;
      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_2') ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/is not connected to/);
    });

  });


  describe('identity (rest sequenceFlow)', function() {

    it('lets same-label tokens coexist on different flows at one node', async function() {
      const tokens = get('tokens');

      tokens.createToken('Task_2', 'A', 'tomato');
      tokens.createToken('Task_3', 'A', 'tomato');

      // both arrive at the gateway resting on their own incoming flow
      await tokens.sendToken([
        transition('Task_2', 'A', 'Flow_3', { sequenceFlow: 'Flow_3' }),
        transition('Task_3', 'A', 'Flow_4', { sequenceFlow: 'Flow_4' })
      ]);

      const at = tokens.getTokens(t => t.node === 'Gateway_1' && t.label === 'A');

      expect(at).to.have.length(2);
      expect(at.map(t => t.state.sequenceFlow).sort()).to.eql([ 'Flow_3', 'Flow_4' ]);
      expect(document.querySelectorAll('.bts-token-count[data-node-id="Gateway_1"]')).to.have.length(2);
    });


    it('merges when both move to a shared anchor', function() {
      const tokens = get('tokens');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(2);

      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_3');
      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_4');

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(1);
    });


    it('removeToken addresses a token by sequenceFlow', function() {
      const tokens = get('tokens');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      tokens.removeToken('Gateway_1', 'A', 'Flow_3');

      const at = tokens.getTokens(t => t.label === 'A');

      expect(at).to.have.length(1);
      expect(at[0].state.sequenceFlow).to.equal('Flow_4');
    });


    it('rejects sendToken when the source is ambiguous', async function() {
      const tokens = get('tokens');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      let err;
      await tokens.sendToken([ transition('Gateway_1', 'A', 'Flow_3') ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/multiple tokens/);
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

    it('fires token.click with { node, label, sequenceFlow }', function() {
      const tokens = get('tokens');

      let fired;
      get('eventBus').on('token.click', e => (fired = e));

      tokens.createToken('Task_1', 'A', 'tomato');
      dotAt('Task_1').click();

      expect(fired).to.exist;
      expect(fired.node).to.equal('Task_1');
      expect(fired.label).to.equal('A');
      expect(fired.sequenceFlow).to.equal(null);
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


  describe('setFilter', function() {

    it('hides non-matching tokens (kept, not removed)', function() {
      const tokens = get('tokens');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      expect(dots()).to.have.length(2);

      tokens.setFilter(t => t.color === 'tomato');

      expect(dots()).to.have.length(1);
      expect(dots()[0].dataset.label).to.equal('A');
      expect(tokens.getTokens()).to.have.length(2); // still there
    });


    it('setFilter(null) shows all again', function() {
      const tokens = get('tokens');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      tokens.setFilter(t => t.label === 'A');
      expect(dots()).to.have.length(1);

      tokens.setFilter(null);
      expect(dots()).to.have.length(2);
    });


    it('hidden tokens do not count toward the overflow cap', function() {
      const tokens = get('tokens');

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, i <= 2 ? 'tomato' : 'steelblue');
      }
      expect(dots()).to.have.length(3);
      expect(marker()).to.exist;

      tokens.setFilter(t => t.color === 'tomato');

      expect(dots()).to.have.length(2);
      expect(marker()).to.not.exist;
    });

  });


  describe('setAnimationDuration', function() {

    it('changes the global animation duration', function() {
      get('tokens').setAnimationDuration(250);

      expect(get('animation').getAnimationDuration()).to.equal(250);
    });

  });


  describe('animateSymbol', function() {

    function symbol() {
      return document.querySelector('.bts-symbol');
    }

    it('emits the symbol of a throwing element (send task / message end)', function() {
      get('tokens').animateSymbol('Task_2'); // send task -> throwing

      const g = document.querySelector('.bts-symbol-emit');
      expect(g).to.exist;
      expect(g.querySelector('path')).to.exist; // a cloned symbol path
    });


    it('draws in the symbol of a catching element (receive task / message start)', function() {
      get('tokens').animateSymbol('StartEvent_1'); // message start -> catching

      expect(document.querySelector('.bts-symbol-receive')).to.exist;
    });


    it('throwing vs catching is detected from the element type', function() {
      const tokens = get('tokens');

      tokens.animateSymbol('EndEvent_1');   // message end -> emit
      tokens.animateSymbol('Task_3');       // receive task -> receive

      expect(document.querySelector('.bts-symbol-emit')).to.exist;
      expect(document.querySelector('.bts-symbol-receive')).to.exist;
    });


    it('animates a typed task (except send) as catching', function() {
      get('tokens').animateSymbol('Task_1'); // user task -> catching

      expect(document.querySelector('.bts-symbol-receive')).to.exist;
    });


    it('is a no-op for an element with no symbol', async function() {
      await get('tokens').animateSymbol('EndEvent_2'); // plain end event

      expect(symbol()).to.not.exist;
    });


    it('removes the symbol and resolves when done', async function() {
      await get('tokens').animateSymbol('Task_2');

      expect(symbol()).to.not.exist;
    });

  });


  describe('getRandomColor', function() {

    it('returns a CSS hsl() color', function() {
      expect(getRandomColor()).to.match(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

  });

});
