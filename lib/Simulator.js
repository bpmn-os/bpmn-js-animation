import { is, isAny } from 'bpmn-js/lib/util/ModelUtil';

import { classify } from './classify';
import { Position } from './positions';
import { RECORDED_METHODS, describeEvent } from './executionLog';

/**
 * Simulator — an opinionated, **interactive** BPMN token simulator built on the `animation`
 * service. It is integrated like `bpmn-js-token-simulation` (add the default module to
 * `additionalModules`, import the CSS) so the two are swappable, and it is **self-contained**:
 * the user drives tokens by **double-clicking** them, no host orchestration code.
 *
 * Every flow node runs the **same lifecycle** — `arrived → entry → busy → completion →
 * departed` — exposed as `advanceTo*` phase steps that **branch by node type inside**. A
 * double-click on a token advances it to its next phase; arrival auto-advances per the
 * prescribed rules. The simulator owns no token state — it reads/derives everything from the
 * `animation` service (token entries, the instance tree) and only tracks a small instance
 * registry (the process node each instance was spawned at) for completion detection.
 *
 * Built incrementally, one slice at a time. **So far:** spawning an instance (C1); the task
 * lifecycle (entry → busy → completion → depart — a **send** task flings its message icon on
 * entry→busy and advances immediately; a **receive** task catches its icon on busy→completion and
 * advances only once it lands); unique-outflow departure (D1/D2); a no-outflow
 * consume (D3) with process completion; a **terminate** end event (kills the whole instance);
 * **parallel gateways** (diverging forks every outflow, converging joins once all branches arrive);
 * **boundary events** — armed when the activity becomes busy, shed on its normal departure, and on
 * firing continue a fresh token along their outflow (one `advanceToken` that cancels the host when
 * interrupting, or leaves the listener armed when not);
 * the exclusive/inclusive/complex **outflow Fallback** (a diverging split dims its outflows and the
 * token waits; the user clicks to pick — single for exclusive, multi for inclusive/complex — then a
 * double-click forks along the picks); the inclusive/complex **OR-join** with proper **non-local merge
 * semantics** — it fires (collapsing the arrived branches into one) only once no other live token of the
 * instance can still reach an empty inflow, computed by backward reachability over the whole instance's
 * marking and re-checked on every shrink event (arrival, a pruning divergence, a token removal); **standard-loop re-entry** (at completion the
 * outflows dim — a plain double-click re-enters for another iteration, picking an outflow departs); and
 * **multi-instance activities** (the outer parent pulse-pauses on the incoming flow — each double-click
 * spawns a sub-instance; each sub runs its own entry → busy → completion → consume; the first sub to run
 * parks the parent, the last consume releases it onto the outflow and travels it); and the
 * **event-based-gateway race** (the gateway forks to all its catch events, each waits — triggering one
 * **wins** and flip-fades the losing siblings); and **sub-process entry** (on busy a sub-process seeds
 * its body — the unique untyped start event, auto-run, or for ad-hoc a ready token at each no-incoming
 * activity; drilling into a collapsed plane — and once the body empties it glides to completion/bounce,
 * drilling back out, to await a depart); and **event sub-processes** (a scope arms each event-sub with a
 * waiter at its **typed** start event; double-clicking it fires — **non-interrupting** re-arms and stacks
 * concurrent firings, **interrupting** flip-fades every other token of the scope; armed waiters at start
 * events don't count toward completion, so a scope finishes when its remaining work is done); error/
 * escalation **propagation** (an error/escalation end throws and bubbles the scope hierarchy to a matching
 * boundary or event-sub, innermost first); and **link events** (a link throw jumps the token to a matching
 * link catch — the user picks the target with the same dim-and-select Fallback as an exclusive split).
 *
 * **Not supported** (no plans): **compensation** (compensation throw/boundary/handlers), **call
 * activities**, and **transaction** sub-processes (with their cancel/compensation protocol).
 *
 * **Not enforced** (the controller's call — this is engine-free, so timing/order is the host's): a
 * **sequential** multi-instance's ordering — the simulator spawns sub-instances on demand and runs them
 * in whatever order the user drives them (run one to completion before spawning the next = sequential;
 * interleave several = parallel). Likewise an ad-hoc sub-process's activity ordering and any
 * data-dependent completion condition.
 *
 * **Genuinely not handled:** **message delivery** — message flows are **never traversed** (a token only
 * follows sequence flows), so a throw/receive across pools doesn't pass a token between them.
 */
export default function Simulator(config, eventBus, animation, primitives, elementRegistry, canvas) {
  this._config = config || {};
  // Whether the simulator reacts to the user's gestures. Default **on** so a plain viewer that adds
  // `SimulatorModule` behaves exactly as before. A host with the `mode` controller sets this off outside
  // `simulate` mode (so a modeler can edit, and playback stays read-only) — see lib/Mode.js.
  this._active = this._config.active !== false;
  this._animation = animation;
  this._primitives = primitives;
  this._elementRegistry = elementRegistry;
  this._canvas = canvas;
  this._eventBus = eventBus;
  // The simulator does **no node selection** — it drives tokens + flow dimming only. Host/native node
  // selection still works and is **stack-aware automatically**: the `primitives` service registers an
  // `outline` provider that grows the native selection frame for stacked nodes (see Primitives).

  this._reset();

  // the simulator owns **record**: wrap the `animation` functions it drives so every BPMN event is
  // captured (downloadable as a log, replayable by the `animator`). Off until `startRecording`.
  this._recording = null;
  this._installRecorder(animation);

  // reveal the instance being driven: every touch brings its stack to the front, so the
  // just-spawned / just-advanced token is the visible copy (the interactive default)
  animation.autoFocus(true);

  // mark the canvas container so our CSS hides the native selection box + modeling affordances — the
  // simulator is a token-simulation-style view (clicks still select, but no frame is drawn). The
  // lower-level animation/simulation services don't do this, so a host keeps native selection.
  eventBus.on('diagram.init', () => {
    const container = canvas.getContainer();
    if (container) {
      container.classList.add('bts-simulation');
      // node selection is hidden by default in the simulator; a host can opt in (the simulation
      // panel turns it on by default — both just add this class, unhidden via animation.css)
      if (this._config.nodeSelection) {
        container.classList.add('bts-node-selection');
      }
    }
  });

  // double-click a process start event → spawn an instance; double-click a token → advance it;
  // click a candidate outflow of a waiting gateway → toggle it (the outflow-ambiguity Fallback)
  eventBus.on('element.dblclick', e => this._onElementDblClick(e));
  eventBus.on('token.dblclick', e => this._onTokenDblClick(e));
  eventBus.on('element.click', e => this._onElementClick(e));
  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this._reset());
}

Simulator.$inject = [ 'config.simulator', 'eventBus', 'animation', 'primitives', 'elementRegistry', 'canvas' ];

/** Enable/disable the simulator's reaction to user gestures (double-click to spawn/advance, flow picks).
 * Off in a modeler's `model` mode and during `playback` (read-only) — driven by the `mode` controller.
 * Does not touch the `.bts-simulation` class (the mode controller owns that). */
Simulator.prototype.setActive = function(active = true) {
  this._active = !!active;
};

/** Whether the simulator currently reacts to user gestures. */
Simulator.prototype.isActive = function() {
  return this._active;
};

