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
import collapsedXML from '../collapsed.bpmn';

function dotAt(node) {
  return document.querySelector(`.bts-token-count[data-node-id="${node}"]`);
}

function tok(node, label) {
  return get('primitives').getTokens(t => t.node === node && t.label === label)[0];
}

function transition(node, label, sequenceFlow, state) {
  return { node, label, sequenceFlow, state };
}

// the 9 former word anchors as { left, top } fractions (positions are now { left, top })
const POS = {
  'top-left': { left: 0, top: 0 }, 'top-middle': { left: 0.5, top: 0 }, 'top-right': { left: 1, top: 0 },
  'center-left': { left: 0, top: 0.5 }, 'center-middle': { left: 0.5, top: 0.5 }, 'center-right': { left: 1, top: 0.5 },
  'bottom-left': { left: 0, top: 1 }, 'bottom-middle': { left: 0.5, top: 1 }, 'bottom-right': { left: 1, top: 1 }
};
function pos(name) { return { ...POS[name], hoffset: 0, voffset: 0 }; }

// new sendToken model: a token travels along the flow it ALREADY rests on. This helper
// puts it on `flow` (setState), then sends it — returning the sendToken promise. It lands
// resting on the same flow at the far node (anchor afterwards with setState).
function move(node, label, flow, selector) {
  const a = get('primitives');
  a.setState(node, label, { sequenceFlow: flow }, selector);
  return a.sendToken([ { node, label, sequenceFlow: flow, stackIndices: selector && selector.stackIndices } ]);
}


