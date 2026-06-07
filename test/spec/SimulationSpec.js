import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import miTaskXML from '../diagrams/mi-task.bpmn';
import collaborationXML from '../diagrams/collaboration.bpmn';
import eventSubXML from '../diagrams/event-subprocess.bpmn';
import parallelJoinXML from '../diagrams/parallel-join.bpmn';
import exclusiveGatewayXML from '../diagrams/exclusive-gateway.bpmn'; // Activity_1 is a standard loop

const PROCESS = 'Process_1';


describe('SimulationAPI', function() {

  describe('createToken — process/participant case', function() {

    beforeEach(bootstrap(miTaskXML));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('creates a token for a process instance', function() {
      const token = sim().createToken({ node: PROCESS, label: 'I1' });

      expect(token).to.exist;
      expect(token.label).to.equal('I1');
      expect(token.color).to.match(/^hsl\(/);
      expect(sim().getToken(PROCESS, 'I1')).to.equal(token);
    });

    it('places it at the ready position (above the top-left)', function() {
      const token = sim().createToken({ node: PROCESS, label: 'I1' });
      expect(token.state.position).to.include({ left: 0, top: 0, voffset: -15 });
    });

    it('increments the instance stack and draws the process box', function() {
      expect(get('animation').getStackSize(PROCESS)).to.equal(0);

      sim().createToken({ node: PROCESS, label: 'I1' });

      expect(get('animation').getStackSize(PROCESS)).to.equal(1);
      expect(get('animation').getProcessBox()).to.equal(PROCESS);
    });

    it('tags each instance with its own label as the stack key', function() {
      const a = sim().createToken({ node: PROCESS, label: 'I1' });
      const b = sim().createToken({ node: PROCESS, label: 'I2' });

      expect(a.stackIndices).to.deep.equal({ [PROCESS]: 'I1' });
      expect(b.stackIndices).to.deep.equal({ [PROCESS]: 'I2' });
      expect(get('animation').getStackSize(PROCESS)).to.equal(2);
      expect(get('animation').getStacks(PROCESS)).to.eql([ 'I1', 'I2' ]);
    });

    it('gives subsequent tokens distinct colors', function() {
      const a = sim().createToken({ node: PROCESS, label: 'I1' });
      const b = sim().createToken({ node: PROCESS, label: 'I2' });
      const c = sim().createToken({ node: PROCESS, label: 'I3' });

      expect(new Set([ a.color, b.color, c.color ]).size).to.equal(3);
    });

    it('registers the token as a tree root (no children yet)', function() {
      const token = sim().createToken({ node: PROCESS, label: 'I1' });
      expect(sim().getChildren(token)).to.deep.equal([]);
    });

    it('keeps the first instance in front by default', function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: PROCESS, label: 'I2' });
      expect(get('animation').getCurrentStack(PROCESS)).to.equal('I1');
    });

    it('reveals the touched instance when auto-focus is on', function() {
      sim().autoFocus(true);
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: PROCESS, label: 'I2' });
      expect(get('animation').getCurrentStack(PROCESS)).to.equal('I2');

      sim().autoFocus(false);
      sim().createToken({ node: PROCESS, label: 'I3' });
      expect(get('animation').getCurrentStack(PROCESS)).to.equal('I2'); // unchanged
    });

    it('rejects an unsupported node', function() {
      expect(() => sim().createToken({ node: 'MultiInstanceActivity_1', label: 'X' }))
        .to.throw(/not a process\/participant or a start event/);
    });

    it('rejects an unknown node', function() {
      expect(() => sim().createToken({ node: 'Nope_1', label: 'X' })).to.throw(/unknown element/);
    });

    it('rejects a duplicate (same node + label)', function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      expect(() => sim().createToken({ node: PROCESS, label: 'I1' })).to.throw(/already exists/);
    });

    it('clears all state', function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().clear();

      expect(sim().getToken(PROCESS, 'I1')).to.be.undefined;
      expect(get('animation').getStackSize(PROCESS)).to.equal(0);
    });

  });


  describe('createToken — participant (collaboration) case', function() {

    beforeEach(bootstrap(collaborationXML));
    afterEach(cleanup);

    it('creates a token for a participant (pool) instance', function() {
      const token = get('simulation').createToken({ node: 'Participant_1', label: 'I1' });

      expect(token.label).to.equal('I1');
      expect(token.stackIndices).to.deep.equal({ Participant_1: 'I1' });
      expect(get('animation').getStackSize('Participant_1')).to.equal(1);
    });

    it('stacks instances per participant independently', function() {
      get('simulation').createToken({ node: 'Participant_1', label: 'A1' });
      get('simulation').createToken({ node: 'Participant_1', label: 'A2' });
      get('simulation').createToken({ node: 'Participant_2', label: 'B1' });

      expect(get('animation').getStackSize('Participant_1')).to.equal(2);
      expect(get('animation').getStackSize('Participant_2')).to.equal(1);
    });

  });


  describe('createToken — start event case', function() {

    beforeEach(bootstrap(miTaskXML));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('creates a child of the scope token at center, same label + color', function() {
      const root = sim().createToken({ node: PROCESS, label: 'I1' });
      const token = sim().createToken({ node: 'StartEvent_1', label: 'I1' });

      expect(token.label).to.equal('I1');
      expect(token.color).to.equal(root.color);
      expect(token.state.position).to.include({ left: 0.5, top: 0.5, hoffset: 5, voffset: 5 });
      expect(token.stackIndices).to.deep.equal({ [PROCESS]: 'I1' }); // inherits the instance label key
      expect(sim().getChildren(root)).to.include(token);
      expect(sim().getEntry('StartEvent_1', 'I1').position).to.equal('center');
    });

    it('honors the bounce flag', function() {
      sim().createToken({ node: PROCESS, label: 'B' });
      const token = sim().createToken({ node: 'StartEvent_1', label: 'B', bounce: true });
      expect(token.state.bounce).to.be.true;
    });

    it('rejects when the scope has no token of that label', function() {
      expect(() => sim().createToken({ node: 'StartEvent_1', label: 'I1' }))
        .to.throw(/no token <I1> at scope <Process_1>/);
    });

  });


  describe('createToken — start event of event sub-process is rejected', function() {

    beforeEach(bootstrap(eventSubXML));
    afterEach(cleanup);

    it('rejects an event sub-process start event', function() {
      expect(() => get('simulation').createToken({ node: 'EscalationStartEvent_1', label: 'X' }))
        .to.throw(/event sub-process/);
    });

  });


  describe('advanceToken — along a flow', function() {

    beforeEach(bootstrap(miTaskXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('moves the token onto the flow and sends it to the far node', async function() {
      const root = sim().createToken({ node: PROCESS, label: 'I1' });
      const start = sim().createToken({ node: 'StartEvent_1', label: 'I1' });

      const landed = await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_13p16ha' });

      expect(sim().getEntry('StartEvent_1', 'I1')).to.be.undefined;

      const entry = sim().getEntry('MultiInstanceActivity_1', 'I1');
      expect(entry).to.exist;
      expect(entry.node).to.equal('MultiInstanceActivity_1');
      expect(entry.sequenceFlow).to.equal('Flow_13p16ha'); // resting on the flow

      expect(landed.node).to.equal('MultiInstanceActivity_1');
      expect(landed.state.sequenceFlow).to.equal('Flow_13p16ha');

      // sendToken lands a fresh token object; the hierarchy carries over to it
      expect(landed).to.not.equal(start);
      expect(sim().getChildren(root)).to.include(landed);
      expect(sim().getChildren(root)).to.not.include(start);
    });

    it('rejects a non-flow node', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      let err;
      try { await sim().advanceToken({ node: PROCESS, label: 'I1', sequenceFlow: 'Flow_13p16ha' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not a flow node/);
    });

    it('rejects when there is no token at the node', async function() {
      let err;
      try { await sim().advanceToken({ node: 'MultiInstanceActivity_1', label: 'X', sequenceFlow: 'Flow_13p16ha' }); } catch (e) { err = e; }
      expect(err.message).to.match(/no token/);
    });

    it('rejects a flow not connected to the node', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      let err;
      try { await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_0ldndng' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not connected/);
    });

  });


  describe('forkToken / joinToken — gateways', function() {

    // one implicit-process diagram: Start → Split → (Flow_a, Flow_b) → Join → End
    beforeEach(bootstrap(parallelJoinXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    // get the instance token onto the split gateway (resting on its incoming flow)
    async function toSplit() {
      const root = sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_s' });
      return root;
    }

    // fork both outflows and travel each branch to the join gateway
    async function toJoin() {
      const root = await toSplit();
      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });
      await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });
      return root;
    }

    it('forkToken places branches on the outflows without leaving the gateway', async function() {
      await toSplit();

      const f1 = await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      const f2 = await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });

      // both branches rest AT the gateway, one per outflow — not travelled
      expect(f1.node).to.equal('Gateway_Split');
      expect(f1.state.sequenceFlow).to.equal('Flow_a');
      expect(f2.node).to.equal('Gateway_Split');
      expect(f2.state.sequenceFlow).to.equal('Flow_b');
      expect(f2).to.not.equal(f1);
      expect(f2.color).to.equal(f1.color);            // same instance → same color
      expect(f2.stackIndices).to.eql(f1.stackIndices);

      const atGateway = get('animation').getTokens(
        t => t.label === 'I1' && t.node === 'Gateway_Split' && t.state.sequenceFlow
      );
      expect(atGateway).to.have.length(2);
    });

    it('first fork moves the original, later forks clone', async function() {
      await toSplit();
      const count = () => get('animation').getTokens(t => t.label === 'I1').length;
      const before = count(); // root + the arrived token = 2

      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      expect(count()).to.equal(before);     // moved — no new token

      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });
      expect(count()).to.equal(before + 1); // cloned — one new token
    });

    it('advanceToken then travels each branch to the join gateway', async function() {
      const root = await toSplit();

      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });

      const l1 = await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      const l2 = await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });

      expect(l1.node).to.equal('Gateway_Join');
      expect(l2.node).to.equal('Gateway_Join');
      expect(sim().getEntry('Gateway_Split', 'I1')).to.be.undefined;       // split cleared
      expect(sim().getChildren(root)).to.include(l1).and.to.include(l2);   // both in the tree
    });

    it('forkToken rejects a non-gateway node', async function() {
      let err;
      try { await sim().forkToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_s' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not a gateway/);
    });

    it('forkToken rejects a flow that is not outgoing from the gateway', async function() {
      await toSplit();
      let err;
      try { await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_s' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not an outgoing flow/);
    });

    it('joinTokens collapses the arrived branches into one token at center', async function() {
      const root = await toJoin();

      // two branches are resting on the join gateway's incoming flows
      expect(get('animation').getTokens(t => t.label === 'I1' && t.node === 'Gateway_Join')).to.have.length(2);

      const merged = await sim().joinTokens({ node: 'Gateway_Join', label: 'I1' });

      expect(merged.node).to.equal('Gateway_Join');
      expect(merged.state.sequenceFlow == null).to.be.true;      // anchored at center, no flow
      expect(merged.state.position).to.include({ left: 0.5, top: 0.5 });

      // exactly one token at the join now, and it's the sole same-label token there
      const here = get('animation').getTokens(t => t.label === 'I1' && t.node === 'Gateway_Join');
      expect(here).to.eql([ merged ]);

      // the merged token replaces both branches in the instance tree
      expect(sim().getChildren(root)).to.include(merged);
      expect(sim().getChildren(root)).to.have.length(1);
    });

    it('joinTokens carries the instance color', async function() {
      await toJoin();
      const branchColor = get('animation').getTokens(t => t.label === 'I1' && t.node === 'Gateway_Join')[ 0 ].color;
      const merged = await sim().joinTokens({ node: 'Gateway_Join', label: 'I1' });
      expect(merged.color).to.equal(branchColor);
    });

    it('joinTokens rejects a non-gateway node', async function() {
      let err;
      try { await sim().joinTokens({ node: 'StartEvent_1', label: 'I1' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not a gateway/);
    });

    it('joinTokens rejects when there are no branches to join', async function() {
      let err;
      try { await sim().joinTokens({ node: 'Gateway_Join', label: 'X' }); } catch (e) { err = e; }
      expect(err.message).to.match(/no branches/);
    });

  });


  describe('consumeToken — subtree cascade', function() {

    beforeEach(bootstrap(parallelJoinXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('removes the token and its whole subtree', async function() {
      const root = sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' }); // child of root
      expect(sim().getChildren(root)).to.have.length(1);

      const removed = await sim().consumeToken({ node: PROCESS, label: 'I1' });

      expect(removed).to.have.length(2);                          // root + start child
      expect(sim().getToken(PROCESS, 'I1')).to.be.undefined;
      expect(sim().getToken('StartEvent_1', 'I1')).to.be.undefined;
      expect(get('animation').getTokens(t => t.label === 'I1')).to.have.length(0);
    });

    it('cascade deletes descendants even when they rest on flows', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_s' });
      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      await sim().forkToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });
      await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_a' });
      await sim().advanceToken({ node: 'Gateway_Split', label: 'I1', sequenceFlow: 'Flow_b' });
      // two branches now rest on flows at the join
      expect(get('animation').getTokens(t => t.label === 'I1' && t.state.sequenceFlow)).to.have.length(2);

      await sim().consumeToken({ node: PROCESS, label: 'I1' }); // consume the (anchored) root

      expect(get('animation').getTokens(t => t.label === 'I1')).to.have.length(0); // root + both branches gone
    });

    it('rejects consuming a token resting on a sequence flow', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_s' }); // now on Flow_s at the split

      let err;
      try { await sim().consumeToken({ node: 'Gateway_Split', label: 'I1' }); } catch (e) { err = e; }
      expect(err.message).to.match(/rests on a sequence flow/);
    });

    it('rejects when there is no token at the node', async function() {
      let err;
      try { await sim().consumeToken({ node: PROCESS, label: 'X' }); } catch (e) { err = e; }
      expect(err.message).to.match(/no token/);
    });

    it('decrements the process stack as instances are consumed', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: PROCESS, label: 'I2' });
      expect(get('animation').getStackSize(PROCESS)).to.equal(2);

      await sim().consumeToken({ node: PROCESS, label: 'I2' }); // the latest instance
      expect(get('animation').getStackSize(PROCESS)).to.equal(1);

      await sim().consumeToken({ node: PROCESS, label: 'I1' });
      expect(get('animation').getStackSize(PROCESS)).to.equal(0); // last instance → box removed
    });

    // regression: consuming a non-latest instance must not drop the survivors. Previously the
    // stack was positional (count-based), so removing instance 0 left instance 1's tokens
    // outside the shrunken stack → they vanished. Label-keyed stacks remove the *specific* key.
    it('consuming one instance keeps the others and their children intact', async function() {
      const dot = node => document.querySelector(`.bts-token-count[data-node-id="${node}"]`);

      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: PROCESS, label: 'I2' });
      sim().createToken({ node: 'StartEvent_1', label: 'I2' }); // a child token on the 2nd instance
      expect(get('animation').getStacks(PROCESS)).to.eql([ 'I1', 'I2' ]);
      expect(dot('StartEvent_1'), 'I2 child hidden while I1 is front').to.not.exist; // I1 is front

      await sim().consumeToken({ node: PROCESS, label: 'I1' }); // consume the first (front) instance

      // the 2nd instance and its start-event child survive (its key stays; tokens still tracked)
      expect(get('animation').getStacks(PROCESS)).to.eql([ 'I2' ]);
      expect(sim().getToken(PROCESS, 'I1')).to.be.undefined;
      expect(sim().getToken(PROCESS, 'I2')).to.exist;
      expect(sim().getToken('StartEvent_1', 'I2')).to.exist;
      expect(get('animation').getTokens(t => t.label === 'I2')).to.have.length(2);
      // and it RENDERS — I2 is now the front instance, so its descendant dot must be re-drawn
      expect(dot('StartEvent_1'), 'I2 child renders once it becomes front').to.exist;
    });

  });


  describe('advanceToken', function() {

    // animationDuration: 0 ⇒ glides resolve synchronously (no real timers)
    beforeEach(bootstrap(miTaskXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('advances a token to a named position', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      const token = await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'busy' });

      expect(token.state.position).to.include({ left: 0.5, top: 0, voffset: 10 });
      expect(sim().getEntry(PROCESS, 'I1').position).to.equal('busy');
    });

    it('sweeps a token that just arrived resting on a flow (flow→anchor)', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      // travel to the activity — the token now rests ON its incoming flow there
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_13p16ha' });
      expect(sim().getEntry('MultiInstanceActivity_1', 'I1').sequenceFlow).to.equal('Flow_13p16ha');

      // advancing to a sweep position must take it off the flow and anchor it
      const token = await sim().advanceToken({ node: 'MultiInstanceActivity_1', label: 'I1', position: 'ready' });
      expect(token.state.position).to.include({ left: 0, top: 0, voffset: -15 });
      const entry = sim().getEntry('MultiInstanceActivity_1', 'I1');
      expect(entry.position).to.equal('ready');
      expect(entry.sequenceFlow == null).to.be.true; // anchored, no longer on the flow
    });

    it('bounces at the target when asked', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      const token = await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'busy', bounce: true });
      expect(token.state.bounce).to.be.true;
    });

    it('updates bounce on a same-position call', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'busy', bounce: true });
      const token = await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'busy', bounce: false });
      expect(token.state.bounce).to.be.false;
      expect(sim().getEntry(PROCESS, 'I1').position).to.equal('busy');
    });

    it('reaches the final position when steps are skipped (ready→exit)', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      const token = await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'exit' });
      expect(token.state.position).to.include({ left: 1, top: 0, voffset: -15 });
    });

    it('is forward-only (rejects advancing backward)', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'busy' });

      let err;
      try { await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'ready' }); } catch (e) { err = e; }
      expect(err).to.exist;
      expect(err.message).to.match(/cannot advance backward/);
    });

    it('rejects an unknown position', async function() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      let err;
      try { await sim().advanceToken({ node: PROCESS, label: 'I1', position: 'nope' }); } catch (e) { err = e; }
      expect(err.message).to.match(/unknown position/);
    });

    it('rejects a node that is neither activity/container nor a center node', async function() {
      let err; // a sequence flow is neither
      try { await sim().advanceToken({ node: 'Flow_13p16ha', label: 'X', position: 'busy' }); } catch (e) { err = e; }
      expect(err.message).to.match(/not an activity\/container or center/);
    });

    it('rejects a missing token', async function() {
      let err;
      try { await sim().advanceToken({ node: PROCESS, label: 'NOPE', position: 'busy' }); } catch (e) { err = e; }
      expect(err.message).to.match(/no token/);
    });

  });


  describe('advanceToken — event anchor (to center)', function() {

    beforeEach(bootstrap(miTaskXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    // walk a token onto the end event, resting on its incoming flow
    async function toEndEventOnFlow() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_13p16ha' });
      await sim().advanceToken({ node: 'MultiInstanceActivity_1', label: 'I1', sequenceFlow: 'Flow_0ldndng' });
    }

    it('anchors a flow-resting token at the event center (no position needed)', async function() {
      await toEndEventOnFlow();

      const token = await sim().advanceToken({ node: 'Event_10nbvlp', label: 'I1' });

      expect(token.state.position).to.include({ left: 0.5, top: 0.5, hoffset: 5, voffset: 5 });
      expect(token.state.sequenceFlow == null).to.be.true; // off the flow now

      const entry = sim().getEntry('Event_10nbvlp', 'I1');
      expect(entry.position).to.equal('center');
      expect(entry.sequenceFlow).to.equal(null);
    });

    it('honors the bounce flag', async function() {
      await toEndEventOnFlow();
      const token = await sim().advanceToken({ node: 'Event_10nbvlp', label: 'I1', bounce: true });
      expect(token.state.bounce).to.be.true;
    });

    it('rejects a missing token', async function() {
      let err;
      try { await sim().advanceToken({ node: 'Event_10nbvlp', label: 'NOPE' }); } catch (e) { err = e; }
      expect(err.message).to.match(/no token/);
    });

  });


  describe('advanceToken — loop activity', function() {

    // Activity_1 in this diagram carries standardLoopCharacteristics
    beforeEach(bootstrap(exclusiveGatewayXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    // get the instance token onto the looping Activity_1 (resting on its incoming flow)
    async function toLoopActivity() {
      sim().createToken({ node: PROCESS, label: 'I1' });
      sim().createToken({ node: 'StartEvent_1', label: 'I1' });
      await sim().advanceToken({ node: 'StartEvent_1', label: 'I1', sequenceFlow: 'Flow_1ra1q8g' }); // → Gateway_1
      await sim().advanceToken({ node: 'Gateway_1', label: 'I1', sequenceFlow: 'Flow_1jj1qlk' });     // → Activity_1
    }

    it('re-enters ready from a later state (the loop)', async function() {
      await toLoopActivity();
      await sim().advanceToken({ node: 'Activity_1', label: 'I1', position: 'busy' });
      expect(sim().getEntry('Activity_1', 'I1').position).to.equal('busy');

      // loop-back: ready from busy is allowed for a loop activity, gliding to the start position
      const token = await sim().advanceToken({ node: 'Activity_1', label: 'I1', position: 'ready' });
      expect(token.state.position).to.include({ left: 0, top: 0, voffset: -15 }); // ready
      expect(sim().getEntry('Activity_1', 'I1').position).to.equal('ready');
    });

    it('allows any backward step on a loop (not just ready)', async function() {
      await toLoopActivity();
      await sim().advanceToken({ node: 'Activity_1', label: 'I1', position: 'completed' });
      // completed → entry is backward but not to ready — still allowed for a loop
      await sim().advanceToken({ node: 'Activity_1', label: 'I1', position: 'entry' });
      expect(sim().getEntry('Activity_1', 'I1').position).to.equal('entry');
    });

  });

});
