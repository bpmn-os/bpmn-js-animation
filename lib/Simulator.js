import { is } from 'bpmn-js/lib/util/ModelUtil';
import { classes as domClasses } from 'min-dom';

import { classify } from './classify';
import { Position } from './positions';

/**
 * Simulator — an opinionated, **interactive** BPMN token simulator built on the `simulation`
 * service. It is integrated like `bpmn-js-token-simulation` (add the default module to
 * `additionalModules`, import the CSS) so the two are swappable, and it is **self-contained**:
 * the user drives tokens by **double-clicking** them, no host orchestration code.
 *
 * Every flow node runs the **same lifecycle** — `arrived → entry → busy → completion →
 * departed` — exposed as `advanceTo*` phase steps that **branch by node type inside**. A
 * double-click on a token advances it to its next phase; arrival auto-advances per the
 * prescribed rules. The simulator owns no token state — it reads/derives everything from the
 * `simulation` service (token entries, the instance tree) and only tracks a small instance
 * registry (the process node each instance was spawned at) for completion detection.
 *
 * Built incrementally, one slice at a time. **So far:** spawning an instance (C1); the task
 * lifecycle (entry → busy → completion → depart); unique-outflow departure (D1/D2); a no-outflow
 * consume (D3) with process completion; a **terminate** end event (kills the whole instance);
 * **parallel gateways** (diverging forks every outflow, converging joins once all branches arrive);
 * **boundary events** — armed when the activity becomes busy, shed on its normal departure, and on
 * firing flip + depart their outflow, then cancel the host (interrupting) or re-arm (non-interrupting);
 * the exclusive/inclusive/complex **outflow Fallback** (a diverging split dims its outflows and the
 * token waits; the user clicks to pick — single for exclusive, multi for inclusive/complex — then a
 * double-click forks along the picks); an interim inclusive/complex **converging join** (a double-click
 * on an arrived branch joins whatever has arrived); and **standard-loop re-entry** (at completion the
 * outflows dim — a plain double-click re-enters for another iteration, picking an outflow departs). MI
 * activities, sub-process entry, event sub-processes, and the event-based-gateway race are upcoming.
 */
export default function Simulator(eventBus, simulation, elementRegistry, selection, canvas) {
  this._simulation = simulation;
  this._elementRegistry = elementRegistry;
  this._selection = selection;
  this._canvas = canvas;
  this._eventBus = eventBus;

  this._reset();

  // reveal the instance being driven: every touch brings its stack to the front, so the
  // just-spawned / just-advanced token is the visible copy (the interactive default)
  simulation.autoFocus(true);

  // double-click a process start event → spawn an instance; double-click a token → advance it;
  // click a candidate outflow of a waiting gateway → toggle it (the outflow-ambiguity Fallback)
  eventBus.on('element.dblclick', e => this._onElementDblClick(e));
  eventBus.on('token.dblclick', e => this._onTokenDblClick(e));
  eventBus.on('element.click', e => this._onElementClick(e));
  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this._reset());
}

Simulator.$inject = [ 'eventBus', 'simulation', 'elementRegistry', 'selection', 'canvas' ];

Simulator.prototype._reset = function() {
  this._counter = 0;                 // instance labels I1, I2, …
  this._instances = new Map();       // label -> { processId } (for completion detection)
  this._chosen = new Map();          // waiting gateway node -> { label, flows: Set<flowId> } (Fallback)
};

// --- input ------------------------------------------------------------------

// Double-click a process start event → spawn a new instance (C1). A start event isn't stacked,
// so this never collides with the animation module's element.dblclick stack-scroll.
Simulator.prototype._onElementDblClick = function(event) {
  const element = event.element;

  if (!element || !is(element, 'bpmn:StartEvent')) {
    return;
  }

  const scope = element.parent && this._shapeOf(element.parent);

  // only the start event of a (top-level) process spawns an instance; an event sub-process
  // start fires differently (a later slice)
  if (!scope || !is(scope, 'bpmn:Process') || classify(scope).eventSubProcess) {
    return;
  }

  this._run(this.spawnInstance(scope.id, element.id));
};

