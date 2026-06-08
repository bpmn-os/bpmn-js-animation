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
 * consume (D3) with process completion; a **terminate** end event (kills the whole instance);
 * **parallel gateways** (diverging forks every outflow, converging joins once all branches arrive);
 * **boundary events** — armed when the activity becomes busy, shed on its normal departure, and on
 * firing flip + depart their outflow, then cancel the host (interrupting) or re-arm (non-interrupting);
 * the exclusive/inclusive/complex **outflow Fallback** (a diverging split dims its outflows and the
 * token waits; the user clicks to pick — single for exclusive, multi for inclusive/complex — then a
 * double-click forks along the picks); an interim inclusive/complex **converging join** (a double-click
 * on an arrived branch joins whatever has arrived); **standard-loop re-entry** (at completion the
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
 * events don't count toward completion, so a scope finishes when its remaining work is done).
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
  this._firingCounter = 0;           // event-sub firing labels (<scope>.e1, .e2, …)
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
  // this is now the instance the user is driving — auto-focus follows it, not the automatic
  // operations of other concurrently-running instances
  this._simulation.setFocusContext(event.stackIndices);
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

  // this new instance is now the one the user is driving — auto-focus follows it, so a rapid burst
  // of spawns (each auto-advancing) doesn't thrash the front; the latest spawn stays shown
  this._simulation.setFocusContext({ [processId]: label });

  // root token at the process box — for a 2nd+ instance this reveals it with a stack arc
  this._simulation.createToken({ node: processId, label });

  // let that reveal finish before the start-event child appears, so the start token doesn't show
  // while the stack is still scrolling the new instance to the front
  await this._simulation.whenFocused();
  this._simulation.createToken({ node: start.id, label });

  // the start event received a token → arm the process's event sub-processes (a waiter at each start)
  this._armEventSubs(processId, label);

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
    if (c.multiInstance) {
      // MI: the outer thread token never enters — it rests on the incoming flow and **pulse-pauses**,
      // a spawn point. Each double-click on it spawns a sub-instance (`_miStep`).
      return this._simulation.setCue(node, label, 'pulse-pause');
    }
    return this._simulation.advanceToken({ node, label, position: Position.ENTRY, animate: 'bounce' });
  }

  if (c.profile === 'event') {
    if (c.event === 'throw') {
      // pass through automatically: center, **throw the icon out** (fire-and-forget — flies while the
      // token departs), then depart
      await this._simulation.advanceToken({ node, label });          // center/none
      this._run(this._eventIcon(node, label, element));              // the icon flies out (no-op if none)
      return this.advanceToDeparted({ node, label });
    }
    if (c.event === 'end') {
      // pass through automatically: center, **throw the end's icon** (an end event is a throw event —
      // error/escalation/terminate fly their symbol from the token; an untyped end has none), then depart.
      // The icon is **fire-and-forget** — it flies out *while* the token flip-fades / the error propagates,
      // so the consume never waits the throw-icon animation out.
      await this._simulation.advanceToken({ node, label });          // center/none
      this._run(this._eventIcon(node, label, element));              // icon flies out (no-op if none)
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
  const element = this._requireElement(node);
  const c = classify(element);
  const animate = (c.process || c.subProcess) ? 'pulse' : 'bounce';
  await this._simulation.advanceToken({ node, label, position: Position.BUSY, animate });
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
  // An activity's untriggered boundary listeners go now: the model drops synchronously (so the travel's
  // W1 shed finds nothing left) while their flip-fade ghosts play independently — not awaited.
  this._run(this._shedBoundaries(node, label));

  const outgoing = element.outgoing || [];

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
    return this._consume(node, label, true);
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
// user has **chosen**, which render at full opacity (black). No colour, no pulse — the dimming is the
// `animation` service's `setFlowDimmed` primitive (opacity on `.djs-visual`, line + arrowhead together).
Simulator.prototype._paintFallback = function(element, fb) {
  for (const flow of (element.outgoing || [])) {
    this._simulation.setFlowDimmed(flow.id, !fb.flows.has(flow.id));
  }
};

// Restore a gateway's outflows to full opacity and forget its choice.
Simulator.prototype._clearFallback = function(element) {
  this._chosen.delete(element.id);
  for (const flow of (element.outgoing || [])) {
    this._simulation.setFlowDimmed(flow.id, false);
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

// --- sub-processes -----------------------------------------------------------

// A (non-event) sub-process became busy → seed its body. **Non-ad-hoc:** find the **unique untyped**
// start event (throw if not exactly one) and create + auto-advance a token there (it runs the body).
// **Ad-hoc:** a ready/`bounce` token at **each activity with no incoming flow** (the user advances each).
Simulator.prototype._enterSubProcess = function(node, label, element, c) {
  const inner = (element.businessObject.flowElements || [])
    .map(fe => this._elementRegistry.get(fe.id)).filter(Boolean);

  if (c.adHoc) {
    const activities = inner.filter(el => is(el, 'bpmn:Activity') && !(el.incoming || []).length);
    for (const a of activities) {
      this._simulation.createToken({ node: a.id, label, animate: 'bounce' });
    }
    return;
  }

  const starts = inner.filter(el => is(el, 'bpmn:StartEvent') && !(el.businessObject.eventDefinitions || []).length);
  if (starts.length !== 1) {
    throw new Error(`subprocess <${node}> needs exactly one untyped start event (found ${starts.length})`);
  }
  this._simulation.createToken({ node: starts[0].id, label });
  this._armEventSubs(node, label); // the inner start received a token → arm this scope's event-subs
  return this.advanceToDeparted({ node: starts[0].id, label }); // auto-run from the start event
};

// Predict whether consuming `(node, label)` empties its enclosing **scope** — the body is finished when
// every other child of the scope token is a **listener** (armed boundary / event-sub waiter). Returns
// the scope **token** (a sub-process token OR the process-root box token — distinguished by its node) so
// one path handles both; null otherwise. Found via `getParent`, so it works whatever the token's label
// (an instance `I1`, an MI sub `I1/2`, an event-sub firing `I1.e1`). Computed **before** the consume.
Simulator.prototype._completedScope = function(node, label) {
  const token = this._simulation.getToken(node, label);
  if (!token || this._isArmedWaiter(token)) {
    return null; // consuming a listener never completes a scope
  }
  const scope = this._simulation.getParent(token);
  if (!scope) {
    return null;
  }
  const active = this._simulation.getChildren(scope).filter(c => c !== token && !this._isArmedWaiter(c));
  return active.length ? null : scope;
};

// A token resting (anchored) on a **listener** — an event-sub start event (armed firing) or a
// **boundary event** (armed boundary). Listeners don't count toward a scope's completion condition;
// they're torn down when the scope finishes (the body is what completes, not the listeners watching it).
Simulator.prototype._isArmedWaiter = function(token) {
  if (token.state.sequenceFlow) {
    return false;
  }
  const el = this._elementRegistry.get(token.node);
  return is(el, 'bpmn:StartEvent') || is(el, 'bpmn:BoundaryEvent');
};

// The sub-process body finished → drill back out (if collapsed) and glide it to `completion/bounce`,
// where it awaits a double-click to depart its outflow (the same gesture as a task). The **listeners**
// (armed boundaries + event-sub waiters) stay armed through completion — they're shed only when the
// sub-process actually **departs** (`advanceToDeparted` → `_shedBoundaries` + the travel's W1 cascade).
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
// by double-clicking. Each is keyed by a fresh firing label (the SimulationAPI stacks concurrent firings).
Simulator.prototype._armEventSubs = function(scopeNode, label) {
  for (const evtsp of this._eventSubsOf(scopeNode)) {
    // an event-sub's start event is **typed** (escalation/error/message/…); that typed start is the
    // armed waiter the host fires — only an *untyped* start auto-fires (the scope/sub-process body)
    const start = this._innerOf(evtsp.id).find(e => is(e, 'bpmn:StartEvent') && this._isTyped(e));
    if (start) {
      this._simulation.createToken({ node: start.id, label: this._firingLabel(label), animate: 'bounce' });
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

  await this._eventIcon(node, label, element); // the start event's catch icon flies in — wait for it
  const firing = this._simulation.getToken(node, label);
  const scope = firing && this._simulation.getParent(firing);
  this._drillInto(evtsp.id, c);

  // same depart-and-continue as a boundary: **interrupting** kills the scope siblings once the firing
  // is off the start (so it survives and the scope doesn't wrongly complete); **non-interrupting** re-arms.
  const afterDepart = c.interrupting
    ? () => this._killScopeSiblings(scope, firing)
    : () => scope && this._simulation.createToken({ node, label: this._firingLabel(scope.label), animate: 'bounce' });
  return this._departAndContinue(node, label, afterDepart);
};

// Interrupting fire: flip-fade every token of the scope **except** the firing that just fired (the
// other event-subs' armed waiters, the normal-flow tokens, any concurrent firings — all gone).
Simulator.prototype._killScopeSiblings = function(scope, firing) {
  if (!scope) {
    return;
  }
  for (const t of this._simulation.getChildren(scope).filter(c => c !== firing)) {
    this._run(this._consume(t.node, t.label, true));
  }
};

// Flip-fade a scope's **armed event-sub waiters** — tokens resting at event-sub start events. They
// deactivate the moment the scope's body finishes (its last active token is consumed): an event-sub can
// no longer fire when there's nothing left to interrupt. (Boundaries, by contrast, survive to departure.)
Simulator.prototype._shedEventSubWaiters = function(scopeToken) {
  if (!scopeToken) {
    return;
  }
  for (const t of this._simulation.getChildren(scopeToken).filter(c => this._isEventSubWaiter(c))) {
    this._run(this._simulation.consumeToken({ node: t.node, label: t.label, gesture: true }));
  }
};

// A token resting (anchored) at a **start event** — an armed event-sub firing (a boundary waiter is not).
Simulator.prototype._isEventSubWaiter = function(token) {
  return !token.state.sequenceFlow && is(this._elementRegistry.get(token.node), 'bpmn:StartEvent');
};

// The event sub-processes directly inside a scope.
Simulator.prototype._eventSubsOf = function(scopeNode) {
  return this._innerOf(scopeNode).filter(el => classify(el).eventSubProcess);
};

// The flow-node shapes directly inside an element (its businessObject's flowElements, resolved to shapes).
Simulator.prototype._innerOf = function(node) {
  const el = this._requireElement(node);
  return (el.businessObject.flowElements || [])
    .map(fe => this._elementRegistry.get(fe.id))
    .filter(Boolean);
};

// A fresh, unique firing label scoped to an instance (`<scopeLabel>.e<n>`).
Simulator.prototype._firingLabel = function(scopeLabel) {
  return scopeLabel + '.e' + (++this._firingCounter);
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
  if (!caught) {
    return this._consume(node, label, true); // uncaught — the throwing path just ends
  }
  // **interrupting** catch (a cancelling boundary, or an interrupting event-sub) cancels its scope —
  // which cascades the throwing token away. A **non-interrupting** catch fires as a side path and
  // leaves the scope running, so the throwing token (its path ended) is consumed separately.
  if (!caught.interrupting) {
    this._run(this._consume(node, label, true));
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
  let scope = this._scopeOf(this._requireElement(node));
  while (scope) {
    // 1. an event-sub inside this scope with a matching armed firing
    for (const evtsp of this._eventSubsOf(scope.id)) {
      const start = this._innerOf(evtsp.id).find(e => is(e, 'bpmn:StartEvent') && this._eventMatches(e, kind, code));
      const firing = start && this._armedFiringAt(scope, start.id, label);
      if (firing) {
        return { kind: 'eventsub', node: start.id, firingLabel: firing.label, interrupting: classify(evtsp).interrupting !== false };
      }
    }
    // 2. a boundary on this scope's activity with a matching armed token
    const boundary = (scope.attachers || []).find(b =>
      this._eventMatches(b, kind, code) && this._simulation.getToken(b.id, label));
    if (boundary) {
      return { kind: 'boundary', node: boundary.id, interrupting: classify(boundary).interrupting };
    }
    scope = this._scopeOf(scope);
  }
  return null;
};

// The armed firing token resting at an event-sub's `startNode` for instance `instanceLabel` — a child
// of the scope's instance token (the process root / sub-process token). Null if not armed.
Simulator.prototype._armedFiringAt = function(scope, startNode, instanceLabel) {
  const scopeToken = this._simulation.getToken(scope.id, instanceLabel);
  return scopeToken && this._simulation.getChildren(scopeToken).find(t => t.node === startNode) || null;
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

  this._cancelEventBasedSiblings(node, label);  // event-based gateway race (BPMN-specific)
  await this._eventIcon(node, label, element);  // the catch icon flies **in** — wait until it arrives

  // **interrupting** boundary → cancel the host as the boundary departs; **non-interrupting** → re-arm a
  // fresh listener; **intermediate catch** → nothing extra. Then the shared depart-and-continue runs.
  const afterDepart =
    c.event === 'boundary' && c.interrupting ? () => this._run(this._consume(c.attachedTo, label, true)) :
    c.event === 'boundary' ? () => this._simulation.createToken({ node, label, animate: 'bounce' }) :
    null;
  return this._departAndContinue(node, label, afterDepart);
};

// **Unified advance off an event/boundary.** Depart the token onto its (single) outflow, run an
// optional `afterDepart` hook **while it's already off the node** (re-arm a boundary, or cancel the
// interrupted scope — so the departed token survives and doesn't read as an armed waiter), then
// continue from the far node. With no outflow, the token consumes (flip-fade).
Simulator.prototype._departAndContinue = async function(node, label, afterDepart) {
  const out = (this._requireElement(node).outgoing || [])[0];
  if (out) {
    this._simulation.departToken(node, label, out.id); // off the node (a boundary detaches here)
  }
  if (afterDepart) {
    afterDepart();
  }
  if (!out) {
    return this._consume(node, label, true);
  }
  const landed = await this._simulation.advanceToken({ node, label, sequenceFlow: out.id });
  return this.advanceToEntry({ node: landed.node, label: landed.label });
};

// Event-based gateway race: if `node` is a catch event fed by an **event-based gateway**, consume
// (flip-fade) **one** waiting token (the head) at each of the gateway's **other** catch events — the
// trigger wins and cancels its losing siblings. One-per-sibling, so a (shouldn't-happen) concurrent
// race isn't over-cancelled. A no-op for any other catch / boundary event (their incoming flow, if any,
// isn't an event-based gateway). The consumes are fire-and-forget (ghosts).
Simulator.prototype._cancelEventBasedSiblings = function(node, label) {
  const element = this._elementRegistry.get(node);
  const inFlow = (element.incoming || [])[0];
  const gateway = inFlow && inFlow.source;

  if (!gateway || classify(gateway).gateway !== 'eventBased') {
    return;
  }

  for (const out of (gateway.outgoing || [])) {
    const sibling = out.target;
    if (sibling && sibling.id !== node && this._simulation.getToken(sibling.id, label)) {
      this._run(this._consume(sibling.id, label, true));
    }
  }
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

// Consume a token (with the flip-fade gesture, when asked). The **model** drops synchronously inside
// `consumeToken` (its whole subtree flip-fades together on detached ghosts — `gesture` true). If this
// was the instance's **last** token, the process box finishes too: a self-contained background chain
// glides it to `completion` and then flip-fade-consumes it. Nothing here is awaited — the gestures are
// cosmetic and play independently (the model is already consistent), so callers never block on a fade.
Simulator.prototype._consume = function(node, label, gesture) {
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
  // resolves when the consume (incl. the gesture) is done — the interactive path fire-and-forgets it at
  // the top (`_run(_step)`), so nothing the user sees blocks; awaiting callers (tests) get determinism.
  const tokenDone = this._simulation.consumeToken({ node, label, gesture });

  if (!scope) {
    return tokenDone;
  }

  // the scope's body just finished → its event-subs deactivate immediately (boundaries survive to depart)
  this._shedEventSubWaiters(scope);

  if (is(this._requireElement(scope.node), 'bpmn:SubProcess')) {
    // a sub-process glides to completion/bounce and awaits a double-click to depart (like a task)
    return tokenDone.then(() => this._onSubProcessComplete({ node: scope.node, label: scope.label }));
  }

  // the process root → finish the instance: glide the box to completion, then consume it. Sequenced
  // after the leaf so the box's stack-drop is owned by its own (faded) consume, not the leaf's (which
  // would otherwise drop the stack mid-fade — the box appearing to `moveToBack` after flip, before fade).
  this._instances.delete(scope.label);
  return tokenDone
    .then(() => this._simulation.advanceToken({ node: scope.node, label: scope.label, position: Position.COMPLETION, animate: null }))
    .then(() => this._simulation.consumeToken({ node: scope.node, label: scope.label, gesture }));
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
  this._run(this._simulation.consumeToken({ node: inst.processId, label, gesture: true }));
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
      // an armed event-sub start event → fire it (run the firing, re-arm or interrupt)
      if (c.event === 'start') {
        return this._fireEventSub(node, label, element);
      }
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
    // a multi-instance activity has its own gesture: the outer parent (on the inflow) spawns subs,
    // each sub runs its own entry → busy → completion → consume, last consume departs the parent.
    if (c.multiInstance) {
      return this._miStep(node, label, phase, element);
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
  this._run(this._shedBoundaries(node, label));

  if (fb && fb.flows.size > 0) {
    const flowId = [ ...fb.flows ][0]; // a loop activity has one outflow — depart along the selected one
    return this._travel(node, label, flowId);
  }

  return this.advanceToEntry({ node, label }); // re-enter: glide back to the ready/entry position
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
  const parent = this._simulation.getToken(node, parentLabel);
  const n = parent ? this._simulation.getChildren(parent).length : 0;
  this._simulation.createToken({ node, label: parentLabel + '/' + (n + 1), animate: 'bounce' });
};

// Consume a completed MI sub-instance (flip-fade). consumeToken's fan-in drops its stack key and, when
// it was the **last** sub, un-parks the outer parent onto the outflow — so afterwards we try to travel
// the parent onward (a no-op unless this was the last, since only then is the parent resting there). The
// parent label is the sub id without its trailing `/<n>` slot (the simulator minted it that way).
Simulator.prototype._consumeMISub = async function(node, subLabel, element) {
  const parentLabel = subLabel.slice(0, subLabel.lastIndexOf('/'));
  await this._simulation.consumeToken({ node, label: subLabel, gesture: true });
  return this._departMIParent(node, parentLabel, element);
};

// Travel the released parent token onward to the far node — but only once it has been un-parked onto the
// MI activity's outflow (the last fan-in). A no-op while it still rests parked on the incoming flow.
Simulator.prototype._departMIParent = function(node, parentLabel, element) {
  const outFlow = (element.outgoing || [])[0];
  if (!outFlow) {
    return;
  }
  const parent = this._simulation.getToken(node, parentLabel);
  if (parent && parent.state.sequenceFlow === outFlow.id) {
    return this._travel(node, parentLabel, outFlow.id);
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
