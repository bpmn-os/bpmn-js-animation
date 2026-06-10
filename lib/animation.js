import { is, isAny } from 'bpmn-js/lib/util/ModelUtil';

import { getDistinctColor } from './color';
import { classify } from './classify';
import { positionFor, Position, SWEEP } from './positions';

// Standard one-shot lifecycle animations, played automatically (when `animationDuration > 0`): a token
// **fades in + flips** as it's created (so it visibly appears, not pops in) and **flips + fades out** as
// it's consumed (on a detached ghost). Unlike `state.animate` (a persistent looping cue), these play
// once at birth/death; for an ad-hoc one-shot at any other moment a host uses `playTokenEffect`.
const ENTRANCE = [ 'fade-in', 'flip' ];
const EXIT = [ 'flip', 'fade-out' ];

/**
 * Animation — the high-level, user-facing surface for driving BPMN token flow.
 *
 * It **composes** the low-level `primitives` service (never extends it) into a small
 * BPMN-shaped vocabulary, and owns the state that lets a host address tokens by readable
 * `(node, label)` names — where **label is the instance id** (e.g. `"Instance_1#1"`):
 *
 *   - `_tokenMap`    : `Map<token, { token, node, label, stackIndices, position, sequenceFlow }>`
 *   - `_childTokens` : `Map<token, token[]>` — one tree per process instance
 *
 * Animation is the sole writer of tokens and resets with the diagram. It is driven by
 * a simulation engine's token log: the host calls these functions as the engine reports
 * movements; the library decides *how* each node type animates, never *when*.
 *
 * Names may overlap the `primitives` service freely — they are independent namespaces.
 *
 * Functions are built one case at a time: each validates the case it handles via its
 * args; other cases are added as separate calls/branches later.
 */
export default function Animation(eventBus, primitives, elementRegistry) {
  this._primitives = primitives;
  this._elementRegistry = elementRegistry;

  this._reset();
  this._autoFocus = false; // a setting (persists across diagram resets)

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this._reset());
}

Animation.$inject = [ 'eventBus', 'primitives', 'elementRegistry' ];

/**
 * Toggle "auto-focus": when on, every call that touches a token reveals that token's
 * instance(s) — bringing them to the front of their stack so the just-touched token is
 * the visible one. Off by default. Global — applies to all functions (each ends with
 * `_touched`).
 */
Animation.prototype.autoFocus = function(on = true) {
  this._autoFocus = !!on;
};

/**
 * Scope auto-focus to a single **instance** — the one the host last interacted with. Pass a
 * `stackIndices` map (or `null` to clear). While set, `_touched` only brings a token to the front of
 * a stacked node when that node is **not** claimed for a *different* instance by the context — so an
 * automatic operation on some other concurrently-running instance won't steal the front (e.g. rapidly
 * spawning process instances that each auto-advance no longer thrash which one is shown). Stacked
 * nodes the context doesn't mention still focus normally.
 *
 * @param {Object<string,(string|number)>|null} stackIndices
 */
Animation.prototype.setFocusContext = function(stackIndices) {
  this._focusContext = stackIndices || null;
};

/**
 * A Promise that resolves once any in-flight auto-focus **reveal arc** has settled. Lets a caller
 * sequence *after* the reveal — e.g. show a child token only once its instance has scrolled to the
 * front. Resolves immediately when nothing is animating.
 */
Animation.prototype.whenFocused = function() {
  return this._focusing;
};

/**
 * Reveal a token's instance(s): bring the token's stacked node(s) — and the stacked ancestors in its
 * scope chain — to the **front** of their stacks, so the token is the visible copy. Returns the
 * {@link whenFocused} Promise (the reveal arc). The public seam the `animator` uses to follow the
 * active instance during replay (the manual counterpart to `autoFocus`, which does this automatically
 * after every touch). No-op when nothing in the token's chain is stacked.
 */
Animation.prototype.focusToken = function(token) {
  return this._bringToFront(token);
};

Animation.prototype._reset = function() {
  this._tokenMap = new Map();    // token -> { token, node, label, stackIndices, position, sequenceFlow }
  this._childTokens = new Map(); // token -> token[]
  this._colorIndex = 0;          // drives getDistinctColor for fresh identities
  this._focusing = Promise.resolve(); // in-flight auto-focus stack arc(s); advances await it
  this._focusContext = null;     // when set, auto-focus only follows this instance (see setFocusContext)
  this._entering = new Map();    // token -> its entrance-gesture Promise (a depart awaits it; see below)
};

// A token's automatic entrance (`createToken`'s fade-in + flip) must finish before the token **departs**, else
// the fade-flip is cut short by the travel and never seen. `_travelFlow` awaits this; resolves
// immediately (and clears) when there's no pending entrance.
Animation.prototype._awaitEntering = function(token) {
  const p = token && this._entering.get(token);
  if (!p) {
    return Promise.resolve();
  }
  this._entering.delete(token);
  return p;
};

// --- creation ----------------------------------------------------------------

/**
 * Create a token. Four cases, by node kind:
 *
 *  - **Process / Participant** — start a new instance: increment the node's instance
 *    stack and create the (root) token at `entry`, with a fresh distinct color.
 *  - **Start event of a Process / SubProcess** (NOT an event sub-process) — create a
 *    **child** of the token residing at the enclosing scope, with the **same label** and
 *    color, at the `center` position. (The flow token that entered the scope.)
 *  - **Boundary event** — create a **child** of the token at the **attached activity**,
 *    cloned from it (same label/color), at `center`. Its lifecycle rides the parent-child
 *    cascade: it's deleted when the activity departs (W1) or is consumed. An interrupting
 *    fire is host-driven — `advanceToken` the boundary token onto its outflow (which
 *    re-parents it to the enclosing scope), then `consumeToken` the activity; it survives.
 *  - **MI activity** — create a **sub-instance** (`label` = the sub's id), a **child** of the
 *    outer thread token resting on the activity's incoming flow, **stacked** at the node and
 *    inheriting its color, at `entry`. Rejected once the first sub starts running (the spawn window
 *    closes). Fan-in is per-sub `consumeToken`; the last one releases the parent onto the outflow.
 *
 * @param {{ node: string, label: string, animate?: string }} args
 *   `node`: process/participant, a start/boundary event, or an MI activity; `label`: the instance id.
 * @return {object} the created token
 */