// Double-click a token dot → advance it to its next lifecycle phase.
Simulator.prototype._onTokenDblClick = function(event) {
  const { node, label, sequenceFlow } = event;
  this._run(this._step(node, label, sequenceFlow));
};

// --- creation ---------------------------------------------------------------

/**
 * Spawn a new process instance (C1): a root token at the process box (`entry`) + a child at the
 * start event (`center`), then the process advances to `busy/pulse` (it is now running) and the
 * untyped start event departs immediately along its unique outflow (D1).
 *
 * @param {string} processId
 * @param {string} [startEventId]  the start event to enter at (defaults to the first one)
 * @return {Promise<string>} the new instance label
 */
Simulator.prototype.spawnInstance = async function(processId, startEventId) {
  const process = this._requireElement(processId);
  const start = startEventId
    ? this._requireElement(startEventId)
    : (process.children || []).find(el => is(el, 'bpmn:StartEvent'));

  if (!start) {
    throw new Error(`spawnInstance: process <${processId}> has no start event`);
  }

  const label = 'I' + (++this._counter);
  this._instances.set(label, { processId });

  // root token at the process box — for a 2nd+ instance this reveals it with a stack arc
  this._simulation.createToken({ node: processId, label });

  // let that reveal finish before the start-event child appears, so the start token doesn't show
  // while the stack is still scrolling the new instance to the front
  await this._simulation.whenFocused();
  this._simulation.createToken({ node: start.id, label });

  // the instance is running → process box advances to busy/pulse
  await this._simulation.advanceToken({ node: processId, label, position: Position.BUSY, animate: 'pulse' });

  // D1: an untyped start event is left immediately along its unique outflow
  await this.advanceToDeparted({ node: start.id, label });

  return label;
};

// --- lifecycle phases (branch by node type inside) --------------------------

/**
 * Advance a just-arrived token (resting on its incoming flow) to the **entry** phase. The
 * arrival auto-advance, by node type:
 *  - **activity** (non-MI) → the `entry` position, `bounce` (A1) — then it **awaits a
 *    double-click** to enter and proceed to `busy`.
 *  - **events: entry is immediate** — there is no waiting `entry` position; the token goes
 *    straight to the symbol `center`. **throw** and **end** events then pass through
 *    automatically (A2 + D2/D3): a throw travels its outflow, an end (no outflow) flips once
 *    and is consumed. **catch** → `center/bounce`, then awaits a double-click trigger (A3).
 *
 * @param {{ node: string, label: string }} args
 */
Simulator.prototype.advanceToEntry = async function(args) {
  const { node, label } = args;
  const element = this._requireElement(node);
  const c = classify(element);

  if (c.profile === 'activity') {
    // (MI activities stay on the incoming flow — a later slice.)
    return this._simulation.advanceToken({ node, label, position: Position.ENTRY, animate: 'bounce' });
  }

  if (c.profile === 'event') {
    if (c.event === 'throw') {
      // pass through automatically: center, **emit the icon**, then depart
      await this._simulation.advanceToken({ node, label });          // center/none
      await this._eventIcon(node, label, element);                   // the icon flies out
      return this.advanceToDeparted({ node, label });
    }
    if (c.event === 'end') {
      // pass through automatically: center, then flip + consume (D3)
      await this._simulation.advanceToken({ node, label });          // center/none
      return this.advanceToDeparted({ node, label });
    }
    // catch (and any other intermediate) → center/bounce, await a double-click trigger
    return this._simulation.advanceToken({ node, label, animate: 'bounce' });
  }

  if (c.profile === 'gateway') {
    return this._gatewayArrived(node, label, element, c);
  }
};

/**
 * Advance an activity/container token to `busy` — `busy/pulse` for a process or sub-process,
 * `busy/bounce` for a task/call-activity.
 *
 * @param {{ node: string, label: string }} args
 */
