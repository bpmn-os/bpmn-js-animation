import { is } from 'bpmn-js/lib/util/ModelUtil';

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
 * consume (D3) with process completion; and **parallel gateways** — a diverging parallel/event-based
 * gateway forks every outflow, a converging parallel gateway joins once all branches arrive. The
 * standard-loop re-entry, MI activities, sub-process entry, boundary + event sub-processes, the
 * event-based-gateway race, and the exclusive/inclusive/complex outflow Fallback are upcoming slices.
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

  // double-click a process start event → spawn an instance; double-click a token → advance it
  eventBus.on('element.dblclick', e => this._onElementDblClick(e));
  eventBus.on('token.dblclick', e => this._onTokenDblClick(e));
  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this._reset());
}

Simulator.$inject = [ 'eventBus', 'simulation', 'elementRegistry', 'selection', 'canvas' ];

Simulator.prototype._reset = function() {
  this._counter = 0;                 // instance labels I1, I2, …
  this._instances = new Map();       // label -> { processId } (for completion detection)
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

  // root token at the process box, start-event child at its center
  this._simulation.createToken({ node: processId, label });
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
    // throw + end events pass through **automatically**: anchor at center, then depart — a throw
    // travels its outflow, an end event (no outflow) flips once and is consumed (D3). No wait.
    if (c.event === 'throw' || c.event === 'end') {
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
Simulator.prototype.advanceToBusy = function(args) {
  const { node, label } = args;
  const c = classify(this._requireElement(node));
  const animate = (c.process || c.subProcess) ? 'pulse' : 'bounce';
  return this._simulation.advanceToken({ node, label, position: Position.BUSY, animate });
};

/**
 * Advance an activity/container token to `completion` — `completion/none` for a process,
 * `completion/bounce` for an activity.
 *
 * @param {{ node: string, label: string }} args
 */
Simulator.prototype.advanceToCompletion = function(args) {
  const { node, label } = args;
  const c = classify(this._requireElement(node));
  const animate = c.process ? null : 'bounce';
  return this._simulation.advanceToken({ node, label, position: Position.COMPLETION, animate });
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
  const outgoing = element.outgoing || [];

  if (outgoing.length === 0) {
    return this._consume(node, label, true); // D3: flip + consume
  }

  if (outgoing.length === 1) {
    return this._travel(node, label, outgoing[0].id, classify(element));
  }

  // multiple outflows
  const c = classify(element);
  if (c.gateway === 'parallel' || c.gateway === 'eventBased') {
    return this._forkAll(element, label); // fork every outflow, advance each (immediately)
  }
  // exclusive/inclusive/complex split → outflow-ambiguity Fallback (a later slice)
};

// --- helpers ----------------------------------------------------------------

// Travel a token along an outflow to the far node, then auto-enter that node. A **catching
// event** flips once before it departs (the trigger gesture).
Simulator.prototype._travel = function(node, label, flowId, c) {
  const flip = c && c.event === 'catch'
    ? this._simulation.playTokenEffect(node, label, 'flip')
    : Promise.resolve();

  return flip
    .then(() => this._simulation.advanceToken({ node, label, sequenceFlow: flowId }))
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

// Fork a (diverging) parallel/event-based gateway down **every** outflow, then travel each branch
// to its far node. The forks are sequential (the first moves the original, the rest clone — see
// SimulationAPI.forkToken); the travels run concurrently.
Simulator.prototype._forkAll = async function(element, label) {
  const flowIds = (element.outgoing || []).map(f => f.id);

  for (const flowId of flowIds) {
    await this._simulation.forkToken({ node: element.id, label, sequenceFlow: flowId });
  }

  const c = classify(element);
  return Promise.all(flowIds.map(flowId => this._travel(element.id, label, flowId, c)));
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

// Play the consume gesture (flip → fade-out) on a token's dot, then remove it from the model.
Simulator.prototype._gestureThenRemove = async function(node, label, gesture) {
  if (gesture) {
    await this._simulation.playTokenEffect(node, label, 'flip');
    await this._simulation.playTokenEffect(node, label, 'fade-out');
  }
  return this._simulation.consumeToken({ node, label });
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
      return this.advanceToDeparted({ node, label }); // task & sub-process both step here
    }
  }
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
