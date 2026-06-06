import { is, isAny } from 'bpmn-js/lib/util/ModelUtil';

import { getDistinctColor } from './color';
import { classify } from './simulation/classify';
import { positionFor, Position, SWEEP } from './simulation/positions';

/**
 * SimulationAPI — the high-level, user-facing surface for driving BPMN token flow.
 *
 * It **composes** the low-level `animation` service (never extends it) into a small
 * BPMN-shaped vocabulary, and owns the state that lets a host address tokens by readable
 * `(node, label)` names — where **label is the instance id** (e.g. `"Instance_1#1"`):
 *
 *   - `_tokenMap`    : `Map<token, { token, node, label, stackIndices, position, sequenceFlow }>`
 *   - `_childTokens` : `Map<token, token[]>` — one tree per process instance
 *
 * SimulationAPI is the sole writer of tokens and resets with the diagram. It is driven by
 * a simulation engine's token log: the host calls these functions as the engine reports
 * movements; the library decides *how* each node type animates, never *when*.
 *
 * Names may overlap the `animation` service freely — they are independent namespaces.
 *
 * Functions are built one case at a time: each validates the case it handles via its
 * args; other cases are added as separate calls/branches later.
 */
export default function SimulationAPI(eventBus, animation, elementRegistry) {
  this._animation = animation;
  this._elementRegistry = elementRegistry;

  this._reset();
  this._autoFocus = false; // a setting (persists across diagram resets)

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this._reset());
}

SimulationAPI.$inject = [ 'eventBus', 'animation', 'elementRegistry' ];

/**
 * Toggle "auto-focus": when on, every call that touches a token reveals that token's
 * instance(s) — bringing them to the front of their stack so the just-touched token is
 * the visible one. Off by default. Global — applies to all functions (each ends with
 * `_touched`).
 */
SimulationAPI.prototype.autoFocus = function(on = true) {
  this._autoFocus = !!on;
};

SimulationAPI.prototype._reset = function() {
  this._tokenMap = new Map();    // token -> { token, node, label, stackIndices, position, sequenceFlow }
  this._childTokens = new Map(); // token -> token[]
  this._colorIndex = 0;          // drives getDistinctColor for fresh identities
};

// --- creation ----------------------------------------------------------------

/**
 * Create a token. Two cases, by node kind:
 *
 *  - **Process / Participant** — start a new instance: increment the node's instance
 *    stack and create the (root) token at `ready`, with a fresh distinct color.
 *  - **Start event of a Process / SubProcess** (NOT an event sub-process) — create a
 *    **child** of the token residing at the enclosing scope, with the **same label** and
 *    color, at the `center` position. (The flow token that entered the scope.)
 *
 * @param {{ node: string, label: string, bounce?: boolean }} args
 *   `node`: process/participant or a start event element id; `label`: the instance id.
 * @return {object} the created token
 */
SimulationAPI.prototype.createToken = function(args) {
  const { node, label, bounce = false } = args;
  const element = this._requireElement(node);

  if (this.getEntry(node, label)) {
    throw new Error(`createToken: a token <${label}> already exists at <${node}>`);
  }

  if (isAny(element, [ 'bpmn:Process', 'bpmn:Participant' ])) {
    return this._createInstanceToken(node, label, bounce);
  }
  if (is(element, 'bpmn:StartEvent')) {
    return this._createStartEventToken(node, label, element, bounce);
  }
  throw new Error(`createToken: "${node}" is not a process/participant or a start event`);
};

// Process/Participant: a new instance's root token at `ready`, fresh distinct color.
SimulationAPI.prototype._createInstanceToken = function(node, label, bounce) {
  // the instance key IS this token's label — append it to the node's stack (base context)
  this._animation.updateStacks(node, [ ...this._animation.getStacks(node), label ], {});

  const color = this._nextDistinctColor();
  const stackIndices = { [node]: label };
  const state = { position: positionFor(Position.READY), bounce };
  const token = this._animation.createToken(node, label, color, state, stackIndices);

  this._register(node, label, token, stackIndices, null, Position.READY);

  return this._touched(token);
};