Simulator.prototype.advanceToBusy = async function(args) {
  const { node, label } = args;
  const c = classify(this._requireElement(node));
  const animate = (c.process || c.subProcess) ? 'pulse' : 'bounce';
  await this._simulation.advanceToken({ node, label, position: Position.BUSY, animate });
  this._spawnBoundaries(node, label); // boundary listeners arm as the activity becomes busy
};

/**
 * Advance an activity/container token to `completion` — `completion/none` for a process,
 * `completion/bounce` for an activity.
 *
 * @param {{ node: string, label: string }} args
 */
Simulator.prototype.advanceToCompletion = async function(args) {
  const { node, label } = args;
  const element = this._requireElement(node);
  const c = classify(element);
  const animate = c.process ? null : 'bounce';
  await this._simulation.advanceToken({ node, label, position: Position.COMPLETION, animate });

  // a standard-loop activity offers a choice at completion (reusing the outflow-Fallback UI): its
  // outflows dim, and the bouncing token awaits a double-click. With **no** flow selected the
  // double-click re-enters the activity (another iteration); selecting a flow departs along it.
  if (c.loop && (element.outgoing || []).length) {
    const fb = { label, flows: new Set() };
    this._chosen.set(node, fb);
    this._paintFallback(element, fb);
  }
};

/**
 * Depart a token from its node:
 *  - **no outflow** → flip once and consume it (D3); then check the instance for completion.
 *  - **unique outflow** → travel along it (D1/D2); the far node auto-enters on arrival.
 *  - **multiple outflows** → a parallel/event-based gateway **forks** every outflow and advances
 *    each immediately; an exclusive/inclusive/complex split with several outflows waits for the
 *    user to pick (the outflow-ambiguity Fallback — a later slice).
 *
 * @param {{ node: string, label: string }} args
 */
Simulator.prototype.advanceToDeparted = async function(args) {
  const { node, label } = args;
  const element = this._requireElement(node);
  const c = classify(element);

  // a catch event being triggered (intermediate catch **or** boundary — both `bpmn:CatchEvent`):
  // receive its icon, then depart (a boundary additionally detaches/cancels/re-arms)
  if (c.event === 'catch' || c.event === 'boundary') {
    return this.triggerCatchEvent(node, label);
  }

  // general pattern: tokens that become irrelevant are consumed at depart, **before** the travel.
  // An activity's untriggered boundary listeners go now (flip-fade), so they don't linger or get
  // instantly W1-shed mid-travel.
  await this._shedBoundaries(node, label);

  const outgoing = element.outgoing || [];

  if (outgoing.length === 0) {
    // a terminate end event ends the whole instance (kills every sibling token); a plain end
    // event consumes just itself (D3)
    return c.terminate ? this._terminate(label) : this._consume(node, label, true);
  }

  if (outgoing.length === 1) {
    return this._travel(node, label, outgoing[0].id);
  }

  // multiple outflows
  if (c.gateway === 'parallel' || c.gateway === 'eventBased') {
    return this._forkAlong(element, label, outgoing.map(f => f.id)); // fork every outflow, immediately
  }
  // exclusive/inclusive/complex split → the outflow-ambiguity Fallback: depart along the user's
  // selected outflow(s); with none selected, the token pulse-pauses and the candidates pulse to invite a pick
  return this._departSelected(node, label, element);
};

// --- helpers ----------------------------------------------------------------

// The token emits / receives the event's own icon when it passes through / is triggered, by the
// BPMN type hierarchy: a **throw** event (`bpmn:ThrowEvent` — intermediate throw, end, …) emits it
// (icon flies out); a **catch** event (`bpmn:CatchEvent` — intermediate catch, boundary, start, …)
// receives it (icon flies in). No-op when the event has no distinct icon (e.g. a plain event).
Simulator.prototype._eventIcon = function(node, label, element) {
  if (is(element, 'bpmn:ThrowEvent')) {
    return this._simulation.throwIcon(node, label);
  }
  if (is(element, 'bpmn:CatchEvent')) {
    return this._simulation.catchIcon(node, label);
  }
  return Promise.resolve();
};

