import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';
import parallelJoinXML from '../diagrams/parallel-join.bpmn';

// flush the fire-and-forget event handlers (a macrotask drains the pending microtask chain)
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// the bookkeeping position of the (single) token of instance `label` at `node`, or undefined
function posAt(node, label) {
  const entry = get('simulation').getEntry(node, label);
  return entry && (entry.sequenceFlow ? `flow:${entry.sequenceFlow}` : entry.position);
}

function tokenAt(node, label) {
  return get('simulation').getToken(node, label);
}


describe('simulator', function() {

  // a non-zero-but-instant flow keeps the lifecycle deterministic; 0 makes glides synchronous-ish
  beforeEach(bootstrap(linearXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);


  describe('spawnInstance (C1)', function() {

    it('creates a root + start-event token, runs the box, departs the start (D1)', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

      expect(label).to.equal('I1');

      // process box is running (busy/pulse), the start event has departed
      expect(posAt('Process_1', label)).to.equal('busy');
      expect(tokenAt('StartEvent_1', label)).to.not.exist;

      // D1 + arrival: the token has entered the task (entry/bounce)
      expect(posAt('Task_1', label)).to.equal('entry');
      expect(tokenAt('Task_1', label).state.animate).to.equal('bounce');
    });


    it('numbers instances I1, I2, …', async function() {
      const sim = get('simulator');

      const a = await sim.spawnInstance('Process_1', 'StartEvent_1');
      const b = await sim.spawnInstance('Process_1', 'StartEvent_1');

      expect([ a, b ]).to.eql([ 'I1', 'I2' ]);
    });

  });


  describe('task lifecycle (entered → busy → completion → departed)', function() {

    it('steps through the sweep on each advance, then departs (end passes through)', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      expect(posAt('Task_1', label)).to.equal('entry');

      await sim.advanceToBusy({ node: 'Task_1', label });
      expect(posAt('Task_1', label)).to.equal('busy');

      await sim.advanceToCompletion({ node: 'Task_1', label });
      expect(posAt('Task_1', label)).to.equal('completion');

      // depart → travel the unique outflow → the end event passes through automatically
      // (auto flip + consume) → the instance terminates
      await sim.advanceToDeparted({ node: 'Task_1', label });
      expect(tokenAt('Task_1', label)).to.not.exist;
      expect(tokenAt('EndEvent_1', label)).to.not.exist;   // passed through, not resting
      expect(tokenAt('Process_1', label)).to.not.exist;    // terminated
    });

  });


  describe('end event + completion (D3)', function() {

    it('passes an end event through automatically (flip + consume) and terminates the instance', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      await sim.advanceToBusy({ node: 'Task_1', label });
      await sim.advanceToCompletion({ node: 'Task_1', label });
      expect(tokenAt('Process_1', label)).to.exist; // still running

      // depart the task → travel → arrive at the end event → it passes through automatically
      // (no dbl-click): flip + consume, and with no tokens left the instance terminates
      await sim.advanceToDeparted({ node: 'Task_1', label });

      expect(tokenAt('EndEvent_1', label)).to.not.exist;     // not resting — passed through
      expect(tokenAt('Process_1', label)).to.not.exist;      // process box gone (terminated)
    });

  });


  describe('double-click wiring', function() {

    it('advances a token to its next phase on token.dblclick', async function() {
      const sim = get('simulator');
      const eventBus = get('eventBus');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      expect(posAt('Task_1', label)).to.equal('entry');

      // entry → busy
      eventBus.fire('token.dblclick', { node: 'Task_1', label, sequenceFlow: null });
      await flush(); // let the fire-and-forget step settle (duration 0)
      expect(posAt('Task_1', label)).to.equal('busy');
    });


    it('ignores double-click on a process token at every phase (busy)', async function() {
      const sim = get('simulator');
      const eventBus = get('eventBus');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      expect(posAt('Process_1', label)).to.equal('busy');

      eventBus.fire('token.dblclick', { node: 'Process_1', label, sequenceFlow: null });
      await flush();

      expect(posAt('Process_1', label)).to.equal('busy'); // unchanged — no dbl-click advance
    });


    it('ignores double-click on a process token at entry too (never advances itself)', async function() {
      const eventBus = get('eventBus');

      // a bare process root rests at entry (the spawn glide to busy hasn't run)
      get('simulation').createToken({ node: 'Process_1', label: 'X' });
      expect(posAt('Process_1', 'X')).to.equal('entry');

      eventBus.fire('token.dblclick', { node: 'Process_1', label: 'X', sequenceFlow: null });
      await flush();

      expect(posAt('Process_1', 'X')).to.equal('entry'); // unchanged — entry → busy is not a click step
    });


    it('spawns an instance on element.dblclick of a process start event', async function() {
      const eventBus = get('eventBus');

      eventBus.fire('element.dblclick', { element: get('elementRegistry').get('StartEvent_1') });
      await flush();

      // an instance was created and the token entered the task
      expect(posAt('Task_1', 'I1')).to.equal('entry');
    });

  });

});


describe('simulator — parallel gateways (fork / join)', function() {

  // StartEvent_1 → Gateway_Split (parallel, 2 outflows) → {Flow_a, Flow_b} → Gateway_Join
  // (parallel, 2 inflows) → EndEvent_1
  beforeEach(bootstrap(parallelJoinXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('forks at the split, joins at the join, and flows through to a clean termination', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    // no tasks/catch events to wait on → the whole structure is automatic: the split forks both
    // branches, they travel and join into one continuation, which passes through the end event
    // (auto flip + consume) → the instance terminates with nothing stranded.
    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    expect(simulation.getTokens('Gateway_Split', label)).to.have.length(0);
    expect(simulation.getTokens('Gateway_Join', label)).to.have.length(0); // join consumed both branches
    expect(tokenAt('EndEvent_1', label)).to.not.exist;                     // end passed through
    expect(tokenAt('Process_1', label)).to.not.exist;                      // terminated
  });

});