// --- record: capture the BPMN events driven through `animation` as a flat, replayable log ---------

// Wrap each recorded `animation` method so a call appends a flat event object while recording is on.
// Wraps the shared instance, so it captures the simulator's own driving (and any host calls on it).
Simulator.prototype._installRecorder = function(animation) {
  for (const method of RECORDED_METHODS) {
    const original = animation[method].bind(animation);
    animation[method] = (...args) => {
      const result = original(...args);
      if (this._recording) {
        this._recording.push(describeEvent(method, args));
      }
      return result;
    };
  }
};

/**
 * Begin recording the **BPMN events** as they are driven — e.g. while a user interacts. Each is
 * appended to a flat execution log. View navigation and focus settings are not recorded. Replay the log
 * with the `animator` service; download `getRecording()` as JSON. Resets any prior recording.
 */
Simulator.prototype.startRecording = function() {
  this._recording = [];
};

/** Stop appending to the recording and return it (the log is kept; `startRecording` resets it). */
Simulator.prototype.stopRecording = function() {
  const log = this._recording || [];
  this._recording = null;
  return log;
};

/** The recording so far — an array of flat `{ action, ...fields }` events (a copy). */
Simulator.prototype.getRecording = function() {
  return (this._recording || []).slice();
};

Simulator.prototype._reset = function() {
  this._counters = new Map();        // processId -> instance count (labels "<process>_k", per process)
  this._firingCounters = new Map();  // "<scope>^<eventSubProcess>" -> firing count (non-interrupting)
  this._instances = new Map();       // label -> { processId } (for completion detection)
  this._chosen = new Map();          // waiting gateway node -> { label, flows: Set<flowId> } (Fallback)
  this._recheckingJoins = false;     // re-entrancy guard for _recheckJoins
};

// --- input ------------------------------------------------------------------

// Double-click a process start event → spawn a new instance (C1). A start event isn't stacked,
// so this never collides with the animation module's element.dblclick stack-scroll.
Simulator.prototype._onElementDblClick = function(event) {
  if (!this._active) {
    return; // inactive (model mode / playback) → let the host's modeling (e.g. label editing) handle it
  }
  const element = event.element;

  if (!element || !is(element, 'bpmn:StartEvent')) {
    return;
  }

  const scope = element.parent && this._shapeOf(element.parent);

  // only the start event of a (top-level) **process or pool** spawns an instance — in a collaboration
  // a flow node's parent is the **Participant** (pool) shape, which is the process box; an event
  // sub-process start fires differently.
  if (!scope || !isAny(scope, [ 'bpmn:Process', 'bpmn:Participant' ]) || classify(scope).eventSubProcess) {
    return this._noop(element.id);
  }

  this._run(this.spawnInstance(scope.id, element.id));
};

// Double-click a token dot → advance it to its next lifecycle phase.
Simulator.prototype._onTokenDblClick = function(event) {
  if (!this._active) {
    return; // inactive (model mode / playback) → tokens are read-only
  }
  const { node, label, sequenceFlow } = event;
  // this is now the instance the user is driving — auto-focus follows it, not the automatic
  // operations of other concurrently-running instances
  this._animation.setFocusContext(event.stackIndices);
  // advancing a token selects it — additively, so other selected tokens stay (no list churn). Look
  // the token up first (tolerant: a no-op double-click — e.g. on a process token, or one already
  // gone — selects nothing). The selection rides the token as it moves; fork branches inherit it.
  const tok = this._primitives.getTokens(t =>
    t.node === node && t.label === label && (t.state.sequenceFlow || null) === (sequenceFlow || null)
  )[0];
  if (tok) {
    this._primitives.selectToken(tok.node, tok.label, {
      sequenceFlow: tok.state.sequenceFlow || undefined,
      stackIndices: tok.stackIndices
    });
  }
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

  // label new instances "<processId>_k" with a per-process counter (k): always the process id (like
  // we always use node ids), never the name and never the participant (see _processOf)
  const processBo = this._processOf(processId);
  const k = (this._counters.get(processBo.id) || 0) + 1;
  this._counters.set(processBo.id, k);
  const label = processBo.id + '_' + k;
  this._instances.set(label, { processId });

  // this new instance is now the one the user is driving — auto-focus follows it, so a rapid burst
  // of spawns (each auto-advancing) doesn't thrash the front; the latest spawn stays shown
  this._animation.setFocusContext({ [processId]: label });

  // root token at the process box — for a 2nd+ instance this reveals it with a stack arc
  this._animation.createToken({ node: processId, label });

  // let that reveal finish before the start-event child appears, so the start token doesn't show
  // while the stack is still scrolling the new instance to the front
  await this._animation.whenFocused();
  this._animation.createToken({ node: start.id, label });

  // auto-select the just-spawned instance — its process token + start-event token — so the panel and
  // canvas reflect the spawn (sole-select: clear any prior selection first). Selection rides the token
  // objects, so it persists as the start token departs along its outflow.
  this._selectOnly([ { node: processId, label }, { node: start.id, label } ]);

  // the start event received a token → arm the process's event sub-processes (a waiter at each start)
  this._armEventSubs(processId, label);

  // the instance is running → process box advances to busy/pulse
  await this._animation.advanceToken({ node: processId, label, position: Position.BUSY, animate: 'pulse' });

  // D1: an untyped start event is left immediately along its unique outflow
  await this.advanceToDeparted({ node: start.id, label });

  return label;
};