// Travel a token along an outflow to the far node, then auto-enter that node.
Simulator.prototype._travel = function(node, label, flowId) {
  return this._simulation.advanceToken({ node, label, sequenceFlow: flowId })
    .then(landed => this.advanceToEntry({ node: landed.node, label: landed.label }));
};

// A token arrived at a gateway (resting on an incoming flow):
//  - **converging** (2+ inflows): a *parallel* join waits for **every** inflow to be occupied,
//    then joins all branches into one and departs; exclusive/inclusive/complex converging are
//    later slices (the token rests until then).
//  - **diverging / pass-through** (≤1 inflow): anchor at the center, then depart — which forks
//    (parallel/event-based) or proceeds (unique outflow), all immediately.
Simulator.prototype._gatewayArrived = async function(node, label, element, c) {
  const incoming = element.incoming || [];

  if (incoming.length >= 2) {
    if (c.gateway === 'parallel') {
      const occupied = new Set(this._arrivedBranches(node, label).map(t => t.state.sequenceFlow));
      if (occupied.size >= incoming.length) {
        await this._simulation.joinTokens({ node, label }); // collapse the branches → center
        return this.advanceToDeparted({ node, label });
      }
      return; // not all branches in yet — this one waits on its inflow
    }
    return; // exclusive/inclusive/complex converging — a later slice
  }

  await this._simulation.advanceToken({ node, label }); // anchor at center
  return this.advanceToDeparted({ node, label });
};

// Fork a (diverging) gateway down the given outflows, then travel each branch to its far node. The
// forks are sequential (the first moves the original, the rest clone — see SimulationAPI.forkToken);
// the travels run concurrently. One flow = a plain move + travel.
Simulator.prototype._forkAlong = async function(element, label, flowIds) {
  for (const flowId of flowIds) {
    await this._simulation.forkToken({ node: element.id, label, sequenceFlow: flowId });
  }
  return Promise.all(flowIds.map(flowId => this._travel(element.id, label, flowId)));
};

// Outflow-ambiguity Fallback (exclusive/inclusive/complex diverging): depart along the **user-selected**
// outflow(s) — a single selection moves the token, several fork it. With none selected, the token
// keeps pulse-pausing and **all** outflows dim (semi-transparent) to invite a pick; the user clicks
// flow(s) to undim them, then double-clicks the token again.
Simulator.prototype._departSelected = function(node, label, element) {
  let fb = this._chosen.get(node);

  if (!fb || fb.flows.size === 0) {
    // enter / stay waiting: every outflow dims, the user picks by clicking flows
    if (!fb) {
      fb = { label, flows: new Set() };
      this._chosen.set(node, fb);
    }
    this._paintFallback(element, fb);
    return this._simulation.setCue(node, label, 'pulse-pause');
  }

  const flowIds = [ ...fb.flows ];
  this._clearFallback(element);
  return this._forkAlong(element, label, flowIds);
};

// Click an outflow of a waiting gateway → **toggle** it: a single-only toggle for an **exclusive**
// gateway (picking one clears the rest), a multi toggle for **inclusive/complex**.
Simulator.prototype._onElementClick = function(event) {
  const flow = event.element;
  if (!flow || !is(flow, 'bpmn:SequenceFlow') || !flow.source) {
    return;
  }
  const gateway = flow.source;
  const fb = this._chosen.get(gateway.id);
  if (!fb) {
    return; // not an outflow of a waiting gateway
  }
  const outgoing = new Set((gateway.outgoing || []).map(f => f.id));
  if (!outgoing.has(flow.id)) {
    return;
  }

  if (classify(gateway).gateway === 'exclusive') {
    fb.flows.clear();
    fb.flows.add(flow.id);
  } else if (fb.flows.has(flow.id)) {
    fb.flows.delete(flow.id);
  } else {
    fb.flows.add(flow.id);
  }

  this._paintFallback(gateway, fb);
};