Animation.prototype.createToken = function(args) {
  const { label, animate } = args;
  const node = this._canonicalId(args.node); // accept a process id (→ its participant shape)
  const element = this._requireElement(node);

  // reject a duplicate of the **anchored** identity; a token already departing on a flow here
  // doesn't block a fresh one (e.g. re-arming a non-interrupting boundary as the old one travels)
  if (this.getEntry(node, label, null)) {
    throw new Error(`createToken: a token <${label}> already exists at <${node}>`);
  }

  let token;
  if (isAny(element, [ 'bpmn:Process', 'bpmn:Participant' ])) {
    token = this._createInstanceToken(node, label, animate);
  } else if (is(element, 'bpmn:StartEvent')) {
    token = this._createStartEventToken(node, label, element, animate);
  } else if (is(element, 'bpmn:BoundaryEvent')) {
    token = this._createBoundaryToken(node, label, element, animate);
  } else if (classify(element).multiInstance) {
    token = this._createMultiInstanceToken(node, label, element, animate);
  } else if (is(element, 'bpmn:Activity')) {
    token = this._createActivityToken(node, label, element, animate);
  } else {
    throw new Error(`createToken: "${node}" is not a process/participant, a start/boundary event, an activity, or an MI activity`);
  }

  // standard **entrance**: the new dot fades in + flips so the token visibly appears. Skipped at
  // `animationDuration: 0` (like the consume ghost). Tracked so the token's first depart blocks on it
  // (`_travelFlow` → `_awaitEntering`), else the travel would cut the fade-flip short.
  if (this._primitives.getAnimationDuration() > 0) {
    this._entering.set(token, this._primitives.playTokenEffects(node, label, ENTRANCE,
      { sequenceFlow: token.state.sequenceFlow || undefined, stackIndices: token.stackIndices }));
  }

  return token;
};

// An activity inside a scope (a sub-process body) — a child of the enclosing-scope token, inheriting
// its color, at the activity's **entry** position. Used to seed an ad-hoc sub-process's no-incoming
// activities (each a ready/bounce token the user then advances).
Animation.prototype._createActivityToken = function(node, label, element, animate) {
  const scope = this._scopeOf(element);
  if (!scope) {
    throw new Error(`createToken: activity "${node}" has no enclosing scope`);
  }
  const parent = this.getEntry(scope.id, label);
  if (!parent) {
    throw new Error(`createToken: no token <${label}> at scope <${scope.id}>`);
  }

  const stackIndices = { ...parent.stackIndices };
  const state = { position: positionFor(Position.ENTRY), animate };
  const token = this._primitives.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.ENTRY);

  return this._touched(token);
};

// Process/Participant: a new instance's root token at `entry`, fresh distinct color.
Animation.prototype._createInstanceToken = function(node, label, animate) {
  // the instance key IS this token's label — append it to the node's stack (base context)
  this._primitives.setStacks(node, [ ...this._primitives.getStacks(node), label ], {});

  const color = this._nextDistinctColor();
  const stackIndices = { [node]: label };
  const state = { position: positionFor(Position.ENTRY), animate };
  const token = this._primitives.createToken(node, label, color, state, stackIndices);

  this._register(node, label, token, stackIndices, null, Position.ENTRY);

  return this._touched(token);
};

// Start event of a Process/SubProcess (not an event sub-process): a child of the scope's
// token, same label/color, at `center`.
Animation.prototype._createStartEventToken = function(node, label, element, animate) {
  const scope = this._scopeOf(element);
  if (!scope) {
    throw new Error(`createToken: start event "${node}" has no enclosing scope`);
  }

  if (classify(scope).eventSubProcess) {
    return this._createEventSubProcessToken(node, label, scope, animate);
  }

  const parent = this.getEntry(scope.id, label);
  if (!parent) {
    throw new Error(`createToken: no token <${label}> at scope <${scope.id}>`);
  }

  const stackIndices = { ...parent.stackIndices };
  const state = { position: positionFor(Position.CENTER), animate };
  const token = this._primitives.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.CENTER);

  return this._touched(token);
};

// Event sub-process start event: a **firing** of the event sub-process (`label` = the firing id).
// Triggered by an event (no incoming flow), so it's created lazily — `setStacks` the event-sub
// node with the firing key and create a **child of the enclosing-scope token** (the on-screen
// instance), stacked + inheriting its color, at `center`. Non-interrupting firings coexist (the
// stack scrolls them); the firing's key is dropped when its last token is consumed (see
// `consumeToken`'s surviving-token check). [Interrupting evtsp — replace the parent scope's other
// tokens — is a follow-up; the fixture is non-interrupting.]
Animation.prototype._createEventSubProcessToken = function(node, label, evtsp, animate) {
  const enclosing = this._scopeOf(evtsp);
  const scopeKey = enclosing && this._primitives.getCurrentStack(enclosing.id);
  const parent = scopeKey != null && this.getEntry(enclosing.id, scopeKey);
  if (!parent) {
    throw new Error(`createToken: no enclosing-scope instance at <${enclosing && enclosing.id}> to fire <${evtsp.id}>`);
  }

  const stackIndices = { ...parent.stackIndices, [evtsp.id]: label };
  this._primitives.setStacks(evtsp.id, [ ...this._primitives.getStacks(evtsp.id), label ]);

  const state = { position: positionFor(Position.CENTER), animate };
  const token = this._primitives.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.CENTER);

  return this._touched(token);
};

// Boundary event: a child of the token at the attached activity, cloned from it (same
// label/color), at the boundary symbol's center. The interrupting/non-interrupting choice is
// the host's (the library exposes `classify(...).interrupting`); both kinds spawn the same way.
Animation.prototype._createBoundaryToken = function(node, label, element, animate) {
  const host = classify(element).attachedTo;
  const parent = host && this.getEntry(host, label);
  if (!parent) {
    throw new Error(`createToken: no token <${label}> at the attached activity <${host}>`);
  }

  const stackIndices = { ...parent.stackIndices };
  const state = { position: positionFor(Position.CENTER), animate };
  const token = this._primitives.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.CENTER);

  return this._touched(token);
};

