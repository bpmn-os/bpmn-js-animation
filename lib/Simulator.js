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
 * Built incrementally, one slice at a time. **This slice:** spawning an instance (C1), the
 * linear lifecycle of a task, unique-outflow departure (D1/D2), and a no-outflow consume (D3)
 * with process completion. Gateways (fork/join), MI activities, boundary + event sub-processes,
 * the event-based-gateway race, and the outflow-ambiguity Fallback are upcoming slices.
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
 *    straight to the symbol `center`: **throw** → `center/none` then passes straight through
 *    (A2 + D2); **catch** → `center/bounce`, then awaits a double-click (A3); **end** (no
 *    outflow) → `center/none`, then awaits a double-click (→ flip + consume).
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
      await this._simulation.advanceToken({ node, label });          // center/none
      return this.advanceToDeparted({ node, label });                // pass through
    }
    if (c.event === 'end') {
      return this._simulation.advanceToken({ node, label });         // center/none (await dbl-click)
    }
    // catch (and any other intermediate) → center/bounce, await a double-click trigger
    return this._simulation.advanceToken({ node, label, animate: 'bounce' });
  }

  // gateways are a later slice
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
 *  - **multiple outflows** → fork (parallel/event-based) or wait for the user (Fallback) —
 *    upcoming slices.
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

  // multiple outflows — gateways / Fallback are a later slice
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

// Consume a token (optionally flipping once first), then check whether its instance is now
// complete (the process root has no more live children → finish + terminate it).
Simulator.prototype._consume = async function(node, label, flip) {
  if (flip) {
    await this._simulation.playTokenEffect(node, label, 'flip');
  }

  const removed = await this._simulation.consumeToken({ node, label });
  await this._checkCompletion(label);

  return removed;
};

// A process instance finishes when its root token has no live children left. Advance the box to
// `completion/none` and consume the root (terminate). Idempotent — drops the instance afterward.
Simulator.prototype._checkCompletion = async function(label) {
  const inst = this._instances.get(label);
  if (!inst) {
    return;
  }

  const root = this._simulation.getToken(inst.processId, label);
  if (!root || this._simulation.getChildren(root).length > 0) {
    return;
  }

  this._instances.delete(label);
  await this._simulation.advanceToken({ node: inst.processId, label, position: Position.COMPLETION, animate: null });
  await this._simulation.consumeToken({ node: inst.processId, label });
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
    if (phase === 'entry') {
      return this.advanceToBusy({ node, label });
    }
    if (phase === 'busy') {
      return this.advanceToCompletion({ node, label });
    }
    if (phase === 'completion') {
      return this.advanceToDeparted({ node, label });
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