// Paint a waiting gateway's outflows: every outflow **dims** (semi-transparent) except the ones the
// user has **chosen**, which render at full opacity (black). No colour, no pulse — opacity on
// `.djs-visual` dims line + arrowhead together and reverts cleanly (the inline stroke is untouched).
Simulator.prototype._paintFallback = function(element, fb) {
  for (const flow of (element.outgoing || [])) {
    const gfx = this._elementRegistry.getGraphics(flow.id);
    if (gfx) {
      domClasses(gfx).toggle('bts-dim', !fb.flows.has(flow.id));
    }
  }
};

// Restore a gateway's outflows to full opacity and forget its choice.
Simulator.prototype._clearFallback = function(element) {
  this._chosen.delete(element.id);
  for (const flow of (element.outgoing || [])) {
    const gfx = this._elementRegistry.getGraphics(flow.id);
    if (gfx) {
      domClasses(gfx).remove('bts-dim');
    }
  }
};

// Arm a listener token on each boundary event attached to the activity — a bouncing catch-event
// cue awaiting a trigger. Each is cloned from the activity token as its child (SimulationAPI), so
// a normal departure sheds them (W1) and an interrupting fire's host consume tears the rest down.
Simulator.prototype._spawnBoundaries = function(node, label) {
  const element = this._elementRegistry.get(node);
  for (const attacher of (element.attachers || [])) {
    this._simulation.createToken({ node: attacher.id, label, animate: 'bounce' });
  }
};

// Consume an activity's still-armed (untriggered) boundary listeners with the flip-fade gesture —
// they're irrelevant once the activity departs. Done before the travel, so the W1 auto-shed in
// `_travelFlow` finds nothing left to tear down instantly.
Simulator.prototype._shedBoundaries = function(node, label) {
  const element = this._elementRegistry.get(node);
  const armed = (element.attachers || []).filter(b => this._simulation.getToken(b.id, label));
  return Promise.all(armed.map(b => this._consume(b.id, label, true)));
};

/**
 * Trigger a catch event (the user double-clicked its waiting token) — one path for **intermediate
 * catch** events and **boundary** events (both `bpmn:CatchEvent`): receive its icon, then depart
 * along its outflow. A **boundary** additionally detaches from its host as it departs (so it
 * survives), and — **interrupting** → cancels the host activity + its other children concurrently
 * with the travel; **non-interrupting** → re-arms a fresh listener as the triggered token starts
 * travelling. The path then continues from the far node (or, with no outflow, is consumed).
 *
 * @param {string} node
 * @param {string} label
 */
Simulator.prototype.triggerCatchEvent = async function(node, label) {
  const element = this._requireElement(node);
  const c = classify(element);
  const out = (element.outgoing || [])[0];

  // receive the event's icon
  await this._eventIcon(node, label, element);

  // depart onto the outflow **synchronously** (a boundary token also detaches from its host here),
  // so any host consume / re-arm below acts while it's already off the event node
  if (out) {
    this._simulation.departToken(node, label, out.id);
  }

  if (c.event === 'boundary' && c.interrupting) {
    // cancel the host + its other children **as the boundary starts travelling** (concurrently);
    // the boundary has left the host's subtree, so it survives
    const travelP = out ? this._simulation.advanceToken({ node, label, sequenceFlow: out.id }) : null;
    await this._consume(c.attachedTo, label, true);
    const landed = travelP && await travelP;
    return landed && this.advanceToEntry({ node: landed.node, label: landed.label });
  }

  if (c.event === 'boundary') {
    // non-interrupting → re-arm a fresh listener as the triggered token starts travelling
    this._simulation.createToken({ node, label, animate: 'bounce' });
  }

  // continue the path from the far node (intermediate catch + non-interrupting boundary)
  if (out) {
    const landed = await this._simulation.advanceToken({ node, label, sequenceFlow: out.id });
    return this.advanceToEntry({ node: landed.node, label: landed.label });
  }
  // a catch event with no outflow → flip + consume (D3)
  return this._consume(node, label, true);
};

// Interim inclusive/complex converging join: collapse the branches that have arrived at the gateway
// into one continuation (one per inflow), then depart. Triggered by a double-click on any arrived
// branch — unlike a parallel join it does not wait for every inflow to be occupied.
Simulator.prototype._joinConverging = async function(node, label) {
  await this._simulation.joinTokens({ node, label }); // collapse arrived branches → center
  return this.advanceToDeparted({ node, label });
};