// MI activity: a sub-instance. The outer thread token rests on the activity's (single) incoming
// flow — never enters; `label` is the sub's own id. Spawn a child of it, **stacked** at the node
// (in the outer-instance context), inheriting its color, at `entry`. The spawn window stays open
// until the first sub starts running (advances past `entry` — `advanceToken` parks the parent);
// spawning after that is rejected.
Animation.prototype._createMultiInstanceToken = function(node, label, element, animate) {
  const inFlow = (element.incoming || [])[0];
  if (!inFlow) {
    throw new Error(`createToken: MI activity <${node}> has no incoming flow`);
  }

  const parent = this._tokenOnFlow(node, inFlow.id);
  if (!parent) {
    throw new Error(`createToken: no token resting on <${node}>'s incoming flow to spawn an instance from`);
  }
  if (parent.token.state.hidden) {
    throw new Error(`createToken: MI activity <${node}> spawn window is closed (an instance already entered)`);
  }

  // the sub carries the outer keys (for the resolution rule) + its own slot; the **stack** is
  // stored in the node's current context (Animation normalizes which ancestors count — a
  // size-1 process collapses to base — so we use the live context rather than build one)
  const stackIndices = { ...parent.stackIndices, [node]: label };
  this._primitives.setStacks(node, [ ...this._primitives.getStacks(node), label ]);

  const state = { position: positionFor(Position.ENTRY), animate };
  const token = this._primitives.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.ENTRY);

  return this._touched(token);
};

/**
 * Advance a token one step forward. The kind of step is named by the args:
 *
 *  - **along a flow** — pass `sequenceFlow`: move the token onto that connected sequence
 *    flow and travel it to the far node, where it comes to rest **on the same flow**; the
 *    host advances it again to settle it into the node. Re-keys to the far node; identity
 *    and any children are carried by the moved token.
 *  - **into a center node** — an event or **any gateway**: anchor the token at the symbol's
 *    **center**, taking it off whatever flow it rests on (the flow→anchor crossing). No
 *    `position` needed. (At a converging gateway this anchors a single arrived branch;
 *    `joinTokens` is the separate operation that collapses several branches into one.)
 *  - **within an activity/container** (process/participant, subprocess, task, call activity)
 *    — pass `position` (a `SWEEP` value: `entry`/`busy`/`completion`): glide
 *    from the token's current position to the target, **through every skipped intermediate**
 *    so the path is shown. Forward-only. `animate` applies at the target.
 *
 * @param {{ node: string, label: string, sequenceFlow?: string, position?: string, animate?: string }} args
 * @return {Promise<object>} resolves with the token once it has come to rest
 */
Animation.prototype.advanceToken = async function(args) {
  const { label, sequenceFlow, position, animate } = args;
  const node = this._canonicalId(args.node); // accept a process id (→ its participant shape)
  const element = this._requireElement(node);

  // if an auto-focus reveal arc is still playing (a just-revealed instance's stack settling),
  // wait it out before moving — so the advance never overlaps the reveal gesture
  await this._focusing;

  // along a flow → travel to the far node (rests on the flow there). `onDeparted` (if given) fires the
  // instant the token has left the source node (after the source re-renders) — used to re-arm a
  // non-interrupting boundary so the new listener appears *after* the node is clear, its entrance intact.
  if (sequenceFlow) {
    return this._travelFlow(node, label, sequenceFlow, element, args.onDeparted);
  }

  // into a center node → anchor at the symbol center
  if (anchorsAtCenter(element)) {
    return this._anchorAtCenter(node, label, animate);
  }

  if (!isAny(element, [ 'bpmn:Activity', 'bpmn:Process', 'bpmn:Participant' ])) {
    throw new Error(`advanceToken: "${node}" is not an activity/container or center node`);
  }
  if (!SWEEP.includes(position)) {
    throw new Error(`advanceToken: unknown position "${position}"`);
  }

  const entry = this.getEntry(node, label);
  if (!entry) {
    throw new Error(`advanceToken: no token <${label}> at <${node}>`);
  }

  const from = SWEEP.indexOf(entry.position);
  const to = SWEEP.indexOf(position);
  // the sweep is forward-only — except a standard-loop activity, which may move **backward** to
  // any earlier state (a loop iteration re-doing part of the lifecycle), gliding straight there.
  const looping = classify(element).loop;
  if (to < from && !looping) {
    throw new Error(`advanceToken: cannot advance backward (${entry.position} → ${position})`);
  }

  // include the current rest flow in the selector — a token that just arrived rests ON its
  // incoming flow, and the first sweep step crosses flow→anchor (it must match that token).
  const selector = { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices };

  // glide through every skipped intermediate in ONE continuous animation (smooth, no
  // stop at each step); the model commits only to the target, which carries the cue.
  const via = [];
  for (let i = from + 1; i < to; i++) {
    via.push(positionFor(SWEEP[i]));
  }
  const token = await this._primitives.glideToState(node, label, { position: positionFor(position), animate }, selector, via);

  entry.position = position;
  entry.sequenceFlow = null;            // anchored at the sweep position now, off any arrival flow
  entry.stackIndices = token.stackIndices;

  // MI: when a sub-instance starts running (leaves `entry`), park the outer thread token — it
  // can no longer spawn instances (the spawn window closes). Idempotent once parked.
  if (position !== Position.ENTRY && entry.stackIndices[node] != null && classify(element).multiInstance) {
    this._parkMIParent(token);
  }

  return this._touched(token);
};

// Park an MI sub's parent (the outer thread token resting on the incoming flow): set its
// `state.hidden` so the dot is CSS-hidden while the instances run. A no-op if already parked.
Animation.prototype._parkMIParent = function(subToken) {
  const parent = this._parentTokenOf(subToken);
  const pe = parent && this._tokenMap.get(parent);
  if (pe && !pe.token.state.hidden) {
    this._primitives.setState(pe.node, pe.label, { hidden: true },
      { sequenceFlow: pe.sequenceFlow || undefined, stackIndices: pe.stackIndices });
  }
};

// Center node (event / pass-through gateway): anchor the token at the symbol's center —
// taking it off whatever flow it rests on. The flow→anchor crossing commits the stack index.
// Anchor the **just-arrived** token (one resting on a flow) — so a 2nd arrival joins the center
// queue rather than re-anchoring the one already there (homogeneous FIFO queue).
Animation.prototype._anchorAtCenter = async function(node, label, animate) {
  const entries = this._entriesAt(node, label);
  const entry = entries.find(e => e.sequenceFlow) || entries[0];
  if (!entry) {
    throw new Error(`advanceToken: no token <${label}> at <${node}>`);
  }

  const selector = { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices };
  const token = await this._primitives.glideToState(
    node, label, { position: positionFor(Position.CENTER), animate }, selector
  );

  entry.position = Position.CENTER;
  entry.sequenceFlow = null;            // anchored now, no longer on a flow
  entry.stackIndices = token.stackIndices;

  return this._touched(token);
};

