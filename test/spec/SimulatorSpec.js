import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';
import parallelJoinXML from '../diagrams/parallel-join.bpmn';
import boundaryXML from '../diagrams/boundary.bpmn';
import terminateXML from '../diagrams/terminate.bpmn';
import inclusiveXML from '../diagrams/inclusive.bpmn';
import loopXML from '../diagrams/loop.bpmn';
import miXML from '../diagrams/mi-task.bpmn';
import eventBasedXML from '../diagrams/event-based-gateway.bpmn';
import subprocessXML from '../diagrams/subprocess.bpmn';
import eventSubXML from '../diagrams/event-subprocess.bpmn';
import linkXML from '../diagrams/link.bpmn';
import collaborationXML from '../diagrams/collaboration.bpmn';

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


describe('simulator — terminate event', function() {

  // StartEvent_1 → Gateway_Split (parallel) → {Task_1 (waits) | TerminateEnd (terminate)}
  beforeEach(bootstrap(terminateXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('a terminate end event kills the whole instance (every sibling token)', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    // the split forks; one branch reaches the terminate end event → it kills the other branch
    // (waiting at Task_1) and the process box along with it
    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    expect(simulation.getTokens('Task_1', label)).to.have.length(0); // sibling killed
    expect(tokenAt('TerminateEnd', label)).to.not.exist;
    expect(tokenAt('Process_1', label)).to.not.exist;                // instance terminated
  });

});


describe('simulator — outflow-ambiguity Fallback (inclusive)', function() {

  // StartEvent_1 → Gateway_Split (inclusive, 3 outflows) → {Task_A | Task_B | Task_C} → Gateway_Join
  beforeEach(bootstrap(inclusiveXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('waits at a diverging inclusive gateway, then forks along the toggled outflows', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // the token reached the inclusive split and waits at center (pulse-pause) — no fork yet
    expect(posAt('Gateway_Split', label)).to.equal('center');
    expect(simulation.getToken('Gateway_Split', label).state.animate).to.equal('pulse-pause');
    expect(simulation.getTokens('Task_A', label)).to.have.length(0);

    // toggle two of the three outflows (inclusive = multi), then advance → forks along just those two
    eventBus.fire('element.click', { element: er.get('Flow_a') });
    eventBus.fire('element.click', { element: er.get('Flow_c') });
    await sim.advanceToDeparted({ node: 'Gateway_Split', label });

    expect(simulation.getTokens('Task_A', label)).to.have.length(1);
    expect(simulation.getTokens('Task_C', label)).to.have.length(1);
    expect(simulation.getTokens('Task_B', label)).to.have.length(0); // unchosen branch not taken
  });

  it('toggling an outflow off again removes it from the choice', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    eventBus.fire('element.click', { element: er.get('Flow_a') }); // on
    eventBus.fire('element.click', { element: er.get('Flow_b') }); // on
    eventBus.fire('element.click', { element: er.get('Flow_a') }); // off → only Flow_b remains
    await sim.advanceToDeparted({ node: 'Gateway_Split', label });

    expect(simulation.getTokens('Task_B', label)).to.have.length(1);
    expect(simulation.getTokens('Task_A', label)).to.have.length(0);
  });

  // tokens of `label` resting on a converging gateway's incoming flows (i.e. waiting branches)
  function waitingAt(node, label) {
    return get('simulation').getTokens(node, label).filter(t => t.state.sequenceFlow).length;
  }

  it('auto-joins a converging inclusive gateway once no more branches can arrive', async function() {
    const sim = get('simulator');
    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    eventBus.fire('element.click', { element: er.get('Flow_a') });
    eventBus.fire('element.click', { element: er.get('Flow_b') });
    eventBus.fire('element.click', { element: er.get('Flow_c') });
    await sim.advanceToDeparted({ node: 'Gateway_Split', label });

    // run A and B to the join — it does NOT fire yet, because C is still upstream (can reach Flow_c2)
    for (const task of [ 'Task_A', 'Task_B' ]) {
      await sim.advanceToBusy({ node: task, label });
      await sim.advanceToCompletion({ node: task, label });
      await sim.advanceToDeparted({ node: task, label });
    }
    expect(waitingAt('Gateway_Join', label)).to.equal(2); // A & B waiting; not joined

    // run C → its arrival fills the last inflow → the OR-join fires **automatically** (no double-click)
    await sim.advanceToBusy({ node: 'Task_C', label });
    await sim.advanceToCompletion({ node: 'Task_C', label });
    await sim.advanceToDeparted({ node: 'Task_C', label });

    expect(waitingAt('Gateway_Join', label)).to.equal(0);  // merged into one continuation
    expect(tokenAt('Process_1', label)).to.not.exist;      // it passed through the end → instance done
  });

  it('an interrupting boundary that removes a still-upstream branch readies the OR-join', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    eventBus.fire('element.click', { element: er.get('Flow_a') });
    eventBus.fire('element.click', { element: er.get('Flow_b') });
    eventBus.fire('element.click', { element: er.get('Flow_c') });
    await sim.advanceToDeparted({ node: 'Gateway_Split', label });

    // A and C reach the join and wait; B stays busy (still upstream, arming its timer boundary)
    for (const task of [ 'Task_A', 'Task_C' ]) {
      await sim.advanceToBusy({ node: task, label });
      await sim.advanceToCompletion({ node: task, label });
      await sim.advanceToDeparted({ node: task, label });
    }
    await sim.advanceToBusy({ node: 'Task_B', label }); // B busy → boundary armed
    await flush();

    // the join is held: B can still reach the empty Flow_b2 inflow
    expect(waitingAt('Gateway_Join', label)).to.equal(2);

    // fire B's **interrupting** timer boundary → B is cancelled (consumed). No live token can now reach
    // Flow_b2, so the OR-join becomes ready and fires with the two arrived branches.
    await sim.advanceToDeparted({ node: 'Event_096uk4c', label });
    await flush();

    expect(waitingAt('Gateway_Join', label)).to.equal(0); // joined A & C, departed
    expect(tokenAt('Task_B', label)).to.not.exist;         // the interrupted branch is gone
  });

});


