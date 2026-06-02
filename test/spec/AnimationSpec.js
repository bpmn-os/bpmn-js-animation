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
  return get('animation').getTokens(t => t.node === node && t.label === label)[0];
}

function transition(node, label, sequenceFlow, state) {
  return { node, label, sequenceFlow, state };
}


describe('animation', function() {

  // duration 0 => animations land instantly, so most assertions are synchronous
  beforeEach(bootstrap(diagramXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);


  describe('createToken', function() {

    it('renders a colored dot with the label on hover', function() {
      get('animation').createToken('StartEvent_1', 'A', 'tomato');

      expect(dots()).to.have.length(1);

      const dot = dots()[0];

      expect(dot.getAttribute('title')).to.equal('A');
      expect(dot.dataset.label).to.equal('A');
      expect(dot.dataset.nodeId).to.equal('StartEvent_1');
      expect(dot.getAttribute('style')).to.contain('tomato');
    });


    it('accepts any CSS color', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'rgb(49, 130, 189)');
      tokens.createToken('Task_2', 'B', '#3399ff');
      tokens.createToken('Task_3', 'C', 'hsl(120, 60%, 45%)');

      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(49, 130, 189)');
      expect(dotAt('Task_2').getAttribute('style')).to.contain('#3399ff');
      expect(dotAt('Task_3').getAttribute('style')).to.contain('hsl(120, 60%, 45%)');
    });


    it('replaces an existing token at the same identity', function() {
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.createToken('StartEvent_1', 'A', 'steelblue');

      expect(dots()).to.have.length(1);
      expect(dots()[0].getAttribute('style')).to.contain('steelblue');
    });


    it('requires a color', function() {
      expect(() => get('animation').createToken('StartEvent_1', 'A')).to.throw(/color is required/);
    });


    it('rejects an unknown node', function() {
      expect(() => get('animation').createToken('Nope', 'A', 'tomato')).to.throw(/unknown node/);
    });

  });


  describe('state', function() {

    it('defaults to below-left, bouncing', function() {
      get('animation').createToken('Task_1', 'A', 'tomato');

      const dot = dots()[0];

      expect(dot.dataset.position).to.equal('below-left');
      expect(dot.dataset.bounce).to.equal('true');
      expect(dot.classList.contains('bts-bounce')).to.be.true;
    });


    it('honors an explicit position and bounce', function() {
      get('animation').createToken('Task_1', 'A', 'tomato', { position: 'center-middle', bounce: false });

      const dot = dots()[0];

      expect(dot.dataset.position).to.equal('center-middle');
      expect(dot.classList.contains('bts-bounce')).to.be.false;
    });


    it('rests on a sequence flow', function() {
      get('animation').createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });

      const dot = dotAt('Gateway_1');

      expect(dot.dataset.sequenceFlow).to.equal('Flow_3');
      expect(dot.dataset.position).to.equal('');
    });


    it('renders distinct positions as separate overlays', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato', { position: 'above-left' });
      tokens.createToken('Task_1', 'B', 'steelblue', { position: 'below-right' });

      // two location clusters -> two overlay containers
      expect(document.querySelectorAll('.bts-token-count-parent')).to.have.length(2);
    });


    it('rejects position and sequenceFlow together', function() {
      expect(() => get('animation').createToken('Task_1', 'A', 'tomato', { position: 'center-middle', sequenceFlow: 'Flow_2' }))
        .to.throw(/mutually exclusive/);
    });


    it('rejects an invalid position', function() {
      expect(() => get('animation').createToken('Task_1', 'A', 'tomato', { position: 'middle-center' }))
        .to.throw(/invalid position/);
    });


    describe('setState (partial merge)', function() {

      it('toggles bounce without moving', function() {
        const tokens = get('animation');

        tokens.createToken('Task_1', 'A', 'tomato', { position: 'center-middle', bounce: true });
        tokens.setState('Task_1', 'A', { bounce: false });

        const t = tok('Task_1', 'A');

        expect(t.state.position).to.equal('center-middle');
        expect(t.state.bounce).to.equal(false);
        expect(dotAt('Task_1').classList.contains('bts-bounce')).to.be.false;
      });


      it('setting position clears sequenceFlow', function() {
        const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const result = await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      expect(result.map(t => t.node)).to.eql([ 'Task_1' ]);
      expect(tok('Task_1', 'A')).to.exist;
      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dotAt('Task_1')).to.exist;
      expect(dotAt('StartEvent_1')).to.not.exist;
    });


    it('lands in the given state', async function() {
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1', { position: 'center-middle', bounce: false }) ]);

      expect(tok('Task_1', 'A').state.position).to.equal('center-middle');
      expect(dotAt('Task_1').classList.contains('bts-bounce')).to.be.false;
    });


    it('splits a token across several flows', async function() {
      const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'rgb(1, 2, 3)');
      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      expect(tok('Task_1', 'A').color).to.equal('rgb(1, 2, 3)');
      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(1, 2, 3)');
    });


    it('settles an in-flight transition before the next send (no overlap)', async function() {

      // a real (non-zero) duration so the first transition is genuinely in flight
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');

      // Flow_1 is StartEvent_1 -> Task_1; sending from Task_1 along it rewinds
      const result = await tokens.sendToken([ transition('Task_1', 'A', 'Flow_1') ]);

      expect(result.map(t => t.node)).to.eql([ 'StartEvent_1' ]);
      expect(tok('StartEvent_1', 'A')).to.exist;
      expect(tok('Task_1', 'A')).to.not.exist;
    });


    it('rejects a flow not connected to the node', async function() {
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      let err;
      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_2') ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/is not connected to/);
    });

  });


  describe('identity (rest sequenceFlow)', function() {

    it('lets same-label tokens coexist on different flows at one node', async function() {
      const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(2);

      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_3');
      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_4');

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(1);
    });


    it('removeToken addresses a token by sequenceFlow', function() {
      const tokens = get('animation');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      tokens.removeToken('Gateway_1', 'A', 'Flow_3');

      const at = tokens.getTokens(t => t.label === 'A');

      expect(at).to.have.length(1);
      expect(at[0].state.sequenceFlow).to.equal('Flow_4');
    });


    it('rejects sendToken when the source is ambiguous', async function() {
      const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.removeToken('StartEvent_1', 'A');

      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dots()).to.have.length(0);
    });

  });


  describe('overflow', function() {

    it('caps visible dots and shows a "+N" marker', function() {
      const tokens = get('animation');

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      // default maxVisible = 3, 5 > 3 + 1 -> 3 dots + "+2"
      expect(dots()).to.have.length(3);
      expect(marker()).to.exist;
      expect(marker().textContent.trim()).to.equal('+2');
    });


    it('shows all when overflow would be just one', function() {
      const tokens = get('animation');

      for (let i = 1; i <= 4; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      expect(dots()).to.have.length(4);
      expect(marker()).to.not.exist;
    });


    it('respects a custom maxVisible', function() {
      cleanup();

      return bootstrap(diagramXML, { animation: { maxVisible: 1 } })().then(() => {
        const tokens = get('animation');

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
      const tokens = get('animation');

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
      const tokens = get('animation');

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
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      expect(dots()).to.have.length(2);

      tokens.setFilter(t => t.color === 'tomato');

      expect(dots()).to.have.length(1);
      expect(dots()[0].dataset.label).to.equal('A');
      expect(tokens.getTokens()).to.have.length(2); // still there
    });


    it('setFilter(null) shows all again', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      tokens.setFilter(t => t.label === 'A');
      expect(dots()).to.have.length(1);

      tokens.setFilter(null);
      expect(dots()).to.have.length(2);
    });


    it('hidden tokens do not count toward the overflow cap', function() {
      const tokens = get('animation');

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, i <= 2 ? 'tomato' : 'steelblue');
      }
      expect(dots()).to.have.length(3);
      expect(marker()).to.exist;

      tokens.setFilter(t => t.color === 'tomato');

      expect(dots()).to.have.length(2);
      expect(marker()).to.not.exist;
    });


    it('the "+N" marker counts only matching tokens', function() {
      const tokens = get('animation');

      // 6 tomato + 3 steelblue at one location
      for (let i = 1; i <= 9; i++) {
        tokens.createToken('Gateway_1', 'S' + i, i <= 6 ? 'tomato' : 'steelblue');
      }

      // unfiltered: 3 dots + "+6" (all 9)
      expect(dots()).to.have.length(3);
      expect(marker().textContent.trim()).to.equal('+6');

      tokens.setFilter(t => t.color === 'tomato');

      // filtered: 6 match -> 3 dots + "+3" (hidden steelblue ignored)
      expect(dots()).to.have.length(3);
      expect(marker().textContent.trim()).to.equal('+3');
    });

  });


  describe('selection', function() {

    it('selectToken draws a blue ring on the resting dot', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');
      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.false;

      tokens.selectToken('Task_1', 'A');

      const dot = dotAt('Task_1');
      expect(dot.classList.contains('bts-selected')).to.be.true;
      expect(dot.dataset.selected).to.equal('true');
      expect(tok('Task_1', 'A').selected).to.be.true;
    });


    it('deselectToken clears it', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.selectToken('Task_1', 'A');
      tokens.deselectToken('Task_1', 'A');

      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.false;
      expect(tok('Task_1', 'A').selected).to.be.false;
    });


    it('rejects selecting a missing token', function() {
      expect(() => get('animation').selectToken('Task_1', 'A')).to.throw(/no token/);
    });


    it('carries the selection across a move', async function() {
      const tokens = get('animation');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.selectToken('StartEvent_1', 'A');

      await tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);

      expect(tok('Task_1', 'A').selected).to.be.true;
      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.true;
    });


    it('shows the selection ring on the token while it moves', async function() {
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('animation');
      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.selectToken('StartEvent_1', 'A');

      // _move appends the moving graphic synchronously, so the ring is present in flight
      const p = tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);
      expect(document.querySelector('.bts-token .bts-token-ring')).to.exist;

      await p;
    });


    it('omits the ring on an unselected moving token', async function() {
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('animation');
      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const p = tokens.sendToken([ transition('StartEvent_1', 'A', 'Flow_1') ]);
      expect(document.querySelector('.bts-token .bts-token-ring')).to.not.exist;

      await p;
    });


    it('copies the selection to every branch on a split', async function() {
      const tokens = get('animation');

      tokens.createToken('Gateway_1', 'A', 'tomato');
      tokens.selectToken('Gateway_1', 'A');

      await tokens.sendToken([
        transition('Gateway_1', 'A', 'Flow_3'),
        transition('Gateway_1', 'A', 'Flow_4')
      ]);

      expect(tok('Task_2', 'A').selected).to.be.true;
      expect(tok('Task_3', 'A').selected).to.be.true;
    });


    it('OR-merges the selection on a join', function() {
      const tokens = get('animation');

      // one selected + one not, both heading to a shared anchor
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });
      tokens.selectToken('Gateway_1', 'A', 'Flow_3');

      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_3');
      tokens.setState('Gateway_1', 'A', { position: 'center-middle' }, 'Flow_4');

      const merged = tokens.getTokens(t => t.label === 'A');
      expect(merged).to.have.length(1);
      expect(merged[0].selected).to.be.true; // survived even though Flow_4 was not selected
    });


    it('getSelectedTokens returns only the selected tokens', function() {
      const tokens = get('animation');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      tokens.createToken('Task_3', 'C', 'seagreen');

      expect(tokens.getSelectedTokens()).to.have.length(0);

      tokens.selectToken('Task_1', 'A');
      tokens.selectToken('Task_3', 'C');

      const selected = tokens.getSelectedTokens();
      expect(selected.map(t => t.label).sort()).to.eql([ 'A', 'C' ]);

      tokens.deselectToken('Task_1', 'A');
      expect(tokens.getSelectedTokens().map(t => t.label)).to.eql([ 'C' ]);
    });


    it('getSelectedNodes returns the selected node ids', function() {
      const tokens = get('animation');

      expect(tokens.getSelectedNodes()).to.have.length(0);

      tokens.setNodeSelected('Task_1');
      tokens.setNodeSelected('Task_2');

      expect(tokens.getSelectedNodes().sort()).to.eql([ 'Task_1', 'Task_2' ]);

      tokens.setNodeSelected('Task_1', false);
      expect(tokens.getSelectedNodes()).to.eql([ 'Task_2' ]);
    });


    it('setNodeSelected draws a blue outline rect (modeller boundary)', function() {
      const tokens = get('animation');

      const gfx = get('elementRegistry').getGraphics('Task_1');
      expect(gfx.querySelector('.bts-node-outline')).to.not.exist;

      tokens.setNodeSelected('Task_1');
      expect(gfx.classList.contains('bts-selected')).to.be.true;
      expect(gfx.querySelector('.bts-node-outline')).to.exist;

      tokens.setNodeSelected('Task_1', false);
      expect(gfx.classList.contains('bts-selected')).to.be.false;
      expect(gfx.querySelector('.bts-node-outline')).to.not.exist;
    });


    it('clear() removes node selection', function() {
      const tokens = get('animation');

      tokens.setNodeSelected('Task_1');
      tokens.clear();

      const gfx = get('elementRegistry').getGraphics('Task_1');
      expect(gfx.classList.contains('bts-selected')).to.be.false;
      expect(gfx.querySelector('.bts-node-outline')).to.not.exist;
    });

  });


  describe('instance stack', function() {

    function gfxOf(node) {
      return get('elementRegistry').getGraphics(node);
    }

    function shapes(node) {
      return gfxOf(node).querySelectorAll('.bts-stack-shape');
    }


    it('draws size-1 shape copies behind the node', function() {
      const tokens = get('animation');

      expect(shapes('Task_1')).to.have.length(0);

      tokens.setStackSize('Task_1', 3);

      expect(shapes('Task_1')).to.have.length(2);
      // copies are leading children, so they paint behind the real node
      expect(gfxOf('Task_1').firstElementChild.classList.contains('bts-stack-shape')).to.be.true;
      // each copy wraps a clone of the node's visual
      expect(shapes('Task_1')[0].querySelector('.djs-visual')).to.exist;
    });


    it('caps the copies at maxVisible', function() {
      const tokens = get('animation');

      tokens.setStackSize('Task_1', 10);

      // default maxVisible = 3 -> at most 3 copies behind, even though size is 10
      expect(shapes('Task_1')).to.have.length(3);
      expect(tokens.getStackSize('Task_1')).to.equal(10);
    });


    it('strips ids from the cloned shapes', function() {
      const tokens = get('animation');

      tokens.setStackSize('Task_1', 2);

      const copy = shapes('Task_1')[0];
      expect(copy.querySelectorAll('[id]')).to.have.length(0);
    });


    it('getStackSize reflects the set size', function() {
      const tokens = get('animation');

      expect(tokens.getStackSize('Task_1')).to.equal(0);

      tokens.setStackSize('Task_1', 4);
      expect(tokens.getStackSize('Task_1')).to.equal(4);
    });


    it('size <= 1 removes the stack', function() {
      const tokens = get('animation');

      tokens.setStackSize('Task_1', 3);
      expect(shapes('Task_1')).to.have.length(2);

      tokens.setStackSize('Task_1', 1);

      expect(shapes('Task_1')).to.have.length(0);
      expect(tokens.getStackSize('Task_1')).to.equal(0);
    });


    it('rebuilds (no accumulation) on repeated calls', function() {
      const tokens = get('animation');

      tokens.setStackSize('Task_1', 3);
      tokens.setStackSize('Task_1', 2);

      expect(shapes('Task_1')).to.have.length(1);
    });


    it('clear() removes the stack', function() {
      const tokens = get('animation');

      tokens.setStackSize('Task_1', 3);
      tokens.clear();

      expect(shapes('Task_1')).to.have.length(0);
      expect(tokens.getStackSize('Task_1')).to.equal(0);
    });


    it('rejects an unknown node', function() {
      expect(() => get('animation').setStackSize('Nope', 2)).to.throw(/unknown node/);
    });

  });


  describe('setAnimationDuration', function() {

    it('changes the global animation duration', function() {
      get('animation').setAnimationDuration(250);

      expect(get('animation').getAnimationDuration()).to.equal(250);
    });

  });


  describe('throwIcon / catchIcon', function() {

    function icon() {
      return document.querySelector('.bts-icon');
    }

    it('throwIcon emits the element icon (fly out + fade)', function() {
      get('animation').throwIcon('Task_2'); // send task has a icon

      const g = document.querySelector('.bts-icon-emit');
      expect(g).to.exist;
      expect(g.querySelector('path')).to.exist; // a cloned icon path
    });


    it('catchIcon draws the element icon in (fly in + fade)', function() {
      get('animation').catchIcon('StartEvent_1'); // message start has a icon

      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('direction is the caller\'s choice, not the element type', function() {
      const animation = get('animation');

      // a "catching"-looking element thrown, and a "throwing"-looking one caught
      animation.throwIcon('Task_3');     // receive task, but caller throws
      animation.catchIcon('EndEvent_1'); // message end, but caller catches

      expect(document.querySelector('.bts-icon-emit')).to.exist;
      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('works on any element with a icon (e.g. user task)', function() {
      get('animation').catchIcon('Task_1'); // user task

      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('is a no-op for an element with no icon', async function() {
      await get('animation').throwIcon('EndEvent_2'); // plain end event

      expect(icon()).to.not.exist;
    });


    it('removes the icon and resolves when done', async function() {
      await get('animation').throwIcon('Task_2');

      expect(icon()).to.not.exist;
    });

  });


  describe('getRandomColor', function() {

    it('returns a CSS hsl() color', function() {
      expect(getRandomColor()).to.match(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

  });

});