// Travel a token along `sequenceFlow` to the far node, where it rests on the same flow. The
// token sent is the one **already resting on this flow** (a branch placed by forkToken) or,
// if none, the token resting at the node about to depart onto it — so a gateway holding
// several branches on different outflows travels the right one (addressed by the flow, not
// just `node|label`). Re-keys to the far node; identity + children are carried.
Animation.prototype._travelFlow = async function(node, label, sequenceFlow, element, onDeparted) {
  if (!is(element, 'bpmn:FlowNode')) {
    throw new Error(`advanceToken: "${node}" is not a flow node`);
  }

  const flow = this._elementRegistry.get(sequenceFlow);
  if (!flow || (flow.source !== element && flow.target !== element)) {
    throw new Error(`advanceToken: "${sequenceFlow}" is not connected to "${node}"`);
  }

  // the branch already resting on this flow, else the unique token resting at the node
  const entry = this.getEntry(node, label, sequenceFlow) || this.getEntry(node, label);
  if (!entry) {
    throw new Error(`advanceToken: no token <${label}> at <${node}>`);
  }
  const source = entry.token;
  const stackIndices = entry.stackIndices;

  // let a just-created token's **entrance** gesture finish before it departs — otherwise the fade-flip
  // is cut short by the travel and never seen (resolves immediately when there's no pending entrance).
  await this._awaitEntering(source);

  // move onto the flow (clears any cue). **Skip when the token is already resting on this exact flow**
  // — e.g. a boundary that already departed via `departToken`: the redundant setState would re-render
  // the node and wipe a freshly re-armed listener's entrance gesture (its fade-flip would never show).
  if (entry.sequenceFlow !== sequenceFlow) {
    this._primitives.setState(
      node, label, { sequenceFlow, animate: null },
      { sequenceFlow: entry.sequenceFlow || undefined, stackIndices }
    );
  }

  // --- everything irrelevant goes NOW, at depart — *before* the travel, not after it lands ---

  // a boundary token leaves its host the moment it **departs** — reparent it to the enclosing scope
  // so an interrupting fire can consume the host while this token is in flight without the cascade
  // tearing it down. Idempotent (the simulator detaches it up-front — see `departToken`).
  if (classify(element).event === 'boundary') {
    this._detachBoundaryToken(source, classify(element).attachedTo);
  }

  // W1: a **departing token sheds its children** — an activity's untriggered boundary listeners
  // (etc.) become irrelevant the instant it departs, so they're consumed here, before the travel
  // (a no-op for the common leaf token). The departing token is now childless and ready to travel.
  this._shedChildren(source);

  // travel to the far node — sendToken lands a NEW token object there. Its first act is to drop the
  // source token and **re-render the source node** (synchronously), so fire `onDeparted` right after
  // that call (before awaiting the travel): the node is now clear, and anything it creates there (a
  // re-armed boundary listener) won't be wiped by this re-render — its entrance gesture survives.
  const travelling = this._primitives.sendToken([
    { node, label, sequenceFlow, stackIndices }
  ]);
  if (onDeparted) {
    onDeparted();
  }
  const [ landed ] = await travelling;

  // carry the now-childless token over (inheriting `source`'s tree slot — already the scope for a
  // boundary), drop the source's entry, register the landed token (sibling branches untouched)
  this._replaceToken(source, landed);
  this._tokenMap.delete(source);
  this._register(landed.node, label, landed, landed.stackIndices, null, null, landed.state.sequenceFlow);

  return this._touched(landed);
};

/**
 * Fork a token down an outgoing flow of a (diverging) gateway — call once per chosen outflow.
 * One thread of control splits into concurrent branches, all carrying the **same instance
 * label** (they rejoin at a `mergeTokens`).
 *
 * `forkToken` only **places** a branch *on* the outflow at the gateway (the DEPART) — it does
 * **not** travel, so the token stays put and the remaining outflows can be forked too. Call
 * `advanceToken({ sequenceFlow })` afterwards to travel each branch to its far node (the
 * ARRIVE). The engine never signals what happens to the *original* token at the gateway (on a
 * parallel split it's erased and only the copies depart), so we infer it: the **first** fork
 * **moves the original** onto its flow — it becomes branch 1, with no ghost left at the
 * gateway; every **later** fork **clones** onto its flow, copying `color`/`stackIndices` from
 * a sibling already on an outflow (those are instance-invariant; the label is all the caller
 * gives). "Any branch already on an outflow?" is the stateless "is this the first fork?" test.
 *
 * @param {{ node: string, label: string, sequenceFlow: string }} args
 * @return {Promise<object>} the branch token, resting on the flow at the gateway
 */
Animation.prototype.forkToken = async function(args) {
  const { label, sequenceFlow } = args;
  const node = this._canonicalId(args.node); // accept a process id (→ its participant shape)
  const element = this._requireElement(node);

  if (!is(element, 'bpmn:Gateway')) {
    throw new Error(`forkToken: "${node}" is not a gateway`);
  }
  const outgoing = (element.outgoing || []).map(f => f.id);
  if (!outgoing.includes(sequenceFlow)) {
    throw new Error(`forkToken: "${sequenceFlow}" is not an outgoing flow of "${node}"`);
  }

  // branches of this instance already placed on the gateway's outflows
  const onOutflows = this._entriesAt(node, label).filter(e => outgoing.includes(e.sequenceFlow));

  // FIRST fork: move the original (resting here at center or on its incoming flow) onto this
  // outflow — placed, not travelled, so it stays at the gateway to fork the rest.
  if (onOutflows.length === 0) {
    const entry = this.getEntry(node, label);
    if (!entry) {
      throw new Error(`forkToken: no token <${label}> at <${node}>`);
    }
    const moved = this._primitives.setState(
      node, label, { sequenceFlow, animate: null },
      { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices }
    );
    entry.position = null;
    entry.sequenceFlow = sequenceFlow;
    entry.stackIndices = moved.stackIndices;
    return this._touched(moved);
  }

  // SUBSEQUENT fork: clone the instance onto this outflow (placed, not travelled), copying
  // color/stackIndices from a sibling already on an outflow.
  const sibling = onOutflows[ 0 ].token;
  const clone = this._primitives.createToken(node, label, sibling.color, { sequenceFlow }, sibling.stackIndices);

  // register on its flow (token-keyed, so it coexists with the other branches here) and place
  // it in the instance tree as a sibling of the first branch
  this._register(node, label, clone, clone.stackIndices, null, null, sequenceFlow);
  const siblings = this._parentOf(sibling);
  if (siblings) {
    siblings.push(clone);
  }

  return this._touched(clone);
};