// Start event of a Process/SubProcess (not an event sub-process): a child of the scope's
// token, same label/color, at `center`.
SimulationAPI.prototype._createStartEventToken = function(node, label, element, bounce) {
  const scope = this._scopeOf(element);
  if (!scope) {
    throw new Error(`createToken: start event "${node}" has no enclosing scope`);
  }

  const sc = classify(scope);
  if (sc.eventSubProcess) {
    throw new Error(`createToken: start event of an event sub-process is not supported here`);
  }

  const parent = this.getEntry(scope.id, label);
  if (!parent) {
    throw new Error(`createToken: no token <${label}> at scope <${scope.id}>`);
  }

  const stackIndices = { ...parent.stackIndices };
  const state = { position: positionFor(Position.CENTER), bounce };
  const token = this._animation.createToken(node, label, parent.token.color, state, stackIndices);

  this._register(node, label, token, stackIndices, parent.token, Position.CENTER);

  return this._touched(token);
};

/**
 * Advance a token one step forward. The kind of step is named by the args:
 *
 *  - **along a flow** — pass `sequenceFlow`: move the token onto that connected sequence
 *    flow and travel it to the far node, where it comes to rest **on the same flow**; the
 *    host advances it again to settle it into the node. Re-keys to the far node; identity
 *    and any children are carried by the moved token.
 *  - **into a center node** — an event, or a **pass-through gateway** (an exclusive gateway,
 *    or any gateway with a single incoming flow): anchor the token at the symbol's
 *    **center**, taking it off whatever flow it rests on (the flow→anchor crossing). No
 *    `position` needed. (A non-exclusive gateway with several incoming flows is a real
 *    join — handled separately.)
 *  - **within an activity/container** (process/participant, subprocess, task, call activity)
 *    — pass `position` (a `SWEEP` value: `ready`/`entry`/`busy`/`completed`/`exit`): glide
 *    from the token's current position to the target, **through every skipped intermediate**
 *    so the path is shown. Forward-only. `bounce` applies at the target.
 *
 * @param {{ node: string, label: string, sequenceFlow?: string, position?: string, bounce?: boolean }} args
 * @return {Promise<object>} resolves with the token once it has come to rest
 */
