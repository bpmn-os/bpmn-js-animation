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

    it('steps through the sweep on each advance, then departs to the end event', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      expect(posAt('Task_1', label)).to.equal('entry');

      await sim.advanceToBusy({ node: 'Task_1', label });
      expect(posAt('Task_1', label)).to.equal('busy');

      await sim.advanceToCompletion({ node: 'Task_1', label });
      expect(posAt('Task_1', label)).to.equal('completion');

      // depart → travel the unique outflow → auto-enter the end event (center)
      await sim.advanceToDeparted({ node: 'Task_1', label });
      expect(tokenAt('Task_1', label)).to.not.exist;
      expect(posAt('EndEvent_1', label)).to.equal('center');
    });

  });


  describe('end event + completion (D3)', function() {

    it('flips + consumes a no-outflow token and terminates the instance', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
      await sim.advanceToBusy({ node: 'Task_1', label });
      await sim.advanceToCompletion({ node: 'Task_1', label });
      await sim.advanceToDeparted({ node: 'Task_1', label });

      // the end-event token rests at center, the process is still running
      expect(posAt('EndEvent_1', label)).to.equal('center');
      expect(tokenAt('Process_1', label)).to.exist;

      // depart the end event (no outflow) → flip + consume → instance completes + terminates
      await sim.advanceToDeparted({ node: 'EndEvent_1', label });

      expect(tokenAt('EndEvent_1', label)).to.not.exist;
      expect(tokenAt('Process_1', label)).to.not.exist; // process box gone (terminated)
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

  it('forks every outflow at a diverging parallel gateway and joins at the converging one', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // the parallel structure is automatic: split forks both branches, they travel and join,
    // and the single continuation reaches the end event (resting at center)
    expect(posAt('EndEvent_1', label)).to.equal('center');

    // nothing left stranded on the gateways
    expect(simulation.getTokens('Gateway_Split', label)).to.have.length(0);
    expect(simulation.getTokens('Gateway_Join', label)).to.have.length(0);

    // the join collapsed the two branches back into one thread (root has a single child)
    const root = simulation.getToken('Process_1', label);
    expect(simulation.getChildren(root)).to.have.length(1);
  });

  it('completes + terminates the instance once the merged token is consumed', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    expect(tokenAt('Process_1', label)).to.exist; // still running

    // consume the end-event token (flip + consume) → instance completes, process box terminates
    await sim.advanceToDeparted({ node: 'EndEvent_1', label });

    expect(tokenAt('EndEvent_1', label)).to.not.exist;
    expect(tokenAt('Process_1', label)).to.not.exist;
  });

});