/**
 * Join the branches of an instance at a (converging) gateway into one continuation — the
 * inverse of `forkToken`. Finds the branch tokens of `label` resting on flows at the gateway
 * (they arrived on its incoming flows), removes them, and leaves a single token anchored at
 * the gateway **center**, with the same color/stackIndices. The host then carries it onward
 * with `advanceToken`. (A converging *exclusive* gateway is an uncontrolled merge, not this —
 * there each token just passes through via `advanceToken` center-anchor.)
 *
 * @param {{ node: string, label: string }} args
 * @return {Promise<object>} the merged token, anchored at the gateway center
 */
Animation.prototype.joinTokens = async function(args) {
  const { label } = args;
  const node = this._canonicalId(args.node); // accept a process id (→ its participant shape)
  const element = this._requireElement(node);

  if (!is(element, 'bpmn:Gateway')) {
    throw new Error(`joinTokens: "${node}" is not a gateway`);
  }

  const branches = this._entriesAt(node, label).filter(e => e.sequenceFlow);
  if (branches.length === 0) {
    throw new Error(`joinTokens: no branches of <${label}> at <${node}>`);
  }

  const { color, stackIndices } = branches[ 0 ].token;

  // the branches are siblings in the instance tree; the merged token takes their shared slot
  // and inherits any children they carried
  const siblings = this._parentOf(branches[ 0 ].token);
  const inherited = [];
  for (const b of branches) {
    inherited.push(...this.getChildren(b.token));
  }

  // remove the branch tokens (animation + bookkeeping)
  for (const b of branches) {
    this._primitives.removeToken(node, label, { sequenceFlow: b.sequenceFlow, stackIndices: b.stackIndices });
    this._tokenMap.delete(b.token);
    this._childTokens.delete(b.token);
    if (siblings) {
      const i = siblings.indexOf(b.token);
      if (i !== -1) {
        siblings.splice(i, 1);
      }
    }
  }

  // one continuation token, anchored at the gateway center
  const merged = this._primitives.createToken(node, label, color, { position: positionFor(Position.CENTER) }, stackIndices);
  this._register(node, label, merged, stackIndices, null, Position.CENTER, null);
  this._childTokens.set(merged, inherited);
  if (siblings) {
    siblings.push(merged);
  }

  return this._touched(merged);
};

/**
 * Consume a token and its whole subtree. Removes the `(node, label)` token and **every
 * descendant** in the instance tree (`_childTokens`) — terminating a process instance is
 * `consumeToken` on its root.
 *
 * The **target** must be an *anchored* token: a token resting on a sequence flow (in transit)
 * can't be consumed directly — anchor it first. Descendants, however, **are** removed by the
 * cascade even if they rest on flows (a half-finished branch is torn down with its owner).
 *
 * If the target sits at a **stacked host** (a process/participant root, or a multi-instance
 * activity instance), the host's instance stack is decremented — consuming the last process
 * instance removes its box. (An event sub-process decrements when its *last* token is consumed;
 * that arrives with event-sub support, which has the surviving-token check to detect it.)
 *
 * @param {{ node: string, label: string }} args
 * @return {Promise<object[]>} the removed tokens (the target first, then its descendants)
 */
Animation.prototype.consumeToken = async function(args) {
  const { label, sequenceFlow } = args;
  const node = this._canonicalId(args.node); // accept a process id (→ its participant shape)
  this._requireElement(node); // validate the node exists

  // standard **exit**: each removed dot flips + fades out on a detached ghost (the model drops at once)
  // — the reverse of `createToken`'s fade-in + flip entrance. Skipped at `animationDuration: 0`.
  const effects = this._primitives.getAnimationDuration() > 0 ? EXIT : undefined;

  const entries = this._entriesAt(node, label);
  if (entries.length === 0) {
    throw new Error(`consumeToken: no token <${label}> at <${node}>`);
  }

  // Default: consume the **anchored** token (a token in transit can't be consumed directly). Pass an
  // explicit `sequenceFlow` to target a token **resting on that flow** — e.g. a parked MI outer-thread
  // token when its scope is interrupted (`null`/`''` still means the anchored one).
  let target;
  if (sequenceFlow !== undefined) {
    const want = sequenceFlow || null;
    const entry = entries.find(e => (e.sequenceFlow || null) === want);
    if (!entry) {
      throw new Error(`consumeToken: no token <${label}> at <${node}>${want ? ` on flow <${want}>` : ''}`);
    }
    target = entry.token;
  } else {
    const anchored = entries.find(e => !e.sequenceFlow);
    if (!anchored) {
      throw new Error(`consumeToken: <${label}> at <${node}> rests on a sequence flow and cannot be consumed directly`);
    }
    target = anchored.token;
  }
  const parentToken = this._parentTokenOf(target); // captured before teardown (for MI fan-in)

  // remove the target and its whole subtree (descendants on flows included) — the model drops
  // synchronously here; the flip-fade ghosts (when `effects`) play on detached clones afterwards
  const { subtree, fades } = this._tearDown(target, effects);

  // a stacked container (an instance stack / implicit-process box) must not collapse out from under
  // a still-fading dot — wait the flip-fade out before the stack-decrement below removes the slot
  // (the **box / `moveToBack` arc / MI release** all run after the gesture). The model is already
  // gone, so this delays only the visual teardown, never the token's addressability.
  await Promise.all(fades);

  // stack-decrement (the **surviving-token** check): for every stacked node the target belonged
  // to — its own node OR a stacked **ancestor** (an MI activity, an event sub-process) — drop that
  // instance/firing key once **no surviving token still carries it**. One rule for process roots
  // (terminate → drop the instance), MI subs (fan-in), and event-sub firings (last token ends the
  // firing). Run after teardown so survivors exclude the torn-down subtree.
  for (const [ stackedNode, key ] of Object.entries(target.stackIndices || {})) {
    const el = this._elementRegistry.get(stackedNode);
    if (!el) {
      continue;
    }
    const keys = this._primitives.getStacks(stackedNode); // in its current context
    if (!keys.includes(key)) {
      continue;
    }
    const survives = Array.from(this._tokenMap.values()).some(e => (e.stackIndices || {})[stackedNode] === key);
    if (survives) {
      continue;
    }
    // animate the removed instance scrolling to the **back** of the stack, then drop it (instant
    // for a single instance — no copies to scroll; instant too when animation is off)
    await this._primitives.moveToBack(stackedNode, key);
    this._primitives.setStacks(stackedNode, this._primitives.getStacks(stackedNode).filter(k => k !== key));

    // MI fan-in: when the **last** sub of an MI activity is consumed, un-park the outer thread
    // token onto the outgoing flow so the host can travel it onward.
    if (keys.length === 1 && classify(el).multiInstance) {
      this._unparkMIParent(stackedNode, el, parentToken);
    }
  }

  return subtree;
};

