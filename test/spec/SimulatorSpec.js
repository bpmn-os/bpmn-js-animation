import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';
import parallelJoinXML from '../diagrams/parallel-join.bpmn';
import boundaryXML from '../diagrams/boundary.bpmn';

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


describe('simulator — boundary events', function() {

  // Activity_1 carries BOTH: BoundaryEvent_1 (interrupting, top edge) → EndEvent_1, and
  // BoundaryEvent_2 (non-interrupting, bottom edge) → CatchEvent_1 → EndEvent_3.
  beforeEach(bootstrap(boundaryXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('arms both listeners when the activity becomes busy (not at entry)', async function() {
    const sim = get('simulator');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    expect(posAt('Activity_1', label)).to.equal('entry');
    expect(tokenAt('BoundaryEvent_1', label)).to.not.exist;
    expect(tokenAt('BoundaryEvent_2', label)).to.not.exist;

    await sim.advanceToBusy({ node: 'Activity_1', label });
    expect(tokenAt('BoundaryEvent_1', label)).to.exist; // both armed at busy
    expect(tokenAt('BoundaryEvent_2', label)).to.exist;
  });


  it('sheds both listeners on the activity\'s normal departure', async function() {
    const sim = get('simulator');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim.advanceToBusy({ node: 'Activity_1', label });

    await sim.advanceToCompletion({ node: 'Activity_1', label });
    await sim.advanceToDeparted({ node: 'Activity_1', label }); // departs → W1 sheds the boundaries

    expect(tokenAt('BoundaryEvent_1', label)).to.not.exist;
    expect(tokenAt('BoundaryEvent_2', label)).to.not.exist;
  });


  it('interrupting fire cancels the host (and its other listeners) and terminates the instance', async function() {
    const sim = get('simulator');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim.advanceToBusy({ node: 'Activity_1', label });

    // fire the interrupting boundary → flip + depart + consume the host (and the other listener);
    // the path runs to its end event and passes through → the instance terminates
    await sim.advanceToDeparted({ node: 'BoundaryEvent_1', label });

    expect(tokenAt('Activity_1', label)).to.not.exist;       // host cancelled
    expect(tokenAt('BoundaryEvent_2', label)).to.not.exist;  // the other listener torn down too
    expect(tokenAt('Process_1', label)).to.not.exist;        // terminated
  });


  it('non-interrupting fire re-arms the listener, leaves the host running, path waits at the catch', async function() {
    const sim = get('simulator');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim.advanceToBusy({ node: 'Activity_1', label });
    const armed = tokenAt('BoundaryEvent_2', label);

    await sim.advanceToDeparted({ node: 'BoundaryEvent_2', label });

    // host still running; a FRESH listener is armed; the boundary path rests at the catch event
    expect(posAt('Activity_1', label)).to.equal('busy');
    const rearmed = tokenAt('BoundaryEvent_2', label);
    expect(rearmed).to.exist;
    expect(rearmed).to.not.equal(armed);              // a new token, not the departed one
    expect(posAt('CatchEvent_1', label)).to.equal('center'); // path waits at the intermediate catch
    expect(tokenAt('BoundaryEvent_1', label)).to.exist;      // the interrupting listener is untouched
  });


  it('queues concurrent same-instance arrivals at a catch event (FIFO)', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim.advanceToBusy({ node: 'Activity_1', label });

    // fire the non-interrupting boundary twice → two same-instance paths reach CatchEvent_1
    await sim.advanceToDeparted({ node: 'BoundaryEvent_2', label });
    await sim.advanceToDeparted({ node: 'BoundaryEvent_2', label });

    const queued = simulation.getTokens('CatchEvent_1', label);
    expect(queued).to.have.length(2);                                    // both queued, not collided
    expect(queued.every(t => t.state.sequenceFlow == null)).to.be.true;  // both anchored at center

    // FIFO: triggering departs the head; the other stays queued, then departs on the next trigger
    await sim.advanceToDeparted({ node: 'CatchEvent_1', label });
    expect(simulation.getTokens('CatchEvent_1', label)).to.have.length(1);

    await sim.advanceToDeparted({ node: 'CatchEvent_1', label });
    expect(simulation.getTokens('CatchEvent_1', label)).to.have.length(0);
  });


  it('an intermediate catch event is triggered by a token double-click', async function() {
    const sim = get('simulator');
    const eventBus = get('eventBus');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim.advanceToBusy({ node: 'Activity_1', label });
    await sim.advanceToDeparted({ node: 'BoundaryEvent_2', label }); // path → CatchEvent_1
    expect(posAt('CatchEvent_1', label)).to.equal('center');

    // double-click the waiting catch token → it departs (receive icon, then travel through)
    eventBus.fire('token.dblclick', { node: 'CatchEvent_1', label, sequenceFlow: null });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(tokenAt('CatchEvent_1', label)).to.not.exist; // triggered + departed
  });

});