describe('Primitives', function() {

  // duration 0 => animations land instantly, so most assertions are synchronous
  beforeEach(bootstrap(diagramXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);


  describe('createToken', function() {

    it('renders a colored dot with the label on hover', function() {
      get('primitives').createToken('StartEvent_1', 'A', 'tomato');

      expect(dots()).to.have.length(1);

      const dot = dots()[0];

      expect(dot.getAttribute('title')).to.equal('A');
      expect(dot.dataset.label).to.equal('A');
      expect(dot.dataset.nodeId).to.equal('StartEvent_1');
      expect(dot.getAttribute('style')).to.contain('tomato');
    });


    it('accepts any CSS color', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'rgb(49, 130, 189)');
      tokens.createToken('Task_2', 'B', '#3399ff');
      tokens.createToken('Task_3', 'C', 'hsl(120, 60%, 45%)');

      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(49, 130, 189)');
      expect(dotAt('Task_2').getAttribute('style')).to.contain('#3399ff');
      expect(dotAt('Task_3').getAttribute('style')).to.contain('hsl(120, 60%, 45%)');
    });


    it('replaces an existing token at the same identity', function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.createToken('StartEvent_1', 'A', 'steelblue');

      expect(dots()).to.have.length(1);
      expect(dots()[0].getAttribute('style')).to.contain('steelblue');
    });


    it('requires a color', function() {
      expect(() => get('primitives').createToken('StartEvent_1', 'A')).to.throw(/color is required/);
    });


    it('rejects an unknown node', function() {
      expect(() => get('primitives').createToken('Nope', 'A', 'tomato')).to.throw(/unknown node/);
    });

  });


  describe('state', function() {

    it('defaults to centered, still (no animation)', function() {
      get('primitives').createToken('Task_1', 'A', 'tomato');

      const dot = dots()[0];

      expect(dot.dataset.left).to.equal('0.5');
      expect(dot.dataset.top).to.equal('0.5');
      expect(dot.dataset.animate).to.equal('');
      expect(dot.classList.contains('bts-anim-bounce')).to.be.false;
    });


    it('honors an explicit position and animate effect', function() {
      get('primitives').createToken('Task_1', 'A', 'tomato', { position: pos('center-middle'), animate: 'pulse' });

      const dot = dots()[0];

      expect(dot.dataset.left).to.equal('0.5');
      expect(dot.dataset.top).to.equal('0.5');
      expect(dot.dataset.animate).to.equal('pulse');
      expect(dot.classList.contains('bts-anim-pulse')).to.be.true;
    });


    it('accepts a pixel offset (hoffset/voffset) on top of the fraction', function() {
      // a proportional anchor plus a constant px nudge (e.g. 20px below the bottom edge)
      get('primitives').createToken('Task_1', 'A', 'tomato', { position: { left: 0.5, top: 1, voffset: 20 } });

      const dot = dots()[0];

      expect(dot.dataset.left).to.equal('0.5');
      expect(dot.dataset.top).to.equal('1');
      expect(dot.dataset.voffset).to.equal('20');
      expect(dotAt('Task_1')).to.exist;
    });


    it('rests on a sequence flow', function() {
      get('primitives').createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });

      const dot = dotAt('Gateway_1');

      expect(dot.dataset.sequenceFlow).to.equal('Flow_3');
      expect(dot.dataset.left).to.equal('');
    });


    it('renders distinct positions as separate overlays', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato', { position: pos('top-left') });
      tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('bottom-right') });

      // two location clusters -> two overlay containers
      expect(document.querySelectorAll('.bts-token-count-parent')).to.have.length(2);
    });


    it('queues tokens that resolve to the same point into one cluster', function() {
      const tokens = get('primitives');

      // same resolved point (an explicit voffset:0 matches the default) -> one queue
      tokens.createToken('Task_1', 'A', 'tomato', { position: { left: 0.5, top: 0.5 } });
      tokens.createToken('Task_1', 'B', 'steelblue', { position: { left: 0.5, top: 0.5, voffset: 0 } });

      expect(document.querySelectorAll('.bts-token-count-parent')).to.have.length(1);
      expect(document.querySelectorAll('.bts-token-count-parent .bts-token-count')).to.have.length(2);
    });


    it('rejects position and sequenceFlow together', function() {
      expect(() => get('primitives').createToken('Task_1', 'A', 'tomato', { position: pos('center-middle'), sequenceFlow: 'Flow_2' }))
        .to.throw(/mutually exclusive/);
    });


    it('rejects a word-string position (now { left, top })', function() {
      expect(() => get('primitives').createToken('Task_1', 'A', 'tomato', { position: 'middle-center' }))
        .to.throw(/object \{ left, top/);
    });


    describe('setState (partial merge)', function() {

      it('toggles the animate effect without moving', function() {
        const tokens = get('primitives');

        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle'), animate: 'bounce' });
        tokens.setState('Task_1', 'A', { animate: null });

        const t = tok('Task_1', 'A');

        expect(t.state.position).to.eql(pos('center-middle'));
        expect(t.state.animate).to.equal(null);
        expect(dotAt('Task_1').classList.contains('bts-anim-bounce')).to.be.false;
      });


      it('toggles hidden (a carried visual flag) — .bts-hidden, dot kept in the model', function() {
        const tokens = get('primitives');

        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') });
        expect(dotAt('Task_1').classList.contains('bts-hidden')).to.be.false;

        // park it: the dot stays rendered (still in getTokens), just CSS-hidden
        tokens.setState('Task_1', 'A', { hidden: true });
        expect(tok('Task_1', 'A').state.hidden).to.equal(true);
        expect(dotAt('Task_1').classList.contains('bts-hidden')).to.be.true;
        expect(dotAt('Task_1').dataset.hidden).to.equal('true');
        expect(tokens.getTokens()).to.have.length(1); // still in the model

        // un-park
        tokens.setState('Task_1', 'A', { hidden: false });
        expect(dotAt('Task_1').classList.contains('bts-hidden')).to.be.false;
      });


      it('setting position clears sequenceFlow', function() {
        const tokens = get('primitives');

        tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
        tokens.setState('Gateway_1', 'A', { position: pos('center-right') }, { sequenceFlow: 'Flow_3' });

        const t = tok('Gateway_1', 'A');

        expect(t.state.sequenceFlow).to.equal(null);
        expect(t.state.position).to.eql(pos('center-right'));
      });


      it('glides the dot to the new point (then rests there); instant when nothing moves', async function() {
        cleanup();
        await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

        const tokens = get('primitives');
        const moving = () => document.querySelector('.bts-animation-tokens .bts-token');

        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') });

        // a position change animates: the badge is gone, a moving dot is in flight
        tokens.setState('Task_1', 'A', { position: pos('top-left') });
        expect(moving(), 'glide in flight').to.exist;
        expect(dotAt('Task_1'), 'badge hidden during glide').to.not.exist;

        await new Promise(r => setTimeout(r, 80));
        expect(moving(), 'glide done').to.not.exist;
        expect(dotAt('Task_1'), 'rests at the new point').to.exist;

        // an animate-only change does not move -> no glide, applied synchronously
        tokens.setState('Task_1', 'A', { animate: 'pulse' });
        expect(moving()).to.not.exist;
        expect(dotAt('Task_1')).to.exist;
      });

    });

  });


  describe('sendToken', function() {

    it('travels a token along the flow it rests on to the far node', async function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const result = await move('StartEvent_1', 'A', 'Flow_1');

      expect(result.map(t => t.node)).to.eql([ 'Task_1' ]);
      expect(tok('Task_1', 'A')).to.exist;
      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dotAt('Task_1')).to.exist;
      expect(dotAt('StartEvent_1')).to.not.exist;
    });


    it('lands resting on the same flow (host anchors it with setState)', async function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');

      await move('StartEvent_1', 'A', 'Flow_1');

      // still on the flow — state unchanged but at the far node
      const landed = tok('Task_1', 'A');
      expect(landed.state.sequenceFlow).to.equal('Flow_1');
      expect(landed.state.position).to.equal(null);

      // the host anchors it on the node afterwards
      tokens.setState('Task_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_1' });
      expect(tok('Task_1', 'A').state.position).to.eql(pos('center-middle'));
      expect(dotAt('Task_1').classList.contains('bts-anim-bounce')).to.be.false;
    });


    it('requires the token to be on the flow first', async function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato'); // anchored, not on a flow

      let err;
      await tokens.sendToken([ { node: 'StartEvent_1', label: 'A', sequenceFlow: 'Flow_1' } ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/resting on/);
    });


    it('a split is the host sending a token on each flow', async function() {
      const tokens = get('primitives');

      // the host models a split: a token on each outgoing flow, sent independently
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      await Promise.all([
        tokens.sendToken([ { node: 'Gateway_1', label: 'A', sequenceFlow: 'Flow_3' } ]),
        tokens.sendToken([ { node: 'Gateway_1', label: 'A', sequenceFlow: 'Flow_4' } ])
      ]);

      expect(tokens.getTokens(t => t.label === 'A').map(t => t.node).sort()).to.eql([ 'Task_2', 'Task_3' ]);
      expect(dotAt('Task_2')).to.exist;
      expect(dotAt('Task_3')).to.exist;
    });


    it('keeps the color across a move', async function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'rgb(1, 2, 3)');
      await move('StartEvent_1', 'A', 'Flow_1');

      expect(tok('Task_1', 'A').color).to.equal('rgb(1, 2, 3)');
      expect(dotAt('Task_1').getAttribute('style')).to.contain('rgb(1, 2, 3)');
    });


    it('settles an in-flight transition before the next send (no overlap)', async function() {

      // a real (non-zero) duration so the first transition is genuinely in flight
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.setState('StartEvent_1', 'A', { sequenceFlow: 'Flow_1' });

      const p1 = tokens.sendToken([ { node: 'StartEvent_1', label: 'A', sequenceFlow: 'Flow_1' } ]);
      // continue from the (optimistic) destination: put it on the next flow and send
      tokens.setState('Task_1', 'A', { sequenceFlow: 'Flow_2' }, { sequenceFlow: 'Flow_1' });
      const p2 = tokens.sendToken([ { node: 'Task_1', label: 'A', sequenceFlow: 'Flow_2' } ]);

      const [ landed1 ] = await Promise.all([ p1, p2 ]);

      expect(landed1[0].node).to.equal('Task_1');  // p1 was settled at its target
      expect(tok('Gateway_1', 'A')).to.exist;       // p2 landed (Flow_2: Task_1 -> Gateway_1)
      expect(tok('Task_1', 'A')).to.not.exist;
      expect(dots()).to.have.length(1);
    });


    it('rewinds along an incoming flow', async function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato');

      // Flow_1 is StartEvent_1 -> Task_1; resting on it at Task_1 and sending rewinds
      const result = await move('Task_1', 'A', 'Flow_1');

      expect(result.map(t => t.node)).to.eql([ 'StartEvent_1' ]);
      expect(tok('StartEvent_1', 'A')).to.exist;
      expect(tok('Task_1', 'A')).to.not.exist;
    });


    it('rejects a flow not connected to the node', async function() {
      const tokens = get('primitives');

      // rest on a flow that isn't connected to the node, then try to send
      tokens.createToken('StartEvent_1', 'A', 'tomato', { sequenceFlow: 'Flow_2' });

      let err;
      await tokens.sendToken([ { node: 'StartEvent_1', label: 'A', sequenceFlow: 'Flow_2' } ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/is not connected to/);
    });

  });


  describe('identity (rest sequenceFlow)', function() {

    it('anchoring a flow token commits it into the node\'s visible instance (setState)', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      tokens.setStackIndex('Task_1', 2);                       // visible front = instance 2

      // a token on the node's incoming flow is instance-agnostic -> visible at any front
      tokens.createToken('Task_1', 'A', 'tomato', { sequenceFlow: 'Flow_1' });
      expect(dotAt('Task_1')).to.exist;

      // anchoring it joins the instance currently on screen
      const t = tokens.setState('Task_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_1' });
      expect(t.stackIndices).to.eql({ Task_1: 2 });
      expect(dotAt('Task_1'), 'still shown at front 2').to.exist;

      tokens.setStackIndex('Task_1', 0);
      expect(dotAt('Task_1'), 'hidden at front 0 — it belongs to instance 2').to.not.exist;

      // stepping back onto a flow drops the own-node index
      const t2 = tokens.setState('Task_1', 'A', { sequenceFlow: 'Flow_2' }, { stackIndices: { Task_1: 2 } });
      expect(t2.stackIndices).to.eql({});
    });


    it('lets same-label tokens coexist on different flows at one node', async function() {
      const tokens = get('primitives');

      tokens.createToken('Task_2', 'A', 'tomato');
      tokens.createToken('Task_3', 'A', 'tomato');

      // both arrive at the gateway resting on their own incoming flow
      await Promise.all([
        move('Task_2', 'A', 'Flow_3'),
        move('Task_3', 'A', 'Flow_4')
      ]);

      const at = tokens.getTokens(t => t.node === 'Gateway_1' && t.label === 'A');

      expect(at).to.have.length(2);
      expect(at.map(t => t.state.sequenceFlow).sort()).to.eql([ 'Flow_3', 'Flow_4' ]);
      expect(document.querySelectorAll('.bts-token-count[data-node-id="Gateway_1"]')).to.have.length(2);
    });


    it('queues (FIFO) when both move to a shared anchor', function() {
      const tokens = get('primitives');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(2);

      // both rest at the same identity (center, no flow) → they coexist as a homogeneous queue,
      // not collapsed into one (an explicit join is joinTokens / mergeTokens)
      tokens.setState('Gateway_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_3' });
      tokens.setState('Gateway_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_4' });

      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(2);

      // rendered as a stack of two homogeneous dots (not deduped to one)
      expect(document.querySelectorAll('.bts-token-count[data-node-id="Gateway_1"]:not(.bts-overflow)'))
        .to.have.length(2);

      // FIFO: removeToken takes the head; the other stays queued
      tokens.removeToken('Gateway_1', 'A');
      expect(tokens.getTokens(t => t.label === 'A')).to.have.length(1);
    });


    it('removeToken addresses a token by sequenceFlow', function() {
      const tokens = get('primitives');

      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });

      tokens.removeToken('Gateway_1', 'A', { sequenceFlow: 'Flow_3' });

      const at = tokens.getTokens(t => t.label === 'A');

      expect(at).to.have.length(1);
      expect(at[0].state.sequenceFlow).to.equal('Flow_4');
    });


    it('rejects sendToken when several tokens share the same flow (disambiguate with stackIndices)', async function() {
      const tokens = get('primitives');

      // two same-label tokens resting on the SAME flow, distinct instances
      tokens.setStackSize('Task_1', 2);
      tokens.createToken('Task_1', 'A', 'tomato', { sequenceFlow: 'Flow_2' }, { Task_1: 0 });
      tokens.createToken('Task_1', 'A', 'tomato', { sequenceFlow: 'Flow_2' }, { Task_1: 1 });

      let err;
      await tokens.sendToken([ { node: 'Task_1', label: 'A', sequenceFlow: 'Flow_2' } ]).catch(e => (err = e));

      expect(err).to.exist;
      expect(err.message).to.match(/multiple tokens/);

      // disambiguating by instance succeeds
      const res = await tokens.sendToken([ { node: 'Task_1', label: 'A', sequenceFlow: 'Flow_2', stackIndices: { Task_1: 0 } } ]);
      expect(res).to.have.length(1);
    });

  });


  describe('removeToken', function() {

    it('removes the token and its dot', function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.removeToken('StartEvent_1', 'A');

      expect(tok('StartEvent_1', 'A')).to.not.exist;
      expect(dots()).to.have.length(0);
    });

  });


  describe('overflow', function() {

    it('caps visible dots and shows a "+N" marker', function() {
      const tokens = get('primitives');

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      // default maxVisible = 3, 5 > 3 + 1 -> 3 dots + "+2"
      expect(dots()).to.have.length(3);
      expect(marker()).to.exist;
      expect(marker().textContent.trim()).to.equal('+2');
    });


    it('shows all when overflow would be just one', function() {
      const tokens = get('primitives');

      for (let i = 1; i <= 4; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }

      expect(dots()).to.have.length(4);
      expect(marker()).to.not.exist;
    });


    it('respects a custom maxVisible', function() {
      cleanup();

      return bootstrap(diagramXML, { animation: { maxVisible: 1 } })().then(() => {
        const tokens = get('primitives');

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
      const tokens = get('primitives');

      let fired;
      get('eventBus').on('token.click', e => (fired = e));

      tokens.createToken('Task_1', 'A', 'tomato');
      dotAt('Task_1').click();

      expect(fired).to.exist;
      expect(fired.node).to.equal('Task_1');
      expect(fired.label).to.equal('A');
      expect(fired.sequenceFlow).to.equal(null);
    });


    it('token.click carries the clicked instance\'s stackIndices (not just the base)', function() {
      const tokens = get('primitives');

      let fired;
      get('eventBus').on('token.click', e => (fired = e));

      tokens.setStackSize('Task_1', 2);
      tokens.createToken('Task_1', 'A', 'tomato', undefined, { Task_1: 0 });
      tokens.createToken('Task_1', 'A', 'steelblue', undefined, { Task_1: 1 });

      // front = instance 1: the visible dot is that instance's
      tokens.setStackIndex('Task_1', 1);
      dotAt('Task_1').click();

      expect(fired.stackIndices).to.eql({ Task_1: 1 });

      // and it addresses the right (non-base) token
      tokens.selectToken('Task_1', 'A', { stackIndices: fired.stackIndices });
      const selected = tokens.getSelectedTokens();
      expect(selected).to.have.length(1);
      expect(selected[0].stackIndices).to.eql({ Task_1: 1 });
    });


    it('fires token.dblclick (synthesized from two clicks) with { node, label, sequenceFlow }', function() {
      const tokens = get('primitives');

      let fired;
      get('eventBus').on('token.dblclick', e => (fired = e));

      tokens.createToken('Task_1', 'A', 'tomato');
      // two quick clicks on the same token → synthesized dblclick (re-queried: selecting on the
      // first click re-renders the dot, so the element differs but the token identity matches)
      dotAt('Task_1').click();
      dotAt('Task_1').click();

      expect(fired).to.exist;
      expect(fired.node).to.equal('Task_1');
      expect(fired.label).to.equal('A');
      expect(fired.sequenceFlow).to.equal(null);
    });


    it('does not synthesize token.dblclick from clicks on the overflow marker', function() {
      const tokens = get('primitives');

      let fired = false;
      get('eventBus').on('token.dblclick', () => (fired = true));

      for (let i = 1; i <= 5; i++) {
        tokens.createToken('Gateway_1', 'S' + i, 'tomato');
      }
      marker().click();
      marker().click();

      expect(fired).to.be.false;
    });


    it('fires token.overflow.click with the hidden tokens', function() {
      const tokens = get('primitives');

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


  describe('playTokenEffect (one-shot dot gesture)', function() {

    it('applies the .bts-once-<effect> class to the dot, then strips it when done', async function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato');

      const promise = tokens.playTokenEffect('Task_1', 'A', 'flip');

      // applied synchronously to the resting dot
      expect(dotAt('Task_1').classList.contains('bts-once-flip')).to.be.true;

      await promise;

      // stripped on finish (the dot itself stays — caller decides what's next)
      expect(dotAt('Task_1').classList.contains('bts-once-flip')).to.be.false;
      expect(dotAt('Task_1')).to.exist;
    });


    it('resolves as a no-op when the token is not drawn', async function() {
      const tokens = get('primitives');

      // an existing node, but no token resting on it
      await tokens.playTokenEffect('Task_1', 'ghost', 'flip');

      expect(dotAt('Task_1')).to.not.exist;
    });


    it('throws for an unknown node', function() {
      const tokens = get('primitives');

      expect(() => tokens.playTokenEffect('NopeNode', 'A', 'flip')).to.throw(/unknown node/);
    });

  });


  describe('token list', function() {

    function labelsAt(node) {
      return dots().filter(d => d.dataset.nodeId === node).map(d => d.dataset.label);
    }

    it('getTokens returns tokens in creation order', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.createToken('Task_2', 'B', 'steelblue');
      tokens.createToken('Task_1', 'C', 'seagreen');

      expect(tokens.getTokens().map(t => t.label)).to.eql([ 'A', 'B', 'C' ]);
    });


    it('renders every token of a non-stacked cluster', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') });
      tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('center-middle') });

      expect(labelsAt('Task_1').sort()).to.eql([ 'A', 'B' ]);
    });

  });


  describe('selection', function() {

    it('selectToken draws a blue ring on the resting dot', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato');
      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.false;

      tokens.selectToken('Task_1', 'A');

      const dot = dotAt('Task_1');
      expect(dot.classList.contains('bts-selected')).to.be.true;
      expect(dot.dataset.selected).to.equal('true');
      expect(tok('Task_1', 'A').selected).to.be.true;
    });


    it('deselectToken clears it', function() {
      const tokens = get('primitives');

      tokens.createToken('Task_1', 'A', 'tomato');
      tokens.selectToken('Task_1', 'A');
      tokens.deselectToken('Task_1', 'A');

      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.false;
      expect(tok('Task_1', 'A').selected).to.be.false;
    });


    it('rejects selecting a missing token', function() {
      expect(() => get('primitives').selectToken('Task_1', 'A')).to.throw(/no token/);
    });


    it('carries the selection across a move', async function() {
      const tokens = get('primitives');

      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.selectToken('StartEvent_1', 'A');

      await move('StartEvent_1', 'A', 'Flow_1');

      expect(tok('Task_1', 'A').selected).to.be.true;
      expect(dotAt('Task_1').classList.contains('bts-selected')).to.be.true;
    });


    it('shows the selection ring on the token while it moves', async function() {
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('primitives');
      tokens.createToken('StartEvent_1', 'A', 'tomato');
      tokens.selectToken('StartEvent_1', 'A');

      // _move appends the moving graphic synchronously, so the ring is present in flight
      const p = move('StartEvent_1', 'A', 'Flow_1');
      expect(document.querySelector('.bts-token .bts-token-ring')).to.exist;

      await p;
    });


    it('omits the ring on an unselected moving token', async function() {
      cleanup();
      await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

      const tokens = get('primitives');
      tokens.createToken('StartEvent_1', 'A', 'tomato');

      const p = move('StartEvent_1', 'A', 'Flow_1');
      expect(document.querySelector('.bts-token .bts-token-ring')).to.not.exist;

      await p;
    });


    it('copies the selection to every branch on a split', async function() {
      const tokens = get('primitives');

      // a split is per-flow tokens; selection is carried on each
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });
      tokens.selectToken('Gateway_1', 'A', { sequenceFlow: 'Flow_3' });
      tokens.selectToken('Gateway_1', 'A', { sequenceFlow: 'Flow_4' });

      await Promise.all([
        tokens.sendToken([ { node: 'Gateway_1', label: 'A', sequenceFlow: 'Flow_3' } ]),
        tokens.sendToken([ { node: 'Gateway_1', label: 'A', sequenceFlow: 'Flow_4' } ])
      ]);

      expect(tok('Task_2', 'A').selected).to.be.true;
      expect(tok('Task_3', 'A').selected).to.be.true;
    });


    it('keeps each token\'s own selection in a homogeneous queue (carried, not merged)', function() {
      const tokens = get('primitives');

      // one selected + one not, both heading to a shared anchor → they queue (no merge), each
      // keeps its own carried selection (an explicit join's OR-merge lives in Animation)
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_3' });
      tokens.createToken('Gateway_1', 'A', 'tomato', { sequenceFlow: 'Flow_4' });
      tokens.selectToken('Gateway_1', 'A', { sequenceFlow: 'Flow_3' });

      tokens.setState('Gateway_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_3' });
      tokens.setState('Gateway_1', 'A', { position: pos('center-middle') }, { sequenceFlow: 'Flow_4' });

      const queued = tokens.getTokens(t => t.label === 'A');
      expect(queued).to.have.length(2);
      expect(queued.filter(t => t.selected)).to.have.length(1); // the Flow_3 one stays selected
    });


    it('getSelectedTokens returns only the selected tokens', function() {
      const tokens = get('primitives');

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
      const tokens = get('primitives');

      expect(tokens.getSelectedNodes()).to.have.length(0);

      tokens.setNodeSelected('Task_1');
      tokens.setNodeSelected('Task_2');

      expect(tokens.getSelectedNodes().sort()).to.eql([ 'Task_1', 'Task_2' ]);

      tokens.setNodeSelected('Task_1', false);
      expect(tokens.getSelectedNodes()).to.eql([ 'Task_2' ]);
    });


    it('setNodeSelected draws a blue outline rect (modeller boundary)', function() {
      const tokens = get('primitives');

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
      const tokens = get('primitives');

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
      const tokens = get('primitives');

      expect(shapes('Task_1')).to.have.length(0);

      tokens.setStackSize('Task_1', 3);

      expect(shapes('Task_1')).to.have.length(2);
      // copies are leading children, so they paint behind the real node
      expect(gfxOf('Task_1').firstElementChild.classList.contains('bts-stack-shape')).to.be.true;
      // each copy wraps a clone of the node's visual
      expect(shapes('Task_1')[0].querySelector('.djs-visual')).to.exist;
    });


    it('caps the copies at maxVisible', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 10);

      // default maxVisible = 3 -> at most 3 copies behind, even though size is 10
      expect(shapes('Task_1')).to.have.length(3);
      expect(tokens.getStackSize('Task_1')).to.equal(10);
    });


    it('strips ids from the cloned shapes', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 2);

      const copy = shapes('Task_1')[0];
      expect(copy.querySelectorAll('[id]')).to.have.length(0);
    });


    it('getStackSize reflects the set size', function() {
      const tokens = get('primitives');

      expect(tokens.getStackSize('Task_1')).to.equal(0);

      tokens.setStackSize('Task_1', 4);
      expect(tokens.getStackSize('Task_1')).to.equal(4);
    });


    it('getCurrentStacks gives the membership for the instance on screen', function() {
      const tokens = get('primitives');

      expect(tokens.getCurrentStacks('SubTask_1'), 'nothing stacked => {}').to.eql({});

      tokens.setStackSize('SubProcess_1', 2);
      tokens.setStackIndex('SubProcess_1', 1);

      // a child of the stacked container picks up the container's front index
      expect(tokens.getCurrentStacks('SubTask_1')).to.eql({ SubProcess_1: 1 });

      // the stacked node itself is included too
      tokens.setStackSize('SubTask_1', 2, { SubProcess_1: 1 });
      tokens.setStackIndex('SubTask_1', 1);
      expect(tokens.getCurrentStacks('SubTask_1')).to.eql({ SubProcess_1: 1, SubTask_1: 1 });

      // creating with it lands the token on the visible instance
      tokens.createToken('SubTask_1', 'V', 'tomato', { position: pos('center-middle') }, tokens.getCurrentStacks('SubTask_1'));
      expect(dotAt('SubTask_1')).to.exist;
      tokens.setStackIndex('SubProcess_1', 0);
      expect(dotAt('SubTask_1'), 'hidden once the outer instance changes').to.not.exist;
    });


    it('size 1 is a single instance (no offset copies)', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      expect(shapes('Task_1')).to.have.length(2);

      tokens.setStackSize('Task_1', 1);

      expect(shapes('Task_1'), 'one instance => no copies behind').to.have.length(0);
      expect(tokens.getStackSize('Task_1'), 'count is the instance count').to.equal(1);
    });


    it('size 0 / null clears the stack', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      tokens.setStackSize('Task_1', 0);
      expect(shapes('Task_1')).to.have.length(0);
      expect(tokens.getStackSize('Task_1')).to.equal(0);

      tokens.setStackSize('Task_1', 3);
      tokens.setStackSize('Task_1', null);
      expect(tokens.getStackSize('Task_1'), 'null also clears').to.equal(0);
    });


    it('rebuilds (no accumulation) on repeated calls', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      tokens.setStackSize('Task_1', 2);

      expect(shapes('Task_1')).to.have.length(1);
    });


    it('clear() removes the stack', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      tokens.clear();

      expect(shapes('Task_1')).to.have.length(0);
      expect(tokens.getStackSize('Task_1')).to.equal(0);
    });


    it('grows the selection outline to cover the stack', function() {
      const tokens = get('primitives');
      const outline = () => gfxOf('Task_1').querySelector('.bts-node-outline');
      const w = () => +outline().getAttribute('width');
      const h = () => +outline().getAttribute('height');

      tokens.setNodeSelected('Task_1');
      const baseW = w(), baseH = h();

      // stack of 3 -> 2 copies -> outline grows by 2 * STACK_OFFSET (4) = 8 each way
      tokens.setStackSize('Task_1', 3);
      expect(w()).to.equal(baseW + 8);
      expect(h()).to.equal(baseH + 8);

      // shrinking back removes the extra
      tokens.setStackSize('Task_1', 1);
      expect(w()).to.equal(baseW);
      expect(h()).to.equal(baseH);
    });


    it('draws the selection outline stack-sized when selected after stacking', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Task_1', 3);
      tokens.setNodeSelected('Task_1');

      const outline = gfxOf('Task_1').querySelector('.bts-node-outline');
      const element = get('elementRegistry').get('Task_1');
      expect(+outline.getAttribute('width')).to.equal(element.width + 10 + 8);
    });


    it('rejects an unknown node', function() {
      expect(() => get('primitives').setStackSize('Nope', 2)).to.throw(/unknown node/);
    });


    it('exposes the cap via getMaxVisible', function() {
      // copies cap at maxVisible (default 3) -> at most maxVisible + 1 shapes
      expect(get('primitives').getMaxVisible()).to.equal(3);
    });


    describe('stack overflow marker (3d)', function() {

      function stackMarker() {
        return document.querySelector('.bts-stack-count');
      }

      it('shows a "+k" text marker for instances beyond the drawn cap', function() {
        const tokens = get('primitives');
        const cap = tokens.getMaxVisible() + 1; // 4

        tokens.setStackSize('Task_1', cap + 5); // size 9

        const m = stackMarker();
        expect(m).to.exist;
        expect(m.textContent).to.equal('+5'); // 9 - (3 + 1)
      });


      it('has no badge circle (plain text, not .bts-overflow)', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', tokens.getMaxVisible() + 5);

        const m = stackMarker();
        expect(m.classList.contains('bts-token-count')).to.be.false;
        expect(m.classList.contains('bts-overflow')).to.be.false;
      });


      it('shows no marker when the size fits the cap', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', tokens.getMaxVisible() + 1); // exactly the cap
        expect(stackMarker()).to.not.exist;
      });


      it('removes the marker when shrunk back under the cap', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 20);
        expect(stackMarker()).to.exist;

        tokens.setStackSize('Task_1', 2);
        expect(stackMarker()).to.not.exist;
      });


      it('clear() removes the marker', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 20);
        tokens.clear();

        expect(stackMarker()).to.not.exist;
      });


      it('grows the selection outline to span the marker', function() {
        const tokens = get('primitives');
        const outlineW = () => +gfxOf('Task_1').querySelector('.bts-node-outline').getAttribute('width');

        tokens.setNodeSelected('Task_1');

        tokens.setStackSize('Task_1', tokens.getMaxVisible() + 1); // capped, no marker
        const capped = outlineW();

        tokens.setStackSize('Task_1', 20); // marker appears -> outline reaches past it
        expect(outlineW()).to.be.greaterThan(capped);
      });

    });


    describe('front-instance tokens (3a)', function() {

      function labelsAt(node) {
        return dots().filter(d => d.dataset.nodeId === node).map(d => d.dataset.label);
      }

      it('shows only the front instance\'s tokens', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 3);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('top-left') }, { Task_1: 1 });
        tokens.createToken('Task_1', 'C', 'seagreen', { position: pos('bottom-right') }, { Task_1: 2 });

        expect(labelsAt('Task_1')).to.eql([ 'A' ]); // front = instance 0
      });


      it('a non-stacked node shows all tokens', function() {
        const tokens = get('primitives');

        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') });
        tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('top-left') });

        expect(labelsAt('Task_1')).to.have.members([ 'A', 'B' ]);
      });


      it('shows several tokens of the front instance (no 1:1 assumption)', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 2);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('top-left') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'X', 'seagreen', { position: pos('center-middle') }, { Task_1: 1 });

        expect(labelsAt('Task_1').sort()).to.eql([ 'A', 'B' ]); // both of instance 0; X hidden
      });


      it('moveToFront swaps which instance is shown', async function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 3);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'C', 'seagreen', { position: pos('bottom-right') }, { Task_1: 2 });

        expect(labelsAt('Task_1')).to.eql([ 'A' ]);

        // the front update is synchronous; the arc is cosmetic (await it to read the DOM)
        const p = tokens.moveToFront('Task_1', 2);
        expect(tokens.getCurrentStack('Task_1')).to.equal(2);
        await p;
        expect(labelsAt('Task_1')).to.eql([ 'C' ]);
      });


      it('shows a front-instance token at its own anchor', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 3);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('top-left') }, { Task_1: 0 });

        expect(dotAt('Task_1').dataset.left).to.equal('0');
        expect(dotAt('Task_1').dataset.top).to.equal('0');
      });


      it('hides other instances when stacked, shows all when unstacked', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 2);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('top-left') }, { Task_1: 1 });
        expect(labelsAt('Task_1')).to.eql([ 'A' ]);

        tokens.setStackSize('Task_1', 1); // unstacked -> no instance filtering
        expect(labelsAt('Task_1').sort()).to.eql([ 'A', 'B' ]);
      });

    });


    describe('in-flight visibility on a hidden instance', function() {

      const moving = () => document.querySelector('.bts-animation-tokens .bts-token');

      it('hides a node glide on a non-front instance', async function() {
        cleanup();
        await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 2); // front = instance 0
        tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('center-middle') }, { Task_1: 1 });

        // glide instance 1's token (the hidden, back instance) — its moving dot must not show on top
        tokens.setState('Task_1', 'B', { position: pos('top-left') }, { stackIndices: { Task_1: 1 } });

        expect(moving(), 'glide in flight').to.exist;
        expect(moving().style.display, 'hidden: instance 1 is not on screen').to.equal('none');
      });


      it('shows a node glide on the front instance', async function() {
        cleanup();
        await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 2); // front = instance 0
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });

        tokens.setState('Task_1', 'A', { position: pos('top-left') }, { stackIndices: { Task_1: 0 } });

        expect(moving(), 'glide in flight').to.exist;
        expect(moving().style.display, 'visible: instance 0 is on screen').to.not.equal('none');
      });


      it('re-syncs a mid-glide dot when the front instance changes', async function() {
        cleanup();
        await bootstrap(diagramXML, { animation: { animationDuration: 40 } })();

        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 2); // front = instance 0
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.setState('Task_1', 'A', { position: pos('top-left') }, { stackIndices: { Task_1: 0 } });

        expect(moving().style.display, 'visible while instance 0 is front').to.not.equal('none');

        // bring instance 1 to the front mid-glide -> instance 0's moving dot must hide
        tokens.setStackIndex('Task_1', 1);
        expect(moving().style.display, 'hidden once instance 0 falls behind').to.equal('none');
      });

    });


    describe('container stacking', function() {

      it('static stack copies are outline-only (no children)', function() {
        const tokens = get('primitives');

        tokens.setStackSize('SubProcess_1', 3);

        const copy = shapes('SubProcess_1')[0];
        expect(copy.querySelector('.djs-visual')).to.exist;   // the silhouette
        expect(copy.querySelector('.djs-children')).to.not.exist; // no contents
      });


      it('leaf static copies are outline-only too', function() {
        const tokens = get('primitives');

        tokens.setStackSize('Task_1', 3);

        expect(shapes('Task_1')[0].querySelector('.djs-children')).to.not.exist;
      });

    });


    describe('scrollStack', function() {

      // scrollStack has a fixed UI speed independent of animationDuration, so the
      // default bootstrap is fine here.

      function frontVisual(node) {
        return gfxOf(node).querySelector(':scope > .djs-visual');
      }


      it('plays a forward scroll on clones, hiding then restoring the real front', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3); // 2 copies

        const p = tokens.scrollStack('Task_1');

        // clone-only: the real front is hidden and an extra clone is added in flight
        expect(frontVisual('Task_1').style.display).to.equal('none');
        expect(shapes('Task_1')).to.have.length(3); // 2 copies + the front clone

        await p;

        // canonical stack restored: real front shown, clone removed
        expect(frontVisual('Task_1').style.display).to.equal('');
        expect(shapes('Task_1')).to.have.length(2);
        expect(tokens.getStackSize('Task_1')).to.equal(3);
      });


      it('plays a backward scroll', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3);

        await tokens.scrollStack('Task_1', 'backward');

        expect(frontVisual('Task_1').style.display).to.equal('');
        expect(shapes('Task_1')).to.have.length(2);
      });


      it('resolves a nested stack size per outer instance (no callback)', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('SubProcess_1', 2);
        tokens.setStackSize('SubTask_2', 3, { SubProcess_1: 1 }); // 3 only under instance 1
        // (instance 0 is the base context — left unset here, so no nested stack there)

        expect(tokens.getStackSize('SubTask_2')).to.equal(0); // front = instance 0

        await tokens.scrollStack('SubProcess_1', 'forward'); // -> instance 1
        expect(tokens.getStackSize('SubTask_2')).to.equal(3);
        expect(frontVisual('SubProcess_1').style.display).to.equal('');

        await tokens.scrollStack('SubProcess_1', 'backward'); // -> instance 0
        expect(tokens.getStackSize('SubTask_2')).to.equal(0);
      });


      it('a base-context nested size does not leak to other outer instances', async function() {
        const tokens = get('primitives');
        // size set on the inner node while the outer is unstacked -> base context
        tokens.setStackSize('SubTask_2', 2);
        tokens.setStackSize('SubProcess_1', 2);

        expect(tokens.getStackSize('SubTask_2')).to.equal(2); // outer instance 0

        await tokens.scrollStack('SubProcess_1', 'forward'); // -> outer instance 1
        expect(tokens.getStackSize('SubTask_2')).to.equal(0); // independent, not inherited

        await tokens.scrollStack('SubProcess_1', 'backward');
        expect(tokens.getStackSize('SubTask_2')).to.equal(2);
      });


      it('setStackSize with an omitted context targets the instance on screen', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('SubProcess_1', 2);

        await tokens.scrollStack('SubProcess_1', 'forward'); // -> outer instance 1
        tokens.setStackSize('SubTask_2', 3); // omitted ctx -> { SubProcess_1: 1 }
        expect(tokens.getStackSize('SubTask_2')).to.equal(3);

        await tokens.scrollStack('SubProcess_1', 'backward'); // -> outer instance 0
        expect(tokens.getStackSize('SubTask_2')).to.equal(0); // nothing set there
      });


      it('shows container content + an inlined arrowhead on the in-flight snapshots', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('SubProcess_1', 2);

        const gfx = gfxOf('SubProcess_1');
        expect(gfx.querySelector('.bts-stack-shape .djs-children')).to.not.exist; // static = outline only

        const p = tokens.scrollStack('SubProcess_1');

        // the A/B snapshots carry the container's contents + a private arrowhead marker
        expect(gfx.querySelector('.bts-stack-shape .djs-children')).to.exist;
        expect(gfx.querySelector('.bts-stack-shape marker[id^="bts-marker-"]')).to.exist;

        await p;

        expect(gfx.querySelector('.bts-stack-shape .djs-children')).to.not.exist; // back to outline
      });


      it('hides and restores a container\'s real children during the gesture', async function() {
        const tokens = get('primitives');
        const realChildren = () => gfxOf('SubProcess_1').parentNode.querySelector(':scope > .djs-children');

        tokens.setStackSize('SubProcess_1', 3);

        const p = tokens.scrollStack('SubProcess_1');
        expect(realChildren().style.display).to.equal('none');

        await p;
        expect(realChildren().style.display).to.equal('');
        expect(frontVisual('SubProcess_1').style.display).to.equal('');
      });


      it('is a no-op without a stack', async function() {
        const tokens = get('primitives');

        await tokens.scrollStack('Task_1'); // no stack set

        expect(shapes('Task_1')).to.have.length(0);
      });


      it('rejects an unknown node', function() {
        expect(() => get('primitives').scrollStack('Nope')).to.throw(/unknown node/);
      });


      describe('token at the node (3c)', function() {

        function badge(node) {
          const d = dotAt(node);
          return d && d.closest('.bts-token-count-parent');
        }

        it('rides the at-node top token as a snapshot dot, gone after', async function() {
          const tokens = get('primitives');
          tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') });
          tokens.setStackSize('Task_1', 3);

          const p = tokens.scrollStack('Task_1');

          const dot = gfxOf('Task_1').querySelector('.bts-stack-shape .bts-stack-token');
          expect(dot).to.exist;
          expect(dot.style.fill).to.equal('tomato');

          await p;
          expect(gfxOf('Task_1').querySelector('.bts-stack-token')).to.not.exist;
        });


        it('steps the displayed instance forward and backward', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('Task_1', 2);
          tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
          tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('center-middle') }, { Task_1: 1 });

          expect(dotAt('Task_1').dataset.label).to.equal('A');

          await tokens.scrollStack('Task_1', 'forward');
          expect(dotAt('Task_1').dataset.label).to.equal('B');

          await tokens.scrollStack('Task_1', 'backward');
          expect(dotAt('Task_1').dataset.label).to.equal('A');
        });


        it('hides the at-node badge during the gesture, restores after', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('Task_1', 2);
          tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
          tokens.createToken('Task_1', 'B', 'steelblue', { position: pos('center-middle') }, { Task_1: 1 });

          const p = tokens.scrollStack('Task_1', 'forward'); // -> instance 1 (B)
          expect(badge('Task_1').style.display).to.equal('none');

          await p;
          expect(badge('Task_1').style.display).to.equal('');
          expect(dotAt('Task_1').dataset.label).to.equal('B');
        });


        it('keeps the "+k" marker visible during the gesture (stack-level, count unchanged)', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('Task_1', 20); // > maxVisible+1 -> a +k marker

          const p = tokens.scrollStack('Task_1');
          expect(document.querySelector('.bts-stack-count').style.display).to.not.equal('none');

          await p;
          expect(document.querySelector('.bts-stack-count')).to.exist;
        });


      });


      describe('tokens in scope (3e)', function() {

        function labelsAt(node) {
          return dots().filter(d => d.dataset.nodeId === node).map(d => d.dataset.label);
        }

        it('advances the stack index forward and backward', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 3);
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(0);

          await tokens.scrollStack('SubProcess_1', 'forward');
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(1);

          await tokens.scrollStack('SubProcess_1', 'backward');
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(0);
        });


        it('wraps the index (setStackIndex) and clamps it on shrink', function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 4);

          tokens.setStackIndex('SubProcess_1', 5);          // 5 mod 4 = 1
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(1);
          tokens.setStackIndex('SubProcess_1', -1);         // wraps to 3
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(3);

          tokens.setStackSize('SubProcess_1', 2);           // clamp 3 -> 1
          expect(tokens.getCurrentStack('SubProcess_1')).to.equal(1);
        });


        it('shows only the front instance\'s scope tokens (by stackIndices)', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 2);
          tokens.createToken('SubTask_1', 'a0', 'tomato', { position: pos('center-middle') }, { SubProcess_1: 0 });
          tokens.createToken('SubTask_1', 'a1', 'steelblue', { position: pos('center-middle') }, { SubProcess_1: 1 });

          expect(labelsAt('SubTask_1')).to.eql([ 'a0' ]); // front = instance 0

          await tokens.scrollStack('SubProcess_1', 'forward');
          expect(labelsAt('SubTask_1')).to.eql([ 'a1' ]);
          expect(tokens.getTokens()).to.have.length(2); // both persist in the model
        });


        it('rides a descendant scope token as a snapshot dot, gone after', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 2);
          tokens.createToken('SubTask_1', 'a0', 'tomato', { position: pos('center-middle') }, { SubProcess_1: 0 });

          const p = tokens.scrollStack('SubProcess_1', 'forward');
          expect(gfxOf('SubProcess_1').querySelector('.bts-stack-shape .bts-stack-token')).to.exist;

          await p;
          expect(gfxOf('SubProcess_1').querySelector('.bts-stack-token')).to.not.exist;
        });


        it('rides a descendant flow-resting token as a snapshot dot', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 2);
          // a token on a sub-process internal flow is instance-specific via SubProcess_1,
          // so it must ride the container's scroll snapshot (unlike the scrolled node's own flows)
          tokens.createToken('SubTask_1', 'a0', 'tomato', { sequenceFlow: 'SubFlow_1' }, { SubProcess_1: 0 });

          const p = tokens.scrollStack('SubProcess_1', 'forward');
          expect(gfxOf('SubProcess_1').querySelector('.bts-stack-shape .bts-stack-token')).to.exist;

          await p;
        });


        it('hides the descendant token overlay during the gesture', async function() {
          const tokens = get('primitives');
          tokens.setStackSize('SubProcess_1', 2);
          tokens.createToken('SubTask_1', 'a0', 'tomato', { position: pos('center-middle') }, { SubProcess_1: 0 });
          tokens.createToken('SubTask_1', 'a1', 'steelblue', { position: pos('center-middle') }, { SubProcess_1: 1 });

          const p = tokens.scrollStack('SubProcess_1', 'forward'); // -> instance 1 (a1)
          expect(dotAt('SubTask_1').closest('.bts-token-count-parent').style.display).to.equal('none');

          await p;
          expect(dotAt('SubTask_1').closest('.bts-token-count-parent').style.display).to.equal('');
          expect(dotAt('SubTask_1').dataset.label).to.equal('a1');
        });

      });

    });


    describe('moveToFront / moveToBack (animated reorder)', function() {

      // the reorder primitives now own the arc gesture (so autoFocus animates too); fixed UI
      // speed, default bootstrap is fine.

      function frontVisual(node) {
        return gfxOf(node).querySelector(':scope > .djs-visual');
      }


      it('moveToFront plays the arc, landing the requested instance in front', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3);
        tokens.createToken('Task_1', 'A', 'tomato', { position: pos('center-middle') }, { Task_1: 0 });
        tokens.createToken('Task_1', 'C', 'seagreen', { position: pos('center-middle') }, { Task_1: 2 });

        const p = tokens.moveToFront('Task_1', 2);

        // the front updates synchronously; the arc runs over clones (the real front hidden)
        expect(tokens.getCurrentStack('Task_1')).to.equal(2);
        expect(frontVisual('Task_1').style.display).to.equal('none');
        expect(shapes('Task_1')).to.have.length(3); // 2 copies + the front clone

        await p;
        expect(frontVisual('Task_1').style.display).to.equal('');
        expect(dotAt('Task_1').dataset.label).to.equal('C');
      });


      it('moveToFront is a silent no-op when the key is already front', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3);

        await tokens.moveToFront('Task_1', 0); // already front -> nothing to reveal
        expect(shapes('Task_1')).to.have.length(2); // no clone added
        expect(tokens.getCurrentStack('Task_1')).to.equal(0);
      });


      it('moveToBack animates the front instance sinking to the back', async function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3);

        const p = tokens.moveToBack('Task_1', 0); // the front -> back
        expect(frontVisual('Task_1').style.display).to.equal('none'); // arc runs
        expect(tokens.getCurrentStack('Task_1')).to.equal(1); // next is front now

        await p;
        expect(frontVisual('Task_1').style.display).to.equal('');
      });


      it('moveToBack of a non-front key reorders instantly (no arc)', function() {
        const tokens = get('primitives');
        tokens.setStackSize('Task_1', 3); // order [0,1,2]

        tokens.moveToBack('Task_1', 1); // not the shown instance -> no gesture
        expect(frontVisual('Task_1').style.display).to.equal(''); // never hidden
        expect(shapes('Task_1')).to.have.length(2); // no clone added
        expect(tokens.getCurrentStack('Task_1')).to.equal(0); // front unchanged
        expect(tokens.getStacks('Task_1')).to.eql([ 0, 2, 1 ]); // 1 sent to the back
      });


      it('is a no-op on an unstacked node', async function() {
        const tokens = get('primitives');

        await tokens.moveToFront('Task_1', 0);
        await tokens.moveToBack('Task_1', 0);
        expect(shapes('Task_1')).to.have.length(0);
      });

    });

  });


  describe('process box (T4)', function() {

    // test/diagram.bpmn root is a bare bpmn:Process (no collaboration)
    function box() {
      return document.querySelector('.bts-process-box');
    }

    it('draws a pool-style box around the implicit process on setStackSize', function() {
      const tokens = get('primitives');
      expect(box()).to.not.exist;

      tokens.setStackSize('Process_1', 3);

      expect(box()).to.exist;
      expect(box().querySelector('.djs-visual rect')).to.exist;        // outer rect
      expect(box().querySelector('.bts-process-box-label')).to.exist;  // banner label
      expect(tokens.getStackSize('Process_1')).to.equal(3);
      expect(tokens.getProcessBox()).to.equal('Process_1');
      expect(box().querySelectorAll('.bts-stack-shape')).to.have.length(2); // size-1 copies
    });


    it('wraps the box bounds around the flow nodes (banner to the left)', function() {
      const tokens = get('primitives');
      const er = get('elementRegistry');

      tokens.setStackSize('Process_1', 2);

      const root = er.get('Process_1');
      expect(root.width).to.be.above(0);
      expect(root.x).to.be.below(er.get('StartEvent_1').x); // banner + padding left of content
    });


    it('renders an at-process token on the box', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Process_1', 2);
      tokens.createToken('Process_1', 'P', 'tomato', { position: pos('center-middle') });

      expect(dotAt('Process_1')).to.exist;
    });


    it('scrolls the process box, flow nodes riding the snapshot', async function() {
      const tokens = get('primitives');

      tokens.createToken('SubTask_1', 'a0', 'tomato', { position: pos('center-middle') });
      tokens.setStackSize('Process_1', 2);

      const p = tokens.scrollStack('Process_1', 'forward', () => ({}));
      // the with-content snapshot carries cloned flow-node gfx (root children are djs-group)
      expect(box().querySelector('.bts-stack-shape .djs-group')).to.exist;

      await p;
      expect(tokens.getCurrentStack('Process_1')).to.equal(1);
    });


    it('draws a selection outline around the boxed process', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Process_1', 2);
      tokens.setNodeSelected('Process_1');

      const box = document.querySelector('.bts-process-box');
      expect(box.querySelector('.bts-node-outline')).to.exist;
    });


    it('selecting an unboxed process is a safe no-op (no outline)', function() {
      const tokens = get('primitives');

      expect(() => tokens.setNodeSelected('Process_1')).to.not.throw();
      expect(document.querySelector('.bts-node-outline')).to.not.exist;
    });


    it('keeps the box at a single instance (size 1, no stack copies)', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Process_1', 1);

      expect(box(), 'box drawn for one instance').to.exist;
      expect(tokens.getProcessBox()).to.equal('Process_1');
      expect(box().querySelectorAll('.bts-stack-shape'), 'no offset copies at size 1').to.have.length(0);
      expect(tokens.getStackSize('Process_1')).to.equal(1);
    });


    it('removes the box on size 0 / null (and restores the root)', function() {
      const tokens = get('primitives');
      const er = get('elementRegistry');

      tokens.setStackSize('Process_1', 3);
      tokens.setStackSize('Process_1', 0);

      expect(box()).to.not.exist;
      expect(tokens.getProcessBox()).to.equal(null);
      expect(er.get('Process_1').width).to.equal(undefined); // bounds restored

      tokens.setStackSize('Process_1', 2);
      tokens.setStackSize('Process_1', null);
      expect(box(), 'null also removes').to.not.exist;
    });


    it('clear() removes the box', function() {
      const tokens = get('primitives');

      tokens.setStackSize('Process_1', 3);
      tokens.clear();

      expect(box()).to.not.exist;
      expect(tokens.getProcessBox()).to.equal(null);
    });

  });


  describe('setAnimationDuration', function() {

    it('changes the global animation duration', function() {
      get('primitives').setAnimationDuration(250);

      expect(get('primitives').getAnimationDuration()).to.equal(250);
    });

  });


  describe('throwIcon / catchIcon', function() {

    function icon() {
      return document.querySelector('.bts-icon');
    }

    it('throwIcon emits the element icon from the token (fly out + fade)', function() {
      get('primitives').createToken('Task_2', 'A', 'tomato');
      get('primitives').throwIcon('Task_2', 'A'); // send task has an icon

      const g = document.querySelector('.bts-icon-emit');
      expect(g).to.exist;
      expect(g.querySelector('path')).to.exist; // a cloned icon path
    });


    it('catchIcon draws the element icon into the token (fly in + fade)', function() {
      get('primitives').createToken('StartEvent_1', 'A', 'tomato');
      get('primitives').catchIcon('StartEvent_1', 'A'); // message start has an icon

      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('direction is the caller\'s choice, not the element type', function() {
      const animation = get('primitives');
      animation.createToken('Task_3', 'A', 'tomato');
      animation.createToken('EndEvent_1', 'B', 'tomato');

      // a "catching"-looking element thrown, and a "throwing"-looking one caught
      animation.throwIcon('Task_3', 'A');     // receive task, but caller throws
      animation.catchIcon('EndEvent_1', 'B'); // message end, but caller catches

      expect(document.querySelector('.bts-icon-emit')).to.exist;
      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('works on any element with an icon (e.g. user task)', function() {
      get('primitives').createToken('Task_1', 'A', 'tomato');
      get('primitives').catchIcon('Task_1', 'A'); // user task

      expect(document.querySelector('.bts-icon-receive')).to.exist;
    });


    it('is a no-op for an element with no icon', async function() {
      get('primitives').createToken('EndEvent_2', 'A', 'tomato');
      await get('primitives').throwIcon('EndEvent_2', 'A'); // plain end event

      expect(icon()).to.not.exist;
    });


    it('is a no-op when no token rests at the node', async function() {
      await get('primitives').throwIcon('Task_2', 'none'); // no such token

      expect(icon()).to.not.exist;
    });


    it('removes the icon and resolves when done', async function() {
      get('primitives').createToken('Task_2', 'A', 'tomato');
      await get('primitives').throwIcon('Task_2', 'A');

      expect(icon()).to.not.exist;
    });

  });


  describe('getRandomColor', function() {

    it('returns a CSS hex color', function() {
      expect(getRandomColor()).to.match(/^#[0-9a-f]{6}$/i);
    });

  });

});


// A collapsed sub-process drills into its own plane: its children's `parent` is a
// separate `<id>_plane` root, not the stacked shape. Stacking the sub-process must still
// govern those drilled-in children (ancestor walks cross the plane boundary).
describe('primitives — collapsed sub-process (drill plane)', function() {

  beforeEach(bootstrap(collapsedXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);


  it('hides a child token whose instance is not the front, across the plane boundary', async function() {
    const animation = get('primitives');

    animation.setStackSize('Collapsed_1', 2);
    animation.createToken('Inner_1', 'X', 'tomato', { position: pos('center-middle') }); // instance 0

    expect(dotAt('Inner_1'), 'instance 0 shown at front').to.exist;

    await animation.scrollStack('Collapsed_1', 'forward'); // front -> instance 1

    expect(dotAt('Inner_1'), 'instance 0 hidden when instance 1 is front').to.not.exist;

    await animation.scrollStack('Collapsed_1', 'backward'); // back to instance 0

    expect(dotAt('Inner_1'), 'instance 0 shown again').to.exist;
  });


  it('scrolling from inside the plane swaps instantly (no off-screen gesture)', async function() {
    const animation = get('primitives');
    const canvas = get('canvas');
    const elementRegistry = get('elementRegistry');

    animation.setStackSize('Collapsed_1', 2);
    animation.createToken('Inner_1', 'a', 'tomato', { position: pos('center-middle') }, { Collapsed_1: 0 });
    animation.createToken('Inner_1', 'b', 'steelblue', { position: pos('top-left') }, { Collapsed_1: 1 });
    animation.setAnimationDuration(300);

    // drill into the sub-process's own plane: its collapsed shape (where the arc would
    // play) is now off-screen, so the scroll must update synchronously rather than hide the
    // on-plane token overlays for the gesture duration
    canvas.setRootElement(elementRegistry.get('Collapsed_1_plane'));

    const scrolling = animation.scrollStack('Collapsed_1', 'forward');

    // synchronously (before the promise resolves) the front has stepped and the new
    // instance's token is already shown — not hidden waiting on a 600ms arc
    expect(animation.getCurrentStack('Collapsed_1'), 'front stepped instantly').to.equal(1);
    const dot = document.querySelector('.bts-token-count[data-node-id="Inner_1"]');
    expect(dot && dot.style.display !== 'none', 'token shown immediately').to.be.true;

    await scrolling;
  });


  it('a collapsed scroll snapshot excludes drill-plane child dots (keeps the at-node dot)', async function() {
    const animation = get('primitives');

    animation.setStackSize('Collapsed_1', 2);
    animation.createToken('Collapsed_1', 'n', 'tomato', { position: pos('center-middle') }, { Collapsed_1: 0 });
    animation.createToken('Inner_1', 'c', 'steelblue', { position: pos('center-middle') }, { Collapsed_1: 0 });
    animation.setAnimationDuration(300);

    const scrolling = animation.scrollStack('Collapsed_1', 'forward'); // collapsed view, on the parent plane

    const dots = document.querySelectorAll('.bts-stack-shape .bts-stack-token');
    expect(dots, 'only the at-node token rides the collapsed snapshot').to.have.length(1);

    await scrolling;
  });


  it('shows the front instance\'s own child token', function() {
    const animation = get('primitives');

    animation.setStackSize('Collapsed_1', 2);
    animation.createToken('Inner_1', 'Y', 'steelblue', { position: pos('center-middle') }, { Collapsed_1: 1 });

    // front is instance 0, token belongs to instance 1 -> hidden
    expect(dotAt('Inner_1'), 'instance-1 token hidden at front 0').to.not.exist;

    animation.setStackIndex('Collapsed_1', 1);

    expect(dotAt('Inner_1'), 'instance-1 token shown once it is front').to.exist;
  });

});