// MI fan-in: release the parked outer thread token onto the activity's (single) outgoing flow.
// The token first moves there **while still hidden** — a hidden token doesn't glide, so it
// repositions from the incoming flow to the outgoing flow **invisibly** — and is only *then*
// unhidden, so it appears already on the outflow (no visible glide across the node). The host
// then `advanceToken`s it onward.
Animation.prototype._unparkMIParent = function(node, element, parentToken) {
  const pe = parentToken && this._tokenMap.get(parentToken);
  if (!pe) {
    return;
  }
  const outFlow = (element.outgoing || [])[0];
  if (!outFlow) {
    throw new Error(`consumeToken: MI activity <${node}> has no outgoing flow to release the token onto`);
  }

  // 1. move onto the outgoing flow while still hidden (invisible — no glide for a hidden dot)
  this._primitives.setState(pe.node, pe.label, { sequenceFlow: outFlow.id },
    { sequenceFlow: pe.sequenceFlow || undefined, stackIndices: pe.stackIndices });
  pe.sequenceFlow = outFlow.id;
  pe.position = null;

  // 2. now reveal it — at the outflow
  this._primitives.setState(pe.node, pe.label, { hidden: false },
    { sequenceFlow: outFlow.id, stackIndices: pe.stackIndices });
};

// --- lookup / reset ----------------------------------------------------------

/**
 * The bookkeeping entry for a token at `(node, label)`. Several entries can match — branches on
 * different flows (a gateway split; pass `sequenceFlow` to pick one) or a **homogeneous queue** at
 * one identity (concurrent same-instance arrivals). Without a `sequenceFlow`, returns the **head**
 * (first-arrived) — operations act on it and advance FIFO. Internal record — prefer `getToken`/`getTokens`.
 */
Animation.prototype.getEntry = function(node, label, sequenceFlow) {
  const entries = this._entriesAt(node, label);
  if (sequenceFlow !== undefined) {
    const want = sequenceFlow || null;
    return entries.find(e => e.sequenceFlow === want);
  }
  return entries[ 0 ];
};

/** The token at `(node, label)` — optionally the branch on `sequenceFlow` — or `undefined`. */
Animation.prototype.getToken = function(node, label, sequenceFlow) {
  const entry = this.getEntry(node, label, sequenceFlow);
  return entry && entry.token;
};

/** Every token of instance `label` currently at `node` (0, 1, or several branches). */
Animation.prototype.getTokens = function(node, label) {
  return this._entriesAt(node, label).map(e => e.token);
};

/** The child tokens of `token` (one tree per process instance). */
Animation.prototype.getChildren = function(token) {
  return this._childTokens.get(token) || [];
};

/** The parent token of `token` (its enclosing scope: a sub-process / process-root token), or null. */
Animation.prototype.getParent = function(token) {
  return this._parentTokenOf(token);
};

/**
 * Set a token's motion cue (`state.animate`) **without moving it** — to signal a wait state
 * (e.g. `pulse-pause` while the user picks an outflow, `bounce-pause` for an MI parent idling
 * on its flow). `animate` is an effect name or `null` to clear. The `selector` disambiguates
 * a branch (`sequenceFlow`) / instance (`stackIndices`); omit to use the single token there.
 */
Animation.prototype.setCue = function(node, label, animate, selector) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const entry = this.getEntry(node, label, selector && selector.sequenceFlow);
  if (!entry) {
    throw new Error(`setCue: no token <${label}> at <${node}>`);
  }
  return this._primitives.setState(node, label, { animate },
    { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices });
};

/**
 * Dim / undim a **sequence flow** (semi-transparent line + arrowhead) — pass-through to the `animation`
 * service. The interactive simulator uses this to fade a diverging gateway's unchosen outflows while
 * the user picks. Reverts cleanly; `clear` undims any left dimmed.
 *
 * @param {string} flowId
 * @param {boolean} [on=true]
 */
Animation.prototype.setFlowDimmed = function(flowId, on = true) {
  this._primitives.setFlowDimmed(flowId, on);
};

/**
 * Dim / undim a **node** (semi-transparent shape) — pass-through to the `primitives` service. The
 * simulator uses this to fade candidate **link catch** events while the user picks an ambiguous link
 * throw's jump target. Reverts cleanly; `clear` undims any left dimmed.
 *
 * @param {string} nodeId
 * @param {boolean} [on=true]
 */
Animation.prototype.setNodeDimmed = function(nodeId, on = true) {
  this._primitives.setNodeDimmed(nodeId, on);
};

/**
 * Bring a stacked node's instance (keyed, as everywhere in this API, by its **label**) to the
 * **front** — the on-screen one. Pass-through to the `primitives` service. A host driving several
 * instances of one process/pool/MI activity programmatically uses this to choose which instance is
 * shown *before* an operation that resolves against the front (spawning an MI sub-instance, firing an
 * event sub-process). The animated scroll arc resolves the returned Promise; the front updates
 * synchronously. No-op when the node isn't stacked or `label` is already front.
 *
 * @param {string} node
 * @param {string} label the instance's label
 * @return {Promise<void>}
 */
Animation.prototype.moveToFront = function(node, label) {
  return this._primitives.moveToFront(this._canonicalId(node), label);
};

/**
 * Send a stacked node's instance (keyed by **label**) to the **back** — pass-through to the
 * `primitives` service. Animates only when the shown (front) instance changes.
 *
 * @param {string} node
 * @param {string} label the instance's label
 * @return {Promise<void>}
 */
Animation.prototype.moveToBack = function(node, label) {
  return this._primitives.moveToBack(this._canonicalId(node), label);
};

/**
 * Scroll a stacked node to the next (`'forward'`) / previous (`'backward'`) instance — thin sugar
 * over `moveToFront`/`moveToBack`, pass-through to the `primitives` service.
 *
 * @param {string} node
 * @param {'forward'|'backward'} [direction='forward']
 * @return {Promise<void>}
 */
Animation.prototype.scrollStack = function(node, direction = 'forward') {
  return this._primitives.scrollStack(this._canonicalId(node), direction);
};

/**
 * **Jump** a token to another node, preserving its identity and tree position (a **link event**:
 * the token leaves its throw and reappears at the matching catch, centered). The bookkeeping entry
 * is re-pointed at `toNode`; the same Token object carries its color / instance / children across.
 *
 * @param {string} fromNode
 * @param {string} label
 * @param {string} toNode
 * @return {object} the moved token, centered at `toNode`
 */