// Sole-select the given (node, label) tokens: clear the current selection, then select each using
// the token's own selector (a stacked node's token carries stackIndices, so an empty selector misses).
Simulator.prototype._selectOnly = function(refs) {
  for (const t of this._primitives.getSelectedTokens()) {
    this._primitives.deselectToken(t.node, t.label, {
      sequenceFlow: t.state.sequenceFlow || undefined,
      stackIndices: t.stackIndices
    });
  }
  for (const ref of refs) {
    const token = this._primitives.getTokens(t =>
      t.node === ref.node && t.label === ref.label &&
      (!('sequenceFlow' in ref) || (t.state.sequenceFlow || null) === (ref.sequenceFlow || null))
    )[0];
    if (token) {
      this._primitives.selectToken(token.node, token.label, {
        sequenceFlow: token.state.sequenceFlow || undefined,
        stackIndices: token.stackIndices
      });
    }
  }
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
    if (c.multiInstance) {
      // MI: the outer thread token never enters — it rests on the incoming flow and **pulse-pauses**,
      // a spawn point. Each double-click on it spawns a sub-instance (`_miStep`).
      return this._animation.setCue(node, label, 'pulse-pause');
    }
    return this._animation.advanceToken({ node, label, position: Position.ENTRY, animate: 'bounce' });
  }

  if (c.profile === 'event') {
    if (c.event === 'throw') {
      // pass through automatically: anchor at center (advanceToken flies the throw icon out there,
      // fire-and-forget — a link throw included), then depart.
      await this._animation.advanceToken({ node, label });          // center/none
      return this.advanceToDeparted({ node, label });
    }
    if (c.event === 'end') {
      // pass through automatically: anchor at center (advanceToken flies the end's throw icon out there —
      // error/escalation fly their symbol, an untyped end has none), then depart / consume.
      await this._animation.advanceToken({ node, label });          // center/none
      return this.advanceToDeparted({ node, label });
    }
    // catch (and any other intermediate) → center/bounce, await a double-click trigger
    return this._animation.advanceToken({ node, label, animate: 'bounce' });
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
  const element = this._requireElement(node);
  const c = classify(element);
  const animate = (c.process || c.subProcess) ? 'pulse' : 'bounce';
  await this._animation.advanceToken({ node, label, position: Position.BUSY, animate });
  this._spawnBoundaries(node, label); // boundary listeners arm as the activity becomes busy

  // a (non-event) sub-process becoming busy starts its body: drill in (collapsed) and seed its
  // inner token(s) — the unique start event (auto-running) or, ad-hoc, its no-incoming activities.
  if (c.subProcess && !c.eventSubProcess) {
    this._drillInto(node, c);
    return this._enterSubProcess(node, label, element, c);
  }
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
  await this._animation.advanceToken({ node, label, position: Position.COMPLETION, animate });

  // a standard-loop activity offers a choice at completion (reusing the outflow-Fallback UI): its
  // outflows dim, and the bouncing token awaits a double-click. With **no** flow selected the
  // double-click re-enters the activity (another iteration); selecting a flow departs along it.
  if (c.loop && this._outgoing(element).length) {
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

  // An activity's untriggered boundary listeners are dependents of its token, so they are shed
  // automatically as it departs — the travel's `_shedChildren` flip-fades them. No action here, and
  // no recorded consume: their removal follows from the depart, like garbage collection.

  const outgoing = this._outgoing(element);

  if (outgoing.length === 0) {
    // a terminate end ends the whole instance; an **error/escalation** end throws — it propagates up
    // to a matching boundary event (caught → interrupt + continue); a plain end consumes itself (D3)
    if (c.terminate) {
      return this._terminate(label);
    }
    if (c.errorRef !== undefined) {
      return this._propagate(node, label, 'error', c.errorRef);
    }
    if (c.escalationRef !== undefined) {
      return this._propagate(node, label, 'escalation', c.escalationRef);
    }
    if (c.link !== undefined) {
      return this._jumpLink(node, label, c.link); // a link throw jumps to its matching catch
    }
    return this._consume(node, label);
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

// Travel a token along an outflow to the far node, then auto-enter that node.
Simulator.prototype._travel = function(node, label, flowId) {
  return this._animation.advanceToken({ node, label, sequenceFlow: flowId })
    .then(landed => this.advanceToEntry({ node: landed.node, label: landed.label }));
};

// A token arrived at a gateway (resting on an incoming flow):
//  - **converging** (2+ inflows): a *parallel* join waits for **every** inflow to be occupied; an
//    *inclusive/complex* (OR) join fires only once no other live token can still reach an **empty**
//    inflow (the non-local BPMN merge semantics — `_orJoinReady`); both then collapse the arrived
//    branches into one token and depart. Otherwise the token rests on its inflow and waits.
//  - **diverging / pass-through** (≤1 inflow): anchor at the center, then depart — which forks
//    (parallel/event-based) or proceeds (unique outflow), all immediately.
Simulator.prototype._gatewayArrived = async function(node, label, element, c) {
  const incoming = this._incoming(element);

  if (incoming.length >= 2) {
    if (c.gateway === 'parallel') {
      const occupied = new Set(this._arrivedBranches(node, label).map(t => t.state.sequenceFlow));
      if (occupied.size >= incoming.length) {
        return this._fireOrJoin(node, label); // every inflow in → join + depart
      }
      return; // not all branches in yet — this one waits on its inflow
    }
    if (c.gateway === 'inclusive' || c.gateway === 'complex') {
      if (this._orJoinReady(element, label)) {
        return this._fireOrJoin(node, label);
      }
      return; // another branch can still arrive — wait on this inflow (re-checked as state changes)
    }
    return; // exclusive converging — an uncontrolled merge (pass-through); not yet handled, rests
  }

  await this._animation.advanceToken({ node, label }); // anchor at center
  return this.advanceToDeparted({ node, label });
};

// Fork a (diverging) gateway down the given outflows, then travel each branch to its far node. The
// forks are sequential (the first moves the original, the rest clone — see Animation.forkToken);
// the travels run concurrently. One flow = a plain move + travel.
Simulator.prototype._forkAlong = async function(element, label, flowIds) {
  for (const flowId of flowIds) {
    await this._animation.forkToken({ node: element.id, label, sequenceFlow: flowId });
  }
  // a divergence along a strict subset prunes the untaken paths — a downstream OR-join waiting on one
  // of those (now unreachable) inflows may have become ready
  this._recheckJoins(label);
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
    return this._animation.setCue(node, label, 'pulse-pause');
  }

  const flowIds = [ ...fb.flows ];
  this._clearFallback(element);
  return this._forkAlong(element, label, flowIds);
};

// Click an outflow of a waiting gateway → **toggle** it: a single-only toggle for an **exclusive**
// gateway (picking one clears the rest), a multi toggle for **inclusive/complex**.
Simulator.prototype._onElementClick = function(event) {
  if (!this._active) {
    return; // inactive (model mode / playback) → no gateway-outflow / link-target picking
  }
  const el = event.element;
  if (!el) {
    return;
  }

  // a candidate catch of a waiting link throw → choose it as the jump target
  if (is(el, 'bpmn:IntermediateCatchEvent') && this._chooseLinkTarget(el.id)) {
    return;
  }

  const flow = el;
  if (!is(flow, 'bpmn:SequenceFlow') || !flow.source) {
    return;
  }
  const gateway = flow.source;
  const fb = this._chosen.get(gateway.id);
  if (!fb) {
    return; // not an outflow of a waiting gateway
  }
  const outgoing = new Set(this._outgoing(gateway).map(f => f.id));
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
// user has **chosen**, which render at full opacity (black). No colour, no pulse — the dimming is the
// `primitives` service's `setFlowDimmed` primitive (opacity on `.djs-visual`, line + arrowhead together).
Simulator.prototype._paintFallback = function(element, fb) {
  for (const flow of this._outgoing(element)) {
    this._animation.setFlowDimmed(flow.id, !fb.flows.has(flow.id));
  }
};

// Restore a gateway's outflows to full opacity and forget its choice.
Simulator.prototype._clearFallback = function(element) {
  this._chosen.delete(element.id);
  for (const flow of this._outgoing(element)) {
    this._animation.setFlowDimmed(flow.id, false);
  }
};

// --- link events ------------------------------------------------------------

// A **link throw** moves its token to the matching **link catch** (same link name) — there is no
// sequence flow between them. The token is consumed at the throw and a fresh one is created at the
// catch (same instance scope, so it keeps the instance's colour). One match → jump straight there.
// Several matches (invalid BPMN, but handled) reuse the diverging-gateway Fallback over the candidate
// **catch nodes**: they dim, the user clicks one to choose it, and a double-click on the throw then
// jumps to the chosen catch.
Simulator.prototype._jumpLink = function(node, label, link) {
  const catches = this._matchingLinkCatches(link);

  if (catches.length === 0) {
    return this._consume(node, label); // a dead-end throw — nothing catches this link
  }
  if (catches.length === 1) {
    return this._jumpTo(node, label, catches[0]);
  }

  // several candidates → Fallback. If the user has already chosen one (re-entered here by the
  // double-click), jump to it; otherwise dim the candidates and pulse-pause until they pick.
  const fb = this._chosen.get(node);
  if (fb && fb.target) {
    const target = this._requireElement(fb.target);
    this._clearLinkFallback(node);
    return this._jumpTo(node, label, target);
  }
  if (!fb) {
    this._chosen.set(node, { label, candidates: catches.map(c => c.id), target: null });
  }
  this._paintLinkFallback(node);
  return this._animation.setCue(node, label, 'pulse-pause');
};

// Move the token across the link, then continue from the catch as if it had just been triggered. The
// throw's icon flies **out** at the source (fire-and-forget). The token then leaves the throw and a
// fresh one appears at the catch. The consume uses the plain `animation.consumeToken` function rather than
// the simulator's `_consume`, so it is a leaf removal that does not finalize the instance even when the
// throw is its last token. The catch token is a child of the same scope, so it inherits the instance's
// color. `advanceToDeparted` then routes it through `triggerCatchEvent`, which flies the catch's icon
// **in** and departs along the catch's outflow, so the catch icon isn't doubled here.
Simulator.prototype._jumpTo = function(fromNode, label, catchEl) {
  // the throw icon already flew out when the link throw anchored at center (its `advanceToken`)
  this._run(this._animation.consumeToken({ node: fromNode, label }));          // the token leaves the throw (flip-fade)
  this._animation.createToken({ node: catchEl.id, label });                    // and reappears at the catch
  return this.advanceToDeparted({ node: catchEl.id, label });
};

// Every link **catch** event whose link name matches. Skips label elements (they share the catch's
// businessObject, so they'd classify identically and double every match).
Simulator.prototype._matchingLinkCatches = function(link) {
  return this._elementRegistry.filter(el => {
    if (el.labelTarget || el.type === 'label') {
      return false;
    }
    const c = classify(el);
    return c.event === 'catch' && c.link === link;
  });
};

// If `catchId` is a candidate of some waiting link throw, set it as that throw's chosen target and
// repaint. Returns whether a waiting throw claimed the click.
Simulator.prototype._chooseLinkTarget = function(catchId) {
  for (const [throwNode, fb] of this._chosen) {
    if (fb.candidates && fb.candidates.indexOf(catchId) !== -1) {
      fb.target = catchId;
      this._paintLinkFallback(throwNode);
      return true;
    }
  }
  return false;
};

// Paint a waiting link throw's candidate catches: every candidate dims except the chosen target.
Simulator.prototype._paintLinkFallback = function(node) {
  const fb = this._chosen.get(node);
  if (!fb || !fb.candidates) {
    return;
  }
  for (const id of fb.candidates) {
    this._animation.setNodeDimmed(id, id !== fb.target);
  }
};

// Restore a link throw's dimmed candidate catches and forget its choice.
Simulator.prototype._clearLinkFallback = function(node) {
  const fb = this._chosen.get(node);
  if (fb && fb.candidates) {
    for (const id of fb.candidates) {
      this._animation.setNodeDimmed(id, false);
    }
  }
  this._chosen.delete(node);
};

// Arm a listener token on each boundary event attached to the activity — a bouncing catch-event
// cue awaiting a trigger. Each is cloned from the activity token as its child (Animation), so
// a normal departure sheds them (the depart shed) and an interrupting fire's host consume tears the rest down.
Simulator.prototype._spawnBoundaries = function(node, label) {
  const element = this._elementRegistry.get(node);
  for (const attacher of (element.attachers || [])) {
    // idempotent: a standard-loop re-entry keeps its boundaries armed across iterations, so the
    // next busy must not re-create (and double) a listener that's already there
    if (this._animation.getToken(attacher.id, label)) {
      continue;
    }
    this._animation.createToken({ node: attacher.id, label, animate: 'bounce' });
  }
};

// --- sub-processes -----------------------------------------------------------

// A (non-event) sub-process became busy → seed its body. **Non-ad-hoc:** find the **unique untyped**
// start event (throw if not exactly one) and create + auto-advance a token there (it runs the body).
// **Ad-hoc:** a ready/`bounce` token at **each activity with no incoming flow** (the user advances each).
Simulator.prototype._enterSubProcess = function(node, label, element, c) {
  const inner = (element.businessObject.flowElements || [])
    .map(fe => this._elementRegistry.get(fe.id)).filter(Boolean);

  if (c.adHoc) {
    const activities = inner.filter(el => is(el, 'bpmn:Activity') && !this._incoming(el).length);
    for (const a of activities) {
      // an MI child gets the **outer/main** token at the arrival point (pulse-pause = spawn point —
      // double-click it to spawn sub-instances); a plain activity gets a ready/bounce token to advance
      const animate = classify(a).multiInstance ? 'pulse-pause' : 'bounce';
      this._animation.createToken({ node: a.id, label, animate });
    }
    return;
  }

  const starts = inner.filter(el => is(el, 'bpmn:StartEvent') && !(el.businessObject.eventDefinitions || []).length);
  if (starts.length !== 1) {
    throw new Error(`subprocess <${node}> needs exactly one untyped start event (found ${starts.length})`);
  }
  this._animation.createToken({ node: starts[0].id, label });
  this._armEventSubs(node, label); // the inner start received a token → arm this scope's event-subs
  return this.advanceToDeparted({ node: starts[0].id, label }); // auto-run from the start event
};

// Predict whether consuming `(node, label)` empties its enclosing **scope** — the body is finished when
// every other child of the scope token is a **listener** (armed boundary / event-sub waiter). Returns
// the scope **token** (a sub-process token OR the process-root box token — distinguished by its node) so
// one path handles both; null otherwise. Found via `getParent`, so it works whatever the token's label
// (an instance `Process_1`, an MI sub `Process_1#2`, an event-sub firing `Process_1^Esp#1`). Computed **before** the consume.
Simulator.prototype._completedScope = function(node, label) {
  const token = this._animation.getToken(node, label);
  if (!token || this._isArmedWaiter(token)) {
    return null; // consuming a listener never completes a scope
  }
  const scope = this._animation.getParent(token);
  if (!scope) {
    return null;
  }
  const active = this._animation.getChildren(scope).filter(c => c !== token && !this._isArmedWaiter(c));
  return active.length ? null : scope;
};

// A token resting (anchored) on a **listener** — an **event-sub-process** start event (armed firing) or
// a **boundary event** (armed boundary). Listeners don't count toward a scope's completion condition;
// they're torn down when the scope finishes (the body is what completes, not the listeners watching it).
// A process/sub-process's **own** start event (the spawn token) is **not** a waiter — otherwise a
// process whose only token is its start event (e.g. a lone start event with no outflow) never completes.
Simulator.prototype._isArmedWaiter = function(token) {
  if (token.state.sequenceFlow) {
    return false;
  }
  const el = this._elementRegistry.get(token.node);
  if (is(el, 'bpmn:BoundaryEvent')) {
    return true;
  }
  if (is(el, 'bpmn:StartEvent')) {
    // only an event-sub-process's start event is an armed waiter; a plain process/sub-process start is not
    const scope = el.parent && this._shapeOf(el.parent);
    return !!(scope && classify(scope).eventSubProcess);
  }
  return false;
};

// The sub-process body finished → drill back out (if collapsed) and glide it to `completion/bounce`,
// where it awaits a double-click to depart its outflow (the same gesture as a task). The **listeners**
// (armed boundaries + event-sub waiters) stay armed through completion — they are dependents of the
// sub-process token, garbage-collected by the travel's `_shedChildren` when it finally departs.
Simulator.prototype._onSubProcessComplete = function(sp) {
  this._drillOut(sp.node, classify(this._requireElement(sp.node)));
  return this.advanceToCompletion(sp);
};

// Drill the canvas **into** a collapsed sub-process's inner plane (autoFocus is on in the simulator).
// A no-op for an expanded sub-process (its body is already visible) or when there's no drill plane.
Simulator.prototype._drillInto = function(node, c) {
  if (!c.collapsed || !this._canvas.setRootElement) {
    return;
  }
  const plane = this._elementRegistry.get(node + '_plane');
  if (plane) {
    this._canvas.setRootElement(plane);
  }
};

// Drill back **out** to the plane the sub-process's shape lives on — but only if we're currently
// **inside** its plane (so it's safe to call wherever a collapsed sub-process is left).
Simulator.prototype._drillOut = function(node, c) {
  if (!c.collapsed || !this._canvas.setRootElement || !this._canvas.findRoot || !this._canvas.getRootElement) {
    return;
  }
  const plane = this._elementRegistry.get(node + '_plane');
  if (plane && this._canvas.getRootElement() !== plane) {
    return; // not drilled into this sub-process
  }
  const shape = this._elementRegistry.get(node);
  const root = shape && this._canvas.findRoot(shape);
  if (root) {
    this._canvas.setRootElement(root);
  }
};

// --- event sub-processes -----------------------------------------------------

// **Arm** the event sub-processes of a scope (a process / sub-process whose start event just received
// a token): a `bounce` token at each event-sub's start event — a waiting **firing** the host can fire
// by double-clicking. Each is keyed by a fresh firing label (the Animation stacks concurrent firings).
Simulator.prototype._armEventSubs = function(scopeNode, label) {
  for (const evtsp of this._eventSubsOf(scopeNode)) {
    // an event-sub's start event is **typed** (escalation/error/message/…); that typed start is the
    // armed waiter the host fires — only an *untyped* start auto-fires (the scope/sub-process body)
    const start = this._innerOf(evtsp.id).find(e => is(e, 'bpmn:StartEvent') && this._isTyped(e));
    if (start) {
      this._animation.createToken({ node: start.id, label: this._firingLabel(label, evtsp), animate: 'bounce' });
    }
  }
};

// Double-click of an event-sub's start event → **fire**: run the firing through the body, and either
// re-arm a fresh waiter (**non-interrupting**, so firings stack) or kill every other token in the
// surrounding scope (**interrupting**). A no-op fallthrough for a plain (non-event-sub) start event.
Simulator.prototype._fireEventSub = async function(node, label, element) {
  const evtsp = this._shapeOf(element.parent);
  const c = evtsp && classify(evtsp);
  if (!c || !c.eventSubProcess) {
    return this._departAndContinue(node, label); // an ordinary start event — just run
  }

  // the start event's catch icon flies in on its depart (advanceToken), so nothing extra here
  const firing = this._animation.getToken(node, label);
  const scope = firing && this._animation.getParent(firing);
  this._drillInto(evtsp.id, c);

  // **interrupting** cancels the rest of the scope, but `advanceToken` does that itself as the firing
  // departs (so it's not a separate recorded action), so no hook is needed here. **non-interrupting**
  // re-arms a fresh waiter once the firing is off the start.
  const afterDepart = c.interrupting
    ? null
    : () => scope && this._animation.createToken({ node, label: this._firingLabel(scope.label, evtsp), animate: 'bounce' });
  return this._departAndContinue(node, label, afterDepart);
};

// The event sub-processes directly inside a scope.
Simulator.prototype._eventSubsOf = function(scopeNode) {
  return this._innerOf(scopeNode).filter(el => classify(el).eventSubProcess);
};

// The PROCESS businessObject of a node: a Participant (pool) → its processRef; everything else → its
// own businessObject. The single place a participant is resolved to its process — use it wherever we
// name or inspect the process (never the participant).
Simulator.prototype._processOf = function(node) {
  const bo = this._requireElement(node).businessObject;
  return bo.processRef || bo;
};

// The flow-node shapes directly inside an element (its process's flowElements, resolved to shapes).
Simulator.prototype._innerOf = function(node) {
  return (this._processOf(node).flowElements || [])
    .map(fe => this._elementRegistry.get(fe.id))
    .filter(Boolean);
};

// A fresh, unique firing label scoped to an instance (`<scopeLabel>.e<n>`).
// Firing label for an event-subprocess instance, matching the engine's naming (StateMachine.cpp):
//  - **non-interrupting** → a new instance "<scope>^<eventSubProcessId>#<k>", with k a per-(scope,
//    event-sub) counter (so concurrent firings stack distinctly);
//  - **interrupting** → it takes over the instance, keeping the parent (scope) label unchanged.
Simulator.prototype._firingLabel = function(scopeLabel, eventSubProcess) {
  if (classify(eventSubProcess).interrupting) {
    return scopeLabel;
  }
  const key = scopeLabel + '^' + eventSubProcess.id;
  const n = (this._firingCounters.get(key) || 0) + 1;
  this._firingCounters.set(key, n);
  return key + '#' + n;
};

// A **typed** event (carries an event definition — escalation/error/message/timer/…). An event-sub's
// start event is always typed; only an **untyped** start event auto-fires (a scope/sub-process body).
Simulator.prototype._isTyped = function(element) {
  return !!(element.businessObject.eventDefinitions || []).length;
};

// --- error / escalation propagation ------------------------------------------

// An **error/escalation end event** was reached — it *throws*. Per the BPMN spec the thrown
// error/escalation **bubbles up** the scope hierarchy to the innermost matching catch: a boundary
// event on an enclosing activity (the supported catch here). Triggering an interrupting boundary
// consumes its host activity — which cascades the throwing token away — and continues from the
// boundary's outflow. Uncaught at any level → the token is consumed (the path just ends).
Simulator.prototype._propagate = function(node, label, kind, code) {
  const caught = this._findCatch(node, label, kind, code);

  // **Unified end animation:** the throwing token's path ended → flip-fade it **now** (same as any end
  // event — no waiting on the catch's animation). The only BPMN branch is the scope: an **interrupting**
  // catch cancels the whole scope, so consume the token *plainly* (the scope is cancelled by the catch,
  // not completed by this token); otherwise the scope-completing consume (the body may now be empty).
  if (caught && caught.interrupting) {
    this._run(this._animation.consumeToken({ node, label }));
  } else {
    this._run(this._consume(node, label));
  }

  if (!caught) {
    return; // uncaught — the path just ended (already consumed)
  }
  if (caught.kind === 'boundary') {
    return this.triggerCatchEvent(caught.node, label);
  }
  return this._fireEventSub(caught.node, caught.firingLabel, this._requireElement(caught.node));
};

// Walk the scope hierarchy from the throwing event outward for the first matching **armed** catch:
// an event sub-process inside the scope, then a boundary event on the scope's activity (per the BPMN
// "innermost first" order), bubbling to the enclosing scope if neither matches. Returns the catch
// descriptor (`{ kind:'boundary'|'eventsub', node, firingLabel?, interrupting }`) or null.
Simulator.prototype._findCatch = function(node, label, kind, code) {
  // Walk the throwing token's **instance-tree ancestors** (its scope tokens), innermost first — each
  // carries its own instance/firing label, so a handler armed at an outer scope is found under *that*
  // scope's label, not the deep throwing label. (The earlier element-scope walk reused one label and
  // so missed an outer event-sub when the throw came from a nested firing, e.g. `I1.e1` vs `I1`.)
  const throwing = this._animation.getToken(node, label);
  let scope = throwing && this._animation.getParent(throwing);

  while (scope) {
    const scopeEl = this._elementRegistry.get(scope.node);
    if (scopeEl) {
      // 1. an event-sub of this scope with a matching armed start (a waiter child of the scope token)
      for (const evtsp of this._eventSubsOf(scope.node)) {
        const start = this._innerOf(evtsp.id).find(e => is(e, 'bpmn:StartEvent') && this._eventMatches(e, kind, code));
        const firing = start && this._animation.getChildren(scope).find(t => t.node === start.id);
        if (firing) {
          return { kind: 'eventsub', node: start.id, firingLabel: firing.label, interrupting: classify(evtsp).interrupting !== false };
        }
      }
      // 2. a boundary on this scope's activity with a matching armed token (under the scope's label)
      const boundary = (scopeEl.attachers || []).find(b =>
        this._eventMatches(b, kind, code) && this._animation.getToken(b.id, scope.label));
      if (boundary) {
        return { kind: 'boundary', node: boundary.id, interrupting: classify(boundary).interrupting };
      }
    }
    scope = this._animation.getParent(scope);
  }
  return null;
};

// Does `catcher` (a boundary / start event) catch a thrown `kind` (`'error'`/`'escalation'`) of `code`
// (the thrown ref id)? It must carry the matching event definition, and either reference the same id
// or be **catch-all** (no ref).
Simulator.prototype._eventMatches = function(catcher, kind, code) {
  const type = kind === 'error' ? 'bpmn:ErrorEventDefinition' : 'bpmn:EscalationEventDefinition';
  const refProp = kind === 'error' ? 'errorRef' : 'escalationRef';
  const def = (catcher.businessObject.eventDefinitions || []).find(d => d.$type === type);
  if (!def) {
    return false;
  }
  const ref = def[refProp];
  return !ref || !code || ref.id === code;
};

// The element's enclosing **scope** (the activity / process it sits in), bridging a drill-plane root
// to its shape.
Simulator.prototype._scopeOf = function(element) {
  return element.parent ? this._shapeOf(element.parent) : null;
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

  // The catch icon flies in on the depart `advanceToken`, which also derives the event-based-gateway race
  // (cancelling the losing siblings) — both internal to `advanceToken`, so the cancel rides the winner's
  // depart after its icon has landed, and the simulator just departs the catch.

  // A **boundary** fire is handled entirely by `advanceToken` along the outflow: it cancels the host when
  // interrupting (the cascade tears down the listener + the activity's subtree) and leaves the listener
  // armed when not. Call it directly, not via `_departAndContinue` (which would move the listener onto
  // the flow first). A boundary is never behind an event-based gateway, so there is no sibling race here.
  if (c.event === 'boundary') {
    const out = this._outgoing(element)[0];
    if (!out) {
      if (c.interrupting) {
        this._run(this._consume(c.attachedTo, label)); // dead-end interrupting boundary still cancels the host
      }
      return this._consume(node, label);
    }
    const landed = await this._animation.advanceToken({ node, label, sequenceFlow: out.id });
    return this.advanceToEntry({ node: landed.node, label: landed.label });
  }

  // an **intermediate catch** departs and continues; `advanceToken` cancels any event-based-gateway
  // siblings internally as it leaves
  return this._departAndContinue(node, label);
};

// **Unified advance off an event/boundary.** Depart the token onto its (single) outflow, run an
// optional `afterDepart` hook **while it's already off the node** (re-arm a boundary, or cancel the
// interrupted scope — so the departed token survives and doesn't read as an armed waiter), then
// continue from the far node. With no outflow, the token consumes (flip-fade).
Simulator.prototype._departAndContinue = async function(node, label, afterDepart) {
  const out = this._outgoing(this._requireElement(node))[0];
  if (!out) {
    if (afterDepart) {
      afterDepart();
    }
    return this._consume(node, label);
  }
  // `afterDepart` (e.g. re-arm a boundary waiter) runs as the token leaves the node, via advanceToken's
  // `onDeparted` hook — fired right after the source node re-renders, so the token is already off the
  // start and the new waiter isn't wiped by the source re-render.
  const landed = await this._animation.advanceToken({ node, label, sequenceFlow: out.id, onDeparted: afterDepart });
  return this.advanceToEntry({ node: landed.node, label: landed.label });
};

// Fire a join (parallel or OR): collapse the branches that have arrived at the gateway into one
// continuation (≤1 per inflow), then depart. Caller decides *when* it's allowed to fire.
Simulator.prototype._fireOrJoin = async function(node, label) {
  await this._animation.joinTokens({ node, label }); // collapse arrived branches → center
  return this.advanceToDeparted({ node, label });
};

// The branches of instance `label` currently resting on the gateway's **incoming** flows.
Simulator.prototype._arrivedBranches = function(node, label) {
  const element = this._elementRegistry.get(node);
  const incoming = new Set(this._incoming(element).map(f => f.id));
  return this._animation.getTokens(node, label)
    .filter(t => t.state.sequenceFlow && incoming.has(t.state.sequenceFlow));
};

// --- inclusive / complex (OR) join — non-local BPMN merge semantics ----------

// Is the OR-join `element` ready to fire for instance `label`? It fires iff at least one branch has
// arrived AND, for every still-**empty** incoming flow, **no other live token of the instance can
// still reach it** (without crossing the gateway). The reachability is the non-local part — we look
// at the whole instance's marking, not just the gateway's inflows. Ported from bpmn-js-token-
// simulation's InclusiveGatewayBehavior, adapted to our token model: live tokens are the arrived
// branches' siblings in the instance tree (`getParent`/`getChildren`); reachability walks the static
// flow graph backwards (`_canReach`). The "…but cannot reach an occupied inflow" refinement keeps
// loops from deadlocking (a token that could also feed an already-arrived inflow is treated as
// accounted for, so the join fires rather than waiting forever).
Simulator.prototype._orJoinReady = function(element, label) {
  const incoming = (element.incoming || []).filter(f => is(f, 'bpmn:SequenceFlow'));
  const arrived = this._arrivedBranches(element.id, label);
  if (!arrived.length) {
    return false; // nothing has arrived — not a waiting join
  }

  const occupied = new Set(arrived.map(t => t.state.sequenceFlow));
  const emptyFlows = incoming.filter(f => !occupied.has(f.id));
  if (!emptyFlows.length) {
    return true; // every inflow occupied → fire (also the parallel-join case)
  }

  // other live tokens of this instance, in the same scope (the arrived branches' siblings)
  const scopeToken = this._animation.getParent(arrived[0]);
  const siblings = scopeToken ? this._animation.getChildren(scopeToken) : [];
  const others = siblings.filter(t => !arrived.includes(t));
  const occupiedFlows = incoming.filter(f => occupied.has(f.id));

  // a live token blocks the join if it can still reach an EMPTY inflow but not an already-OCCUPIED one
  const blocked = others.some(token => {
    const at = this._elementRegistry.get(token.node);
    if (!at) {
      return false;
    }
    const reachesEmpty = emptyFlows.some(f => this._canReach(at, f, element));
    if (!reachesEmpty) {
      return false;
    }
    const reachesOccupied = occupiedFlows.some(f => this._canReach(at, f, element));
    return !reachesOccupied;
  });
  return !blocked;
};

// Can `target` (where a live token sits) reach `current` going **forward** — i.e. is `target` in the
// backward cone of `current` over the static flow graph, **without crossing** `gateway` (the join)?
// Walks predecessors (a flow → its source; a node → its incoming flows; a link catch → its matching
// throws), with a cycle guard. Pure graph read — no token state.
Simulator.prototype._canReach = function(target, current, gateway, traversed) {
  traversed = traversed || new Set();

  if (current === gateway) {
    return false; // never route through the join itself
  }
  if (traversed.has(current)) {
    return false; // cycle
  }
  traversed.add(current);

  if (current === target) {
    return true;
  }

  if (is(current, 'bpmn:SequenceFlow')) {
    return current.source ? this._canReach(target, current.source, gateway, traversed) : false;
  }

  const cc = classify(current);
  if (cc.event === 'catch' && cc.link !== undefined) {
    return this._linkThrowsFor(current).some(t => this._canReach(target, t, gateway, traversed));
  }

  const incoming = (current.incoming || []).filter(f => is(f, 'bpmn:SequenceFlow'));
  return incoming.some(f => this._canReach(target, f, gateway, traversed));
};

// The link **throw** events feeding a given link **catch** (its graph predecessors — a link is a
// no-flow jump). The mirror of `_matchingLinkCatches`.
Simulator.prototype._linkThrowsFor = function(catchEl) {
  const link = classify(catchEl).link;
  if (link === undefined) {
    return [];
  }
  return this._elementRegistry.filter(el => {
    if (el.labelTarget || el.type === 'label') {
      return false;
    }
    const c = classify(el);
    return c.event === 'throw' && c.link === link;
  });
};

// Every inclusive/complex gateway with a branch of `label` currently waiting on one of its inflows.
Simulator.prototype._waitingOrJoins = function(label) {
  return this._elementRegistry.filter(el => {
    if (el.labelTarget || el.type === 'label') {
      return false;
    }
    const c = classify(el);
    if (c.gateway !== 'inclusive' && c.gateway !== 'complex') {
      return false;
    }
    if ((el.incoming || []).filter(f => is(f, 'bpmn:SequenceFlow')).length < 2) {
      return false;
    }
    return this._arrivedBranches(el.id, label).length > 0;
  });
};

// Re-evaluate every waiting OR-join of `label` and fire any that have become ready. Called after the
// **shrink events** that can ready a join without a fresh arrival: a token removal (`_consume`) or a
// divergence that prunes a path (`_forkAlong`). Re-entrancy-guarded (a fired join's own depart/consume
// would re-enter); `joinTokens`' model update is synchronous, so a fired join leaves the waiting set at
// once and is never double-fired.
Simulator.prototype._recheckJoins = function(label) {
  if (this._recheckingJoins) {
    return;
  }
  this._recheckingJoins = true;
  try {
    for (const element of this._waitingOrJoins(label)) {
      if (this._orJoinReady(element, label)) {
        this._run(this._fireOrJoin(element.id, label));
      }
    }
  } finally {
    this._recheckingJoins = false;
  }
};

// Consume a token. The **model** drops synchronously inside `consumeToken` (its whole subtree
// flip-fades out together on detached ghosts — the standard exit). If this was the instance's **last**
// token, the process box finishes too: a self-contained background chain glides it to `completion` and
// then consumes it. Nothing here is awaited — the fades are cosmetic and play independently (the model
// is already consistent), so callers never block on one.
Simulator.prototype._consume = function(node, label, selector) {
  // leaving a collapsed sub-process (interrupted by a boundary / event-sub, or departing) → drill back
  // out if we're inside it — one place, for every reason it's consumed
  const c = classify(this._requireElement(node));
  if (c.subProcess && c.collapsed) {
    this._drillOut(node, c);
  }

  // Does consuming this token finish its enclosing **scope**? (a sub-process token OR the process-root
  // box token — `_completedScope` finds it via `getParent`, so it works for any label: an instance, an
  // MI sub, an event-sub firing). Computed **before** the consume, while the token is still its child.
  const scope = this._completedScope(node, label);

  // model drops now (synchronously); the flip-fade ghost plays independently. Returns a Promise that
  // resolves when the consume (incl. the fade) is done — the interactive path fire-and-forgets it at
  // the top (`_run(_step)`), so nothing the user sees blocks; awaiting callers (tests) get determinism.
  const tokenDone = this._animation.consumeToken({ node, label, sequenceFlow: selector && selector.sequenceFlow });

  // a removal is an OR-join **shrink event**: a branch that was blocking a waiting merge (it could
  // reach an empty inflow) may be gone now — re-check, so the join fires the moment it's unblocked
  // (e.g. an interrupting boundary cancels a branch still upstream of the join). Model already dropped.
  this._recheckJoins(label);

  if (!scope) {
    return tokenDone;
  }

  // the scope's body just finished. Its untriggered event-sub waiters are dependents of the scope token,
  // garbage-collected when it closes: the cascade of the process box's consume below (or, for a sub-
  // process, the shed when it departs) flip-fades them. Nothing to consume explicitly here.

  if (is(this._requireElement(scope.node), 'bpmn:SubProcess')) {
    // a sub-process glides to completion/bounce and awaits a double-click to depart (like a task)
    return tokenDone.then(() => this._onSubProcessComplete({ node: scope.node, label: scope.label }));
  }

  // the process root → finish the instance: glide the box to completion, then consume it. Sequenced
  // after the leaf so the box's stack-drop is owned by its own (faded) consume, not the leaf's (which
  // would otherwise drop the stack mid-fade — the box appearing to `moveToBack` after flip, before fade).
  this._instances.delete(scope.label);
  return tokenDone
    .then(() => this._animation.advanceToken({ node: scope.node, label: scope.label, position: Position.COMPLETION, animate: null }))
    .then(() => this._animation.consumeToken({ node: scope.node, label: scope.label }));
};

// Terminate a process instance (a terminate end event was reached): flip-fade **every** token of the
// instance at once, then remove them all. Consuming the root cascades its whole subtree (one
// synchronous teardown), so the token that reached the terminate event dies along with all siblings.
Simulator.prototype._terminate = function(label) {
  const inst = this._instances.get(label);
  if (!inst) {
    return;
  }
  this._instances.delete(label);
  this._run(this._animation.consumeToken({ node: inst.processId, label }));
};


// Double-click dispatch: advance the token to its next phase, given its current one.
Simulator.prototype._step = async function(node, label, sequenceFlow) {
  const element = this._elementRegistry.get(node);
  if (!element) {
    return;
  }

  const entry = this._animation.getEntry(node, label, sequenceFlow);
  if (!entry) {
    return;
  }

  const c = classify(element);
  const phase = this._phaseOf(entry);

  // events & gateways: a single center point → the next double-click departs
  if (c.profile === 'event' || c.profile === 'gateway') {
    if (phase === 'entry') {
      // an armed event-sub start event → fire it (run the firing, re-arm or interrupt)
      if (c.event === 'start') {
        return this._fireEventSub(node, label, element);
      }
      return this.advanceToDeparted({ node, label });
    }
    // inclusive/complex **converging** OR-join. It normally fires **automatically** the moment no
    // other branch can still arrive (`_orJoinReady`, re-checked as state changes); a double-click on a
    // waiting branch is a manual nudge — it fires the join iff it's ready, otherwise keeps waiting (it
    // never forces an early merge).
    if (phase === 'arrived' && (c.gateway === 'inclusive' || c.gateway === 'complex')
        && this._incoming(element).length >= 2) {
      if (this._orJoinReady(element, label)) {
        return this._fireOrJoin(node, label);
      }
      return this._noop(node, label); // the OR-join isn't ready — still waiting on a branch
    }
    return this._noop(node, label); // a center event/gateway not at entry → nothing to advance
  }

  // activities / containers: entry → busy → completion → departed
  if (c.profile === 'activity') {
    // a top-level **process** is fully automatic — `busy` on spawn, `completion` once every child
    // is consumed (`_checkCompletion`) — so it is never advanced by a double-click.
    if (c.process) {
      return this._noop(node, label);
    }
    // a multi-instance activity has its own gesture: the outer parent (on the inflow) spawns subs,
    // each sub runs its own entry → busy → completion → consume, last consume departs the parent.
    if (c.multiInstance) {
      return this._miStep(node, label, phase, element);
    }
    if (phase === 'entry') {
      // a **send** task flings its message icon out as it reaches busy — `advanceToken` does it there
      return this.advanceToBusy({ node, label }); // task & sub-process both step here
    }
    if (phase === 'busy') {
      // a **sub-process** completes busy → completion only when its children are all consumed,
      // not by a click — but a task/call-activity DOES step here.
      if (c.subProcess) {
        return this._noop(node, label);
      }
      // a **receive** task waits for its message: `advanceToken` to completion flies the catch icon in
      // and only completes once it has landed
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
// it (the loop is done); with **none** selected, **re-enter** to run another iteration.
Simulator.prototype._loopStep = function(node, label, element) {
  const fb = this._chosen.get(node);
  this._clearFallback(element);

  if (fb && fb.flows.size > 0) {
    // the loop is done: travel the selected outflow. The activity's untriggered boundary listeners are
    // dependents, shed automatically by the travel's `_shedChildren` (flip-fade), so nothing to do here.
    const flowId = [ ...fb.flows ][0]; // a loop activity has one outflow — depart along the selected one
    return this._travel(node, label, flowId);
  }

  // re-enter: a standard loop is **one** activity execution, so its boundary events monitor every
  // iteration — keep the armed listeners (don't shed them) and glide back to the ready/entry position
  return this.advanceToEntry({ node, label });
};

// A double-click on a multi-instance activity, dispatched by what was clicked:
//  - the **outer parent** (pulse-pausing on the incoming flow → phase `arrived`) **spawns** a sub-instance;
//  - a **sub-instance** (anchored) runs its own lifecycle — entry → busy → completion — and at completion
//    is **consumed**; the last consume releases the parent onto the outflow and travels it onward.
Simulator.prototype._miStep = function(node, label, phase, element) {
  if (phase === 'arrived') {
    return this._spawnMISub(node, label);
  }
  if (phase === 'entry') {
    return this.advanceToBusy({ node, label }); // first sub to leave entry parks the parent (spawn window closes)
  }
  if (phase === 'busy') {
    return this.advanceToCompletion({ node, label });
  }
  if (phase === 'completion') {
    return this._consumeMISub(node, label, element);
  }
};

// Spawn a fresh sub-instance of the MI activity from its outer parent token. The sub id is the parent
// label + the next slot (its current child count + 1) — unique because spawning only happens **before**
// the first sub runs (the parent then parks), so subs are only added during the window, never consumed yet.
Simulator.prototype._spawnMISub = function(node, parentLabel) {
  const parent = this._animation.getToken(node, parentLabel);
  const n = parent ? this._animation.getChildren(parent).length : 0;
  const subLabel = parentLabel + '#' + (n + 1); // "<main token>#k"
  this._animation.createToken({ node, label: subLabel, animate: 'bounce' });

  // select the whole MI instance after the spawn: the parent (main) token + every sub-instance
  // token (so each spawn keeps the full set selected, including subs hidden in back stacks)
  const refs = [ { node, label: parentLabel }, { node, label: subLabel } ];
  if (parent) {
    for (const child of this._animation.getChildren(parent)) {
      refs.push({ node: child.node, label: child.label });
    }
  }
  this._selectOnly(refs);
};

// Consume a completed MI sub-instance (flip-fade). consumeToken's fan-in drops its stack key and, when
// it was the **last** sub, un-parks the outer parent onto the outflow — so afterwards we try to travel
// the parent onward (a no-op unless this was the last, since only then is the parent resting there). The
// parent label is the sub id without its trailing `#<n>` slot (the simulator minted it that way).
Simulator.prototype._consumeMISub = async function(node, subLabel, element) {
  const parentLabel = subLabel.slice(0, subLabel.lastIndexOf('#'));
  await this._animation.consumeToken({ node, label: subLabel });
  return this._departMIParent(node, parentLabel, element);
};

// Release the parent token after a sub is consumed:
//  - **with an outflow**: travel it onward, but only once it has been un-parked onto the outflow (the
//    last fan-in); a no-op while it still rests parked on the incoming flow.
//  - **no outflow** (the MI activity is the last node — implicit end — or an ad-hoc child): consume the
//    parent once its **last sub is gone**, which finishes it and lets the enclosing scope complete.
Simulator.prototype._departMIParent = function(node, parentLabel, element) {
  const parent = this._animation.getToken(node, parentLabel);
  if (!parent) {
    return;
  }
  const outFlow = this._outgoing(element)[0];
  if (outFlow) {
    if (parent.state.sequenceFlow === outFlow.id) {
      return this._travel(node, parentLabel, outFlow.id);
    }
    return; // not the last sub yet (still parked on the incoming flow)
  }
  // no outflow: the fan-in un-parks the parent off the inflow (to completion) on the **last** sub. Until
  // then it stays parked on the inflow, so only consume it once it's no longer resting on a flow.
  if (!parent.state.sequenceFlow) {
    return this._consume(node, parentLabel);
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

// Report that an observed double-click produced **no action** (the simulator deliberately ignored it —
// e.g. a non-spawnable start, a process at busy, a gateway still waiting). Fired from the actual control
// flow, so a host (the demo) can log it without guessing. Returns undefined (a tidy no-op `return`).
Simulator.prototype._noop = function(node, label) {
  this._eventBus.fire('simulator.noop', { node, label });
};

// A flow node's **sequence** flows only — never message flows (a node's `outgoing`/`incoming` in
// bpmn-js also lists message flows, which the simulator does **not** traverse; a token only ever
// travels a `bpmn:SequenceFlow`).
Simulator.prototype._outgoing = function(element) {
  return (element.outgoing || []).filter(f => is(f, 'bpmn:SequenceFlow'));
};
Simulator.prototype._incoming = function(element) {
  return (element.incoming || []).filter(f => is(f, 'bpmn:SequenceFlow'));
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