// The branches of instance `label` currently resting on the gateway's **incoming** flows.
Simulator.prototype._arrivedBranches = function(node, label) {
  const element = this._elementRegistry.get(node);
  const incoming = new Set((element.incoming || []).map(f => f.id));
  return this._simulation.getTokens(node, label)
    .filter(t => t.state.sequenceFlow && incoming.has(t.state.sequenceFlow));
};

// Consume a token (with the flip-then-fade gesture, when asked). If this consumes the **last**
// token of a process instance, the process box terminates **concurrently** — it begins gliding to
// `completion` and playing its own gesture right away, rather than waiting the consumed token's
// fade out. The final root removal still waits for the token to be gone first, so the root's
// teardown cascade doesn't double-remove the just-faded token.
Simulator.prototype._consume = function(node, label, gesture) {
  const inst = this._instances.get(label);
  const root = inst && this._simulation.getToken(inst.processId, label);
  const last = !!(root && this._consumesLastToken(root, node, label));

  // the token's own gesture, then its removal — a background chain
  const tokenDone = this._gestureThenRemove(node, label, gesture);

  if (!last) {
    return tokenDone;
  }

  // the instance is finishing — terminate the process box in parallel with the token's fade
  this._instances.delete(label);
  const boxDone = (async () => {
    await this._simulation.advanceToken({ node: inst.processId, label, position: Position.COMPLETION, animate: null });
    if (gesture) {
      await this._simulation.playTokenEffect(inst.processId, label, 'flip');
      await this._simulation.playTokenEffect(inst.processId, label, 'fade-out');
    }
    await tokenDone; // the last token is removed by now → the root cascade has nothing to double-remove
    return this._simulation.consumeToken({ node: inst.processId, label });
  })();

  return Promise.all([ tokenDone, boxDone ]);
};

// Terminate a process instance (a terminate end event was reached): flip-fade **every** token of the
// instance at once, then remove them all. Consuming the root gestures + cascades its whole subtree
// (`_gestureThenRemove`), so the token that reached the terminate event dies along with all siblings.
Simulator.prototype._terminate = function(label) {
  const inst = this._instances.get(label);
  if (!inst) {
    return undefined;
  }
  this._instances.delete(label);
  return this._consume(inst.processId, label, true);
};

// Play the consume gesture (flip → fade-out) on a token **and its whole subtree at the same time**
// — the parent and every descendant flip together, then fade together — then remove the subtree.
// (consumeToken cascades the descendants; the gesture just makes them all animate simultaneously.)
Simulator.prototype._gestureThenRemove = async function(node, label, gesture) {
  if (gesture) {
    const target = this._simulation.getToken(node, label);
    const subtree = target ? this._subtree(target) : [];
    await Promise.all(subtree.map(t => this._simulation.playTokenEffectOn(t, 'flip')));
    await Promise.all(subtree.map(t => this._simulation.playTokenEffectOn(t, 'fade-out')));
  }
  return this._simulation.consumeToken({ node, label });
};

// A token and all its descendants (depth-first), for gesturing a whole subtree at once.
Simulator.prototype._subtree = function(token) {
  const out = [ token ];
  for (const child of this._simulation.getChildren(token)) {
    out.push(...this._subtree(child));
  }
  return out;
};

// Would consuming `(node, label)` empty the instance? True when it's the process root's sole live
// child (so its removal leaves the root with no children → the instance finishes). [Direct-child
// check — generalizes when nested sub-process scopes land.]
Simulator.prototype._consumesLastToken = function(root, node, label) {
  const token = this._simulation.getToken(node, label);
  const children = this._simulation.getChildren(root);
  return children.length === 1 && children[0] === token;
};