Animation.prototype.jumpToken = function(fromNode, label, toNode) {
  fromNode = this._canonicalId(fromNode); // accept process ids (→ their participant shapes)
  toNode = this._canonicalId(toNode);
  const entry = this.getEntry(fromNode, label);
  if (!entry) {
    throw new Error(`jumpToken: no token <${label}> at <${fromNode}>`);
  }
  this._requireElement(toNode);

  const token = this._primitives.moveToken(fromNode, label, toNode,
    { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices },
    { position: positionFor(Position.CENTER), sequenceFlow: null, animate: null });

  entry.node = toNode;
  entry.position = Position.CENTER;
  entry.sequenceFlow = null;
  return this._touched(token);
};

/**
 * Move a token onto an outgoing flow (the **depart**) **without travelling** — the dot comes to rest
 * at the flow's near end. A **boundary** token also detaches from its host here, reparenting to the
 * enclosing scope, so it survives a concurrent host consume. Pair with `advanceToken({ sequenceFlow })`
 * to then travel it — letting the caller act in between (consume the host, re-arm the listener) while
 * the token is already on the flow (and no longer the anchored token at the node).
 *
 * @return {object} the departed token
 */
Animation.prototype.departToken = function(node, label, sequenceFlow) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const element = this._requireElement(node);
  const entry = this.getEntry(node, label);
  if (!entry) {
    throw new Error(`departToken: no token <${label}> at <${node}>`);
  }

  if (classify(element).event === 'boundary') {
    this._detachBoundaryToken(entry.token, classify(element).attachedTo);
  }

  this._primitives.setState(node, label, { sequenceFlow, animate: null },
    { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices });
  entry.sequenceFlow = sequenceFlow;
  entry.position = null;

  return entry.token;
};

/**
 * Play a **one-shot** dot gesture on a resting token (delegates to the `primitives` service) —
 * e.g. a flip when an event triggers, or a fade-out sequenced before `consumeToken`. `→ Promise`.
 */
Animation.prototype.playTokenEffect = function(node, label, effect, selector) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const sel = this._resolveSelector(node, label, selector);
  return sel ? this._primitives.playTokenEffect(node, label, effect, sel) : Promise.resolve();
};

/** Play a one-shot dot gesture on a **specific token object** (addressed directly, not by name) —
 * for gesturing a whole subtree at once. `→ Promise`; no-op if the token is gone. */
Animation.prototype.playTokenEffectOn = function(token, effect) {
  const entry = this._tokenMap.get(token);
  return entry
    ? this._primitives.playTokenEffect(entry.node, entry.label, effect,
      { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices })
    : Promise.resolve();
};

/**
 * Emit the node's own icon **from** the token (a throw event / send task passing through) — the icon
 * flies out from the token's dot and fades. `→ Promise`; no-op if no token rests there. */
Animation.prototype.throwIcon = function(node, label, selector) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const sel = this._resolveSelector(node, label, selector);
  return sel ? this._primitives.throwIcon(node, label, sel) : Promise.resolve();
};

/**
 * Receive the node's own icon **into** the token (a catch event being triggered) — the icon flies
 * in and lands on the token's dot. `→ Promise`; no-op if no token rests there. */
Animation.prototype.catchIcon = function(node, label, selector) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const sel = this._resolveSelector(node, label, selector);
  return sel ? this._primitives.catchIcon(node, label, sel) : Promise.resolve();
};

// Resolve `(node, label[, selector])` to the low-level selector (rest flow + instance stackIndices)
// the `primitives` service keys by — so callers address tokens by readable names. `null` if absent.
Animation.prototype._resolveSelector = function(node, label, selector) {
  const entry = this.getEntry(node, label, selector && selector.sequenceFlow);
  return entry && { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices };
};

/** Reset all simulation state and clear the underlying animation. */
Animation.prototype.clear = function() {
  this._reset();
  this._primitives.clear();
};

// --- internals ---------------------------------------------------------------

// Every function ends here: the shared post-touch hook. Honors the auto-focus toggle.
Animation.prototype._touched = function(token) {
  if (this._autoFocus) {
    this._bringToFront(token);
  }
  return token;
};

// Bring the token's instance(s) to the front of their stack(s), so it becomes visible.
// (Single-node for now; nested instances would want outer-first ordering.) The reveal plays a
// stack **arc** (a fixed 600ms gesture); accumulate the in-flight arcs in `_focusing` — chaining,
// so a no-op reveal can't clobber a live arc — so a following move can wait the reveal out.
Animation.prototype._bringToFront = function(token) {
  const indices = token.stackIndices || {};
  const focus = this._focusContext;
  for (const node of Object.keys(indices)) {
    // when a focus instance is set, don't steal the front for a stacked node it has claimed for a
    // *different* instance — only the last-interacted instance keeps it (nodes it doesn't claim still focus)
    if (focus && node in focus && focus[node] !== indices[node]) {
      continue;
    }
    const arc = this._primitives.moveToFront(node, indices[node]);
    this._focusing = Promise.all([ this._focusing, arc ]).then(() => {}, () => {});
  }
  return this._focusing;
};

// A move replaces a token object with a new one (sendToken lands a fresh token). Carry the
// hierarchy over: `newToken` inherits `oldToken`'s children and takes its slot under its
// parent, so the per-instance tree stays intact across the move.
Animation.prototype._replaceToken = function(oldToken, newToken) {
  this._childTokens.set(newToken, this._childTokens.get(oldToken) || []);
  this._childTokens.delete(oldToken);

  for (const children of this._childTokens.values()) {
    const i = children.indexOf(oldToken);
    if (i !== -1) {
      children[i] = newToken;
    }
  }
};

// The child-array that lists `token` (i.e. its parent's children), or null if it's a root.
Animation.prototype._parentOf = function(token) {
  for (const children of this._childTokens.values()) {
    if (children.includes(token)) {
      return children;
    }
  }
  return null;
};

// The parent **token** of `token` (the token whose children include it), or null if it's a root.
Animation.prototype._parentTokenOf = function(token) {
  for (const [ parent, children ] of this._childTokens) {
    if (children.includes(token)) {
      return parent;
    }
  }
  return null;
};

// Reparent a boundary `token` from its host activity to the enclosing scope (the host's parent),
// **only if** it's still attached to that host (`attachedTo`) — idempotent, so calling it twice
// (the simulator up-front + `_travelFlow` on depart) reparents once.
Animation.prototype._detachBoundaryToken = function(token, attachedTo) {
  const parent = this._parentTokenOf(token);
  const parentEntry = parent && this._tokenMap.get(parent);
  if (parentEntry && parentEntry.node === attachedTo) {
    this._reparent(token, this._parentTokenOf(parent));
  }
};