SimulationAPI.prototype.advanceToken = async function(args) {
  const { node, label, sequenceFlow, position, bounce = false } = args;
  const element = this._requireElement(node);

  // along a flow → travel to the far node (rests on the flow there)
  if (sequenceFlow) {
    return this._travelFlow(node, label, sequenceFlow, element);
  }

  // into a center node → anchor at the symbol center
  if (anchorsAtCenter(element)) {
    return this._anchorAtCenter(node, label, bounce);
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
  // stop at each step); the model commits only to the target, which carries the bounce.
  const via = [];
  for (let i = from + 1; i < to; i++) {
    via.push(positionFor(SWEEP[i]));
  }
  const token = await this._animation.glideToState(node, label, { position: positionFor(position), bounce }, selector, via);

  entry.position = position;
  entry.sequenceFlow = null;            // anchored at the sweep position now, off any arrival flow
  entry.stackIndices = token.stackIndices;
  return this._touched(token);
};

// Center node (event / pass-through gateway): anchor the token at the symbol's center —
// taking it off whatever flow it rests on. The flow→anchor crossing commits the stack index.
SimulationAPI.prototype._anchorAtCenter = async function(node, label, bounce) {
  const entry = this.getEntry(node, label);
  if (!entry) {
    throw new Error(`advanceToken: no token <${label}> at <${node}>`);
  }

  const selector = { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices };
  const token = await this._animation.glideToState(
    node, label, { position: positionFor(Position.CENTER), bounce }, selector
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
SimulationAPI.prototype._travelFlow = async function(node, label, sequenceFlow, element) {
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

  // move onto the flow (idempotent if already there; stops bounce), then travel to the far node
  this._animation.setState(
    node, label, { sequenceFlow, bounce: false },
    { sequenceFlow: entry.sequenceFlow || undefined, stackIndices }
  );
  const [ landed ] = await this._animation.sendToken([
    { node, label, sequenceFlow, stackIndices }
  ]);

  // sendToken lands a NEW token object at the far node — carry the hierarchy over, drop the
  // source's entry, and register the landed token (keyed by object; sibling branches untouched).
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
SimulationAPI.prototype.forkToken = async function(args) {
  const { node, label, sequenceFlow } = args;
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
    const moved = this._animation.setState(
      node, label, { sequenceFlow, bounce: false },
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
  const clone = this._animation.createToken(node, label, sibling.color, { sequenceFlow }, sibling.stackIndices);

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
SimulationAPI.prototype.joinTokens = async function(args) {
  const { node, label } = args;
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
    this._animation.removeToken(node, label, { sequenceFlow: b.sequenceFlow, stackIndices: b.stackIndices });
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
  const merged = this._animation.createToken(node, label, color, { position: positionFor(Position.CENTER) }, stackIndices);
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
SimulationAPI.prototype.consumeToken = async function(args) {
  const { node, label } = args;
  const element = this._requireElement(node);

  const entries = this._entriesAt(node, label);
  if (entries.length === 0) {
    throw new Error(`consumeToken: no token <${label}> at <${node}>`);
  }
  const anchored = entries.find(e => !e.sequenceFlow);
  if (!anchored) {
    throw new Error(`consumeToken: <${label}> at <${node}> rests on a sequence flow and cannot be consumed directly`);
  }
  const target = anchored.token;

  // collect the subtree: the target and every descendant (some may rest on flows — they're
  // still torn down, even though such a token couldn't be the consume *target*)
  const subtree = [];
  const collect = token => {
    subtree.push(token);
    for (const child of this.getChildren(token)) {
      collect(child);
    }
  };
  collect(target);

  // detach the target from its parent's child list
  const siblings = this._parentOf(target);
  if (siblings) {
    const i = siblings.indexOf(target);
    if (i !== -1) {
      siblings.splice(i, 1);
    }
  }

  // remove every token in the subtree (animation + bookkeeping); each entry carries its own
  // node/label/flow (a descendant may sit elsewhere, even under a different label for MI)
  for (const token of subtree) {
    const e = this._tokenMap.get(token);
    if (e) {
      this._animation.removeToken(e.node, e.label, { sequenceFlow: e.sequenceFlow || undefined, stackIndices: e.stackIndices });
      this._tokenMap.delete(token);
    }
    this._childTokens.delete(token);
  }

  // stack-decrement: consuming a process/participant instance removes *its* key from the host's
  // stack (not just the count) — so surviving instances keep rendering; the last one clears the
  // box. MI activities and event sub-processes decrement too; that lands with their support.
  if (isAny(element, [ 'bpmn:Process', 'bpmn:Participant' ])) {
    const key = target.stackIndices[node];
    this._animation.updateStacks(node, this._animation.getStacks(node).filter(k => k !== key), {});
  }

  return subtree;
};

// --- lookup / reset ----------------------------------------------------------

/**
 * The bookkeeping entry for a token at `(node, label)`. Several same-label branches can rest
 * at one node (a gateway split, each on its own flow) — pass `sequenceFlow` to pick one;
 * without it, returns the single entry there, or `undefined` if there are none or several.
 * Internal record — prefer `getToken`/`getTokens`.
 */
SimulationAPI.prototype.getEntry = function(node, label, sequenceFlow) {
  const entries = this._entriesAt(node, label);
  if (sequenceFlow !== undefined) {
    const want = sequenceFlow || null;
    return entries.find(e => e.sequenceFlow === want);
  }
  return entries.length === 1 ? entries[ 0 ] : undefined;
};

/** The token at `(node, label)` — optionally the branch on `sequenceFlow` — or `undefined`. */
SimulationAPI.prototype.getToken = function(node, label, sequenceFlow) {
  const entry = this.getEntry(node, label, sequenceFlow);
  return entry && entry.token;
};

/** Every token of instance `label` currently at `node` (0, 1, or several branches). */
SimulationAPI.prototype.getTokens = function(node, label) {
  return this._entriesAt(node, label).map(e => e.token);
};

/** The child tokens of `token` (one tree per process instance). */
SimulationAPI.prototype.getChildren = function(token) {
  return this._childTokens.get(token) || [];
};

/** Reset all simulation state and clear the underlying animation. */
SimulationAPI.prototype.clear = function() {
  this._reset();
  this._animation.clear();
};

// --- internals ---------------------------------------------------------------

// Every function ends here: the shared post-touch hook. Honors the auto-focus toggle.
SimulationAPI.prototype._touched = function(token) {
  if (this._autoFocus) {
    this._bringToFront(token);
  }
  return token;
};

// Bring the token's instance(s) to the front of their stack(s), so it becomes visible.
// (Single-node for now; nested instances would want outer-first ordering.)
SimulationAPI.prototype._bringToFront = function(token) {
  const indices = token.stackIndices || {};
  for (const node of Object.keys(indices)) {
    this._animation.moveToFront(node, indices[node]);
  }
};

// A move replaces a token object with a new one (sendToken lands a fresh token). Carry the
// hierarchy over: `newToken` inherits `oldToken`'s children and takes its slot under its
// parent, so the per-instance tree stays intact across the move.
SimulationAPI.prototype._replaceToken = function(oldToken, newToken) {
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
SimulationAPI.prototype._parentOf = function(token) {
  for (const children of this._childTokens.values()) {
    if (children.includes(token)) {
      return children;
    }
  }
  return null;
};

// All bookkeeping entries for tokens of instance `label` currently at `node`.
SimulationAPI.prototype._entriesAt = function(node, label) {
  const out = [];
  for (const entry of this._tokenMap.values()) {
    if (entry.node === node && entry.label === label) {
      out.push(entry);
    }
  }
  return out;
};

// Record a token in the maps, linking it under its parent (null = a tree root). `_tokenMap` is
// keyed by the token **object** — stable as the token changes flow/position (no re-keying); the
// entry carries the lookup fields. `sequenceFlow` is the flow it rests on (null = anchored).
SimulationAPI.prototype._register = function(node, label, token, stackIndices, parent, position, sequenceFlow) {
  this._tokenMap.set(token, { token, node, label, stackIndices, position, sequenceFlow: sequenceFlow || null });

  if (!this._childTokens.has(token)) {
    this._childTokens.set(token, []);
  }
  if (parent) {
    this.getChildren(parent).push(token);
  }
};

SimulationAPI.prototype._nextDistinctColor = function() {
  return getDistinctColor(this._colorIndex++);
};

SimulationAPI.prototype._requireElement = function(node) {
  const element = this._elementRegistry.get(node);
  if (!element) {
    throw new Error(`unknown element "${node}"`);
  }
  return element;
};

// The enclosing scope (process/participant/sub-process) of a flow node — its parent,
// bridging a collapsed sub-process's drill-plane root to the shape.
SimulationAPI.prototype._scopeOf = function(element) {
  const parent = element.parent;
  return parent ? this._shapeOf(parent) : null;
};

// A drill-plane root (id `<id>_plane`, businessObject = the sub-process) → its shape.
SimulationAPI.prototype._shapeOf = function(el) {
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
function anchorsAtCenter(element) {
  return is(element, 'bpmn:Event') ||
    is(element, 'bpmn:ExclusiveGateway') ||
    (is(element, 'bpmn:Gateway') && (element.incoming || []).length <= 1);
}