// Double-click dispatch: advance the token to its next phase, given its current one.
Simulator.prototype._step = async function(node, label, sequenceFlow) {
  const element = this._elementRegistry.get(node);
  if (!element) {
    return;
  }

  const entry = this._simulation.getEntry(node, label, sequenceFlow);
  if (!entry) {
    return;
  }

  const c = classify(element);
  const phase = this._phaseOf(entry);

  // events & gateways: a single center point → the next double-click departs
  if (c.profile === 'event' || c.profile === 'gateway') {
    if (phase === 'entry') {
      return this.advanceToDeparted({ node, label });
    }
    // interim inclusive/complex **converging** join: double-clicking a branch that has arrived on an
    // inflow joins every branch already resting at the gateway (≤1 per inflow) and departs — it does
    // not wait for all inflows like a parallel join. (Proper inclusive-merge semantics — joining
    // exactly the upstream-active branches — is a later slice.)
    if (phase === 'arrived' && (c.gateway === 'inclusive' || c.gateway === 'complex')
        && (element.incoming || []).length >= 2) {
      return this._joinConverging(node, label);
    }
    return;
  }

  // activities / containers: entry → busy → completion → departed
  if (c.profile === 'activity') {
    // a top-level **process** is fully automatic — `busy` on spawn, `completion` once every child
    // is consumed (`_checkCompletion`) — so it is never advanced by a double-click.
    if (c.process) {
      return;
    }
    if (phase === 'entry') {
      return this.advanceToBusy({ node, label }); // task & sub-process both step here
    }
    if (phase === 'busy') {
      // a **sub-process** completes busy → completion only when its children are all consumed,
      // not by a click — but a task/call-activity DOES step here.
      if (c.subProcess) {
        return;
      }
      return this.advanceToCompletion({ node, label });
    }
    if (phase === 'completion') {
      if (c.loop) {
        return this._loopStep(node, label, element); // re-enter (loop) or depart per the selection
      }
      return this.advanceToDeparted({ node, label }); // task & sub-process both step here
    }
  }
};

// A standard-loop activity double-clicked at completion. With an outflow **selected**, depart along
// it (the loop is done); with **none** selected, **re-enter** — undim, shed this iteration's
// boundary listeners, and advance back to the ready/entry position to run another iteration.
Simulator.prototype._loopStep = function(node, label, element) {
  const fb = this._chosen.get(node);
  this._clearFallback(element);

  // shed this iteration's untriggered boundary listeners (their flip-fade plays on the **children**
  // only, never the activity token) — fire-and-forget, so the token repositions immediately rather
  // than waiting the gesture out
  this._shedBoundaries(node, label);

  if (fb && fb.flows.size > 0) {
    const flowId = [ ...fb.flows ][0]; // a loop activity has one outflow — depart along the selected one
    return this._travel(node, label, flowId);
  }

  return this.advanceToEntry({ node, label }); // re-enter: glide back to the ready/entry position
};

// The lifecycle phase a token is in, from its bookkeeping entry. A token resting on a flow at
// the node is still `arrived`; an anchored token's `position` names the rest. CENTER (an
// event/gateway's only point) reads as `entry` too — for an event, entry *is* the center.
Simulator.prototype._phaseOf = function(entry) {
  if (entry.sequenceFlow) {
    return 'arrived';
  }
  switch (entry.position) {
  case Position.CENTER:
  case Position.ENTRY:
    return 'entry';
  case Position.BUSY:
    return 'busy';
  case Position.COMPLETION:
    return 'completion';
  default:
    return 'arrived';
  }
};

// Run a promise-returning step, surfacing any rejection (the handlers are fire-and-forget).
Simulator.prototype._run = function(p) {
  return Promise.resolve(p).catch(err => console.error('[simulator]', err)); // eslint-disable-line no-console
};

Simulator.prototype._requireElement = function(node) {
  const element = this._elementRegistry.get(node);
  if (!element) {
    throw new Error(`unknown element "${node}"`);
  }
  return element;
};

// A drill-plane root (id `<id>_plane`, businessObject = the sub-process) → its shape.
Simulator.prototype._shapeOf = function(el) {
  const bo = el.businessObject;
  if (bo && el.id !== bo.id) {
    const shape = this._elementRegistry.get(bo.id);
    if (shape) {
      return shape;
    }
  }
  return el;
};