// Move `token` under `newParent` (a token, or null to make it a root): unlink it from its
// current parent's child list and append it to the new one.
Animation.prototype._reparent = function(token, newParent) {
  const siblings = this._parentOf(token);
  if (siblings) {
    const i = siblings.indexOf(token);
    if (i !== -1) {
      siblings.splice(i, 1);
    }
  }
  if (newParent) {
    this.getChildren(newParent).push(token);
  }
};

// Remove `token` and its whole subtree from the animation + bookkeeping, detaching it from its
// parent. Returns the removed tokens (target first). Shared by consumeToken + _shedChildren.
Animation.prototype._tearDown = function(token, effects) {
  const subtree = [];
  const collect = t => {
    subtree.push(t);
    for (const child of this.getChildren(t)) {
      collect(child);
    }
  };
  collect(token);

  // detach from the parent's child list
  const siblings = this._parentOf(token);
  if (siblings) {
    const i = siblings.indexOf(token);
    if (i !== -1) {
      siblings.splice(i, 1);
    }
  }

  // remove every token in the subtree (animation + bookkeeping); each entry carries its own
  // node/label/flow (a descendant may sit elsewhere, even under a different label for MI). With
  // `effects`, each dot flip-fades on its own ghost — the whole subtree gestures **simultaneously**
  // (one synchronous loop), while the model identities all drop now. Collect the fade promises so a
  // caller can wait the gesture out before collapsing a container (process box / stack).
  const fades = [];
  for (const t of subtree) {
    const e = this._tokenMap.get(t);
    if (e) {
      fades.push(this._primitives.removeToken(e.node, e.label, { sequenceFlow: e.sequenceFlow || undefined, stackIndices: e.stackIndices }, effects));
      this._tokenMap.delete(t);
    }
    this._childTokens.delete(t);
  }

  return { subtree, fades };
};

// A departing token sheds its children — boundary listeners (etc.) belong to it at rest and
// don't travel (invariant W1). Tear down each child subtree (a no-op for a leaf token).
Animation.prototype._shedChildren = function(token) {
  for (const child of this.getChildren(token).slice()) {
    this._tearDown(child);
  }
};

// All bookkeeping entries for tokens of instance `label` currently at `node`.
Animation.prototype._entriesAt = function(node, label) {
  node = this._canonicalId(node); // accept a process id (→ its participant shape)
  const out = [];
  for (const entry of this._tokenMap.values()) {
    if (entry.node === node && entry.label === label) {
      out.push(entry);
    }
  }
  return out;
};

// The (single) token resting at `node` on `sequenceFlow`, regardless of label — the outer
// thread token at an MI activity's incoming flow. `undefined` if none.
Animation.prototype._tokenOnFlow = function(node, sequenceFlow) {
  // Several instances of a stacked node can rest on the same incoming flow at once — e.g. each pool /
  // process instance's MI outer-thread token. Prefer the **visible** one (the current front instance's),
  // so an MI sub spawns under the instance the user is driving, not an arbitrary stacked one. Falls back
  // to the first match when nothing is stacked (a lone token is always visible anyway).
  let fallback;
  for (const entry of this._tokenMap.values()) {
    if (entry.node === node && entry.sequenceFlow === sequenceFlow) {
      if (this._primitives._isVisible(entry.token)) {
        return entry;
      }
      fallback = fallback || entry;
    }
  }
  return fallback;
};

// Record a token in the maps, linking it under its parent (null = a tree root). `_tokenMap` is
// keyed by the token **object** — stable as the token changes flow/position (no re-keying); the
// entry carries the lookup fields. `sequenceFlow` is the flow it rests on (null = anchored).
Animation.prototype._register = function(node, label, token, stackIndices, parent, position, sequenceFlow) {
  this._tokenMap.set(token, { token, node, label, stackIndices, position, sequenceFlow: sequenceFlow || null });

  if (!this._childTokens.has(token)) {
    this._childTokens.set(token, []);
  }
  if (parent) {
    this.getChildren(parent).push(token);
  }
};

Animation.prototype._nextDistinctColor = function() {
  return getDistinctColor(this._colorIndex++);
};

Animation.prototype._requireElement = function(node) {
  const element = this._elementRegistry.get(node);
  if (!element) {
    throw new Error(`unknown element "${node}"`);
  }
  return element;
};

/**
 * Resolve a **process id** to its on-canvas shape id. In a collaboration a `bpmn:Process` has no
 * shape of its own — its `bpmn:Participant` (pool) does — so a caller may name the **process**
 * (`'OrderProcess'`) instead of the participant; this maps it to the participant's id. A bare
 * (pool-less) process, a flow node, or any id that is already a real shape is returned unchanged.
 * Idempotent (a participant id resolves to itself). Applied to every `node` a public method takes,
 * so processes are always addressable by their process id.
 */
Animation.prototype._canonicalId = function(id) {
  if (id == null || this._elementRegistry.get(id)) {
    return id;
  }
  const participant = this._elementRegistry.filter(el =>
    is(el, 'bpmn:Participant') &&
    el.businessObject.processRef &&
    el.businessObject.processRef.id === id)[0];
  return participant ? participant.id : id;
};

// The enclosing scope (process/participant/sub-process) of a flow node — its parent,
// bridging a collapsed sub-process's drill-plane root to the shape.
Animation.prototype._scopeOf = function(element) {
  const parent = element.parent;
  return parent ? this._shapeOf(parent) : null;
};

// A drill-plane root (id `<id>_plane`, businessObject = the sub-process) → its shape.
Animation.prototype._shapeOf = function(el) {
  const bo = el.businessObject;
  if (bo && el.id !== bo.id) {
    const shape = this._elementRegistry.get(bo.id);
    if (shape) {
      return shape;
    }
  }
  return el;
};

// A node where a token simply arrives and anchors at the symbol center: any event, an
// exclusive gateway (no synchronization), or any gateway with a single incoming flow. A
// non-exclusive gateway with several incoming flows is a real join — handled separately.
// An event or **any** gateway anchors a token at its symbol center (a converging gateway too:
// a branch arriving there can be anchored at the center — `joinTokens` is the separate operation
// that collapses *several* branches into one).
function anchorsAtCenter(element) {
  return is(element, 'bpmn:Event') || is(element, 'bpmn:Gateway');
}