describe('consume — synchronous model drop, async ghost flip-fade', function() {

  // a non-zero duration so the flip-fade is genuinely in flight (instant at 0 would hide the point)
  beforeEach(bootstrap(linearXML, { animation: { animationDuration: 45 } }));
  afterEach(cleanup);

  it('drops the token from the model at once and flip-fades a detached ghost that self-removes', async function() {
    const animation = get('animation');
    const container = get('canvas').getContainer();

    animation.createToken('Task_1', 'I1', 'red');
    expect(animation.getTokens(t => t.label === 'I1')).to.have.length(1);

    // gestured removal — NOT awaited; the model must drop synchronously
    animation.removeToken('Task_1', 'I1', undefined, [ 'flip', 'fade-out' ]);
    expect(animation.getTokens(t => t.label === 'I1')).to.have.length(0); // gone from the model immediately

    // a detached ghost is flip-fading in its own layer (survives re-renders)
    expect(container.querySelectorAll('.bts-token-ghost')).to.have.length(1);

    // ...and it self-removes once the gesture finishes
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(container.querySelectorAll('.bts-token-ghost')).to.have.length(0);
  });

});


describe('simulator — multi-instance activity', function() {

  // StartEvent_1 → MultiInstanceActivity_1 (‖) → Event_10nbvlp (end)
  beforeEach(bootstrap(miXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  const MI = 'MultiInstanceActivity_1';
  const IN = 'Flow_13p16ha';

  it('spawns subs from the pulse-pausing parent, runs + consumes them, departs on the last', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // the outer thread token rests on the incoming flow, pulse-pausing — it never entered
    const parent = simulation.getToken(MI, label);
    expect(parent.state.sequenceFlow).to.equal(IN);
    expect(parent.state.animate).to.equal('pulse-pause');

    // double-click the parent twice → two sub-instances appear (at entry), the parent still rests there
    await sim._step(MI, label, IN);
    await sim._step(MI, label, IN);
    expect(simulation.getToken(MI, label + '/1')).to.exist;
    expect(simulation.getToken(MI, label + '/2')).to.exist;
    expect(posAt(MI, label + '/1')).to.equal('entry');

    // run each sub entry → busy → completion (the first to leave entry parks the parent)
    for (const sub of [ label + '/1', label + '/2' ]) {
      await sim._step(MI, sub); // entry → busy
      await sim._step(MI, sub); // busy → completion
    }
    expect(simulation.getToken(MI, label).state.hidden).to.equal(true); // parent parked

    // consume each completed sub; the last one releases + travels the parent → end → instance done
    await sim._step(MI, label + '/1'); // completion → consume (not last)
    expect(simulation.getToken(MI, label + '/1')).to.not.exist;
    expect(simulation.getToken(MI, label)).to.exist; // parent still parked, more subs remain

    await sim._step(MI, label + '/2'); // completion → consume (last) → parent departs
    expect(simulation.getTokens(MI, label)).to.have.length(0); // parent traveled out
    expect(tokenAt('Process_1', label)).to.not.exist;          // end passed through → done
  });

});



describe('simulator — event sub-process (non-interrupting)', function() {

  // Process_1: StartEvent_1 → Activity_1 → … → EndEvent_1, + EventSubProcess_1 (non-interrupting,
  // typed escalation start EscalationStartEvent_1, no body)
  beforeEach(bootstrap(eventSubXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  const EVTSP = 'EventSubProcess_1';
  const ESTART = 'EscalationStartEvent_1';

  it('arms the event sub on spawn; the armed waiter does not block the process start or completion', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // the process start fired automatically (untyped) and the event sub is armed (a waiting firing)
    expect(tokenAt('StartEvent_1', label)).to.not.exist;
    expect(get('animation').getStacks(EVTSP)).to.have.length(1);

    // run the normal flow to the end — the throw events pass through, the process completes despite
    // the armed event-sub waiter (a token at a start event doesn't count toward completion)
    await sim._step('Activity_1', label); // entry → busy
    await sim._step('Activity_1', label); // busy → completion
    await sim._step('Activity_1', label); // completion → depart → throws pass through → end → done
    expect(tokenAt('Process_1', label)).to.not.exist;
  });

  it('fires a non-interrupting event sub by double-click, re-arming a fresh waiter', async function() {
    const sim = get('simulator');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    const armed = get('animation').getStacks(EVTSP)[0]; // the armed firing key
    expect(armed).to.exist;

    // double-click the armed (typed) start → it fires (trivial body, consumed) and re-arms a new waiter
    await sim._step(ESTART, armed);
    const after = get('animation').getStacks(EVTSP);
    expect(after).to.have.length(1);        // still one armed waiter
    expect(after[0]).to.not.equal(armed);   // …but a fresh firing (re-armed)
  });

});


describe('simulator — sub-process', function() {

  // StartEvent_1 → Activity_1 (collapsed sub-process: StartEvent_2 → Gateway_1 (exclusive) →
  // {ErrEnd | EscEnd | NormEnd}, + error/escalation boundary events) → EndEvent_1
  beforeEach(bootstrap(subprocessXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('enters on busy (runs the inner start to the gateway), takes the normal end → completes, departs', async function() {
    const sim = get('simulator');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    expect(posAt('Activity_1', label)).to.equal('entry'); // SP arrived → entry/bounce

    // double-click → busy seeds + auto-runs the inner start, which rests at the exclusive gateway
    await sim._step('Activity_1', label);
    expect(posAt('Gateway_1', label)).to.equal('center'); // awaiting an outflow pick (Fallback)

    // pick the untyped (normal) end and depart → NormEnd → the SP body empties → SP completion
    eventBus.fire('element.click', { element: er.get('Flow_c') });
    await sim._step('Gateway_1', label);
    expect(posAt('Activity_1', label)).to.equal('completion');

    // double-click → the SP departs its outflow → travels to EndEvent_1 → instance done
    await sim._step('Activity_1', label);
    expect(tokenAt('Activity_1', label)).to.not.exist;
    expect(tokenAt('Process_1', label)).to.not.exist;
  });

  it('an error end inside the SP throws → caught by the error boundary (interrupting → host consumed)', async function() {
    const sim = get('simulator');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim._step('Activity_1', label); // busy → inner start → exclusive gateway

    // pick the error-end branch and depart → ErrEnd throws → bubbles to ErrorBoundary_1 on Activity_1
    eventBus.fire('element.click', { element: er.get('Flow_a') });
    await sim._step('Gateway_1', label);

    expect(tokenAt('Activity_1', label)).to.not.exist; // sub-process interrupted (host consumed)
    expect(tokenAt('Process_1', label)).to.not.exist;  // boundary → End_err → instance done
  });

  it('an escalation end is caught by the (non-interrupting) escalation boundary, which propagates on', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');
    const eventBus = get('eventBus');
    const er = get('elementRegistry');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    await sim._step('Activity_1', label);

    // escalation-end branch → EscEnd throws → caught by the escalation boundary (which in this model
    // continues to an error end caught by the process's interrupting error event-sub)
    eventBus.fire('element.click', { element: er.get('Flow_b') });
    await sim._step('Gateway_1', label);

    expect(simulation.getToken('EscEnd', label)).to.not.exist;     // escalation caught (throwing token gone)
    expect(simulation.getToken('Activity_1', label)).to.not.exist; // scope interrupted downstream
    // the error event-sub firing is **running** — it wasn't swept away by a premature scope completion
    expect(simulation.getToken('Activity_0dak25o', label + '.e1')).to.exist;
  });

});


describe('simulator — event-based gateway race', function() {

  // StartEvent_1 → Gateway_1 (event-based) → { Catch_A → End_A | Catch_B → End_B }
  beforeEach(bootstrap(eventBasedXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('forks to both catch events; triggering one flip-fades the losing sibling', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // the gateway forked to both catch events — both wait (bounce)
    expect(simulation.getToken('Catch_A', label)).to.exist;
    expect(simulation.getToken('Catch_B', label)).to.exist;
    expect(simulation.getToken('Catch_A', label).state.animate).to.equal('bounce');

    // trigger Catch_A → the losing sibling Catch_B is cancelled, Catch_A proceeds → End_A → done
    await sim._step('Catch_A', label);
    expect(simulation.getToken('Catch_B', label)).to.not.exist; // losing sibling flip-faded
    expect(tokenAt('Catch_A', label)).to.not.exist;             // winner departed
    expect(tokenAt('Process_1', label)).to.not.exist;           // End_A passed through → instance done
  });

});


describe('simulator — standard-loop activity', function() {

  // StartEvent_1 → Task_loop (↻ standard loop) → EndEvent_1
  beforeEach(bootstrap(loopXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('re-enters on a plain double-click, departs once an outflow is selected', async function() {
    const sim = get('simulator');
    const er = get('elementRegistry');
    const eventBus = get('eventBus');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');
    expect(posAt('Task_loop', label)).to.equal('entry');

    // entry → busy → completion; at completion the (single) outflow dims, awaiting a pick
    await sim._step('Task_loop', label); // entry → busy
    await sim._step('Task_loop', label); // busy → completion
    expect(posAt('Task_loop', label)).to.equal('completion');
    expect(er.getGraphics('Flow_2').classList.contains('bts-dim')).to.be.true;

    // a plain double-click (no outflow selected) re-enters → back to the ready/entry position
    await sim._step('Task_loop', label);
    expect(posAt('Task_loop', label)).to.equal('entry');
    expect(er.getGraphics('Flow_2').classList.contains('bts-dim')).to.be.false; // undimmed on re-entry

    // run the iteration again; this time select the outflow before advancing → it departs
    await sim._step('Task_loop', label); // entry → busy
    await sim._step('Task_loop', label); // busy → completion
    eventBus.fire('element.click', { element: er.get('Flow_2') });
    await sim._step('Task_loop', label); // completion → depart (a flow is selected)

    expect(tokenAt('Task_loop', label)).to.not.exist;  // left the activity
    expect(tokenAt('Process_1', label)).to.not.exist;  // end passed through → instance finished
    expect(er.getGraphics('Flow_2').classList.contains('bts-dim')).to.be.false;
  });


  it('keeps its boundary event armed across a loop re-entry (sheds it only on depart)', async function() {
    const sim = get('simulator');
    const er = get('elementRegistry');
    const eventBus = get('eventBus');

    const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

    // entry → busy arms the (non-interrupting) boundary listener
    await sim._step('Task_loop', label); // entry → busy
    expect(tokenAt('BoundaryEvent_1', label), 'armed at busy').to.exist;

    await sim._step('Task_loop', label); // busy → completion

    // re-enter (plain double-click): the boundary listener must survive — one activity execution
    await sim._step('Task_loop', label);
    expect(posAt('Task_loop', label)).to.equal('entry');
    expect(tokenAt('BoundaryEvent_1', label), 'still armed across the loop').to.exist;

    // run the next iteration to busy: re-arming is idempotent, no duplicate listener
    await sim._step('Task_loop', label); // entry → busy
    expect(get('simulation').getTokens('BoundaryEvent_1', label)).to.have.length(1);

    // depart the loop → now the boundary is shed
    await sim._step('Task_loop', label); // busy → completion
    eventBus.fire('element.click', { element: er.get('Flow_2') });
    await sim._step('Task_loop', label); // completion → depart
    expect(tokenAt('BoundaryEvent_1', label), 'shed once the activity departs').to.not.exist;
  });


  describe('link events', function() {

    beforeEach(bootstrap(linkXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    it('teleports a token from a link throw to its matching catch, then continues', async function() {
      const sim = get('simulator');

      const label = await sim.spawnInstance('Process_1', 'StartEvent_1');

      // run Task_1 and depart it — the token travels into the link throw, which auto-jumps to the
      // matching catch and continues, all in one chain
      await sim.advanceToBusy({ node: 'Task_1', label });
      await sim.advanceToCompletion({ node: 'Task_1', label });
      await sim.advanceToDeparted({ node: 'Task_1', label });
      await flush();

      // neither the throw nor the catch holds the token any more — it resumed past the catch at Task_2,
      // carrying the same identity (no sequence flow ever ran between throw and catch)
      expect(tokenAt('LinkThrow_A', label)).to.not.exist;
      expect(tokenAt('LinkCatch_A', label)).to.not.exist;
      expect(posAt('Task_2', label)).to.equal('entry');
      expect(tokenAt('Task_2', label).state.animate).to.equal('bounce');
    });

  });

});


describe('simulator — collaboration (pools)', function() {

  // two pools; the Order pool's start (StartEventOrder) sits in Participant_1c07lhk and feeds the
  // sequential MI sub-process JobActivity
  beforeEach(bootstrap(collaborationXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('spawns an instance from a pool start event (job-shop model)', async function() {
    const sim = get('simulator');
    const label = await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder');
    await flush();

    // the pool is the box (busy), the start has departed, and the token reached the MI sub-process
    expect(posAt('Participant_1c07lhk', label)).to.equal('busy');
    expect(tokenAt('StartEventOrder', label)).to.not.exist;
    expect(tokenAt('JobActivity', label)).to.exist;
  });

  it('spawns successive sub-instances of the MI sub-process on repeated double-clicks', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');

    const label = await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder');
    await flush();

    // the MI outer token rests on the sub-process's incoming flow
    const inflow = simulation.getEntry('JobActivity', label).sequenceFlow;

    // first double-click → first sub-instance
    await sim._step('JobActivity', label, inflow);
    await flush();
    expect(simulation.getToken('JobActivity', label + '/1')).to.exist;

    // second double-click → a SECOND, distinctly-labelled sub-instance (this is where a duplicate-label
    // error <label/1 already exists> was reported)
    await sim._step('JobActivity', label, inflow);
    await flush();
    expect(simulation.getToken('JobActivity', label + '/2')).to.exist;
  });

  it('the MI outer token at JobActivity is tied to the front pool instance', async function() {
    const sim = get('simulator');
    const a = get('animation');
    get('simulation').autoFocus(true); // the simulator's real default (TestHelper resets it off)

    const i1 = await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder');
    await flush();
    const i2 = await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder');
    await flush();

    // two pool instances; i2 is the one on screen
    expect(a.getStackSize('Participant_1c07lhk')).to.equal(2);
    expect(a.getCurrentStack('Participant_1c07lhk')).to.equal(i2);

    // both MI outer tokens exist in the model, one per instance...
    expect(tokenAt('JobActivity', i1)).to.exist;
    expect(tokenAt('JobActivity', i2)).to.exist;

    // ...but only the **front** instance's MI outer token is rendered (gated by the pool stack)
    const dots = document.querySelectorAll('.bts-token-count[data-node-id="JobActivity"]');
    expect(dots.length, 'only the front pool instance shows its MI outer token').to.equal(1);
  });

  it('spawns MI subs for the FRONT pool instance when several are stacked', async function() {
    const sim = get('simulator');
    const simulation = get('simulation');
    get('simulation').autoFocus(true);

    await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder'); // I1
    await flush();
    await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder'); // I2
    await flush();
    const i3 = await sim.spawnInstance('Participant_1c07lhk', 'StartEventOrder'); // I3, front
    await flush();

    const inflow = simulation.getEntry('JobActivity', i3).sequenceFlow;

    // two double-clicks on the front instance's MI outer token → two DISTINCT subs (no I3/1 collision)
    await sim._step('JobActivity', i3, inflow);
    await flush();
    await sim._step('JobActivity', i3, inflow);
    await flush();

    expect(simulation.getToken('JobActivity', i3 + '/1'), 'first sub of the front instance').to.exist;
    expect(simulation.getToken('JobActivity', i3 + '/2'), 'second sub of the front instance').to.exist;
  });

});
