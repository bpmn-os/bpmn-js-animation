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
 *   - `_tokenMap`    : `Map<"node|label", { token, node, stackIndices }>`
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
  this._tokenMap = new Map();    // "node|label" -> { token, node, stackIndices }
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
  // instance index = number of instances already present; grow the stack to include it
  const index = this._animation.getStackSize(node);
  this._animation.setStackSize(node, index + 1, {});

  const color = this._nextDistinctColor();
  const stackIndices = { [node]: index };
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
 * Advance a token. Two forms, by node kind:
 *
 *  - **activity/container** (process/participant, subprocess, task, call activity): advance
 *    to a named sweep `position` (`ready`/`entry`/`busy`/`completed`/`exit`) from the token's
 *    current position, **gliding through every skipped intermediate** so the path is shown.
 *    Forward-only. `bounce` applies at the target.
 *  - **center node** — an event, or a **pass-through gateway** (an exclusive gateway, or any
 *    gateway with a single incoming flow): anchor the token at the symbol's **center**,
 *    taking it off whatever flow it rests on (the flow→anchor crossing). No `position`
 *    needed. `bounce` optional. (A non-exclusive gateway with several incoming flows is a
 *    real join — handled separately.)
 *
 * @param {{ node: string, label: string, position?: string, bounce?: boolean }} args
 *   `position` is required for activities; ignored for center nodes.
 * @return {Promise<object>} resolves with the token once it rests
 */
SimulationAPI.prototype.advanceToken = async function(args) {
  const { node, label, position, bounce = false } = args;
  const element = this._requireElement(node);

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
  if (to < from) {
    throw new Error(`advanceToken: cannot advance backward (${entry.position} → ${position})`);
  }

  const selector = { stackIndices: entry.stackIndices };

  // glide through every skipped intermediate in ONE continuous animation (smooth, no
  // stop at each step); the model commits only to the target, which carries the bounce.
  const via = [];
  for (let i = from + 1; i < to; i++) {
    via.push(positionFor(SWEEP[i]));
  }
  await this._animation.glideToState(node, label, { position: positionFor(position), bounce }, selector, via);

  entry.position = position;
  return this._touched(entry.token);
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

/**
 * Move a token onto a sequence flow and send it along that flow to the far node, where it
 * comes to rest **on the same flow** (the host anchors it afterwards).
 *
 * Case: `node` is a flow node holding the `(node, label)` token; `sequenceFlow` is a flow
 * connected to it (outgoing → forward, incoming → reverse — direction is `sendToken`'s
 * call). Re-keys the token to the far node in `tokenMap`; identity (and any children) is
 * carried by the moved token.
 *
 * @param {{ node: string, label: string, sequenceFlow: string }} args
 * @return {Promise<object>} resolves with the token once it has landed on the flow
 */
SimulationAPI.prototype.forwardToken = async function(args) {
  const { node, label, sequenceFlow } = args;
  const element = this._requireElement(node);

  if (!is(element, 'bpmn:FlowNode')) {
    throw new Error(`forwardToken: "${node}" is not a flow node`);
  }

  const entry = this.getEntry(node, label);
  if (!entry) {
    throw new Error(`forwardToken: no token <${label}> at <${node}>`);
  }

  const flow = this._elementRegistry.get(sequenceFlow);
  if (!flow || (flow.source !== element && flow.target !== element)) {
    throw new Error(`forwardToken: "${sequenceFlow}" is not connected to "${node}"`);
  }

  // move onto the flow (stop bounce), then travel along it to the far node
  const selector = { sequenceFlow: entry.sequenceFlow || undefined, stackIndices: entry.stackIndices };
  const moved = this._animation.setState(node, label, { sequenceFlow, bounce: false }, selector);
  const [ landed ] = await this._animation.sendToken([
    { node, label, sequenceFlow, stackIndices: moved.stackIndices }
  ]);

  // sendToken lands a NEW token object at the far node — take over the old token's place
  // in the hierarchy, then re-key it to the far node (now resting on the flow)
  this._replaceToken(entry.token, landed);
  this._tokenMap.delete(keyOf(node, label));
  this._tokenMap.set(keyOf(landed.node, label), {
    token: landed,
    node: landed.node,
    stackIndices: landed.stackIndices,
    position: null,                          // on a flow, not at a named position
    sequenceFlow: landed.state.sequenceFlow
  });

  return this._touched(landed);
};

// --- lookup / reset ----------------------------------------------------------

/** The bookkeeping entry for `(node, label)`, or `undefined`. */
SimulationAPI.prototype.getEntry = function(node, label) {
  return this._tokenMap.get(keyOf(node, label));
};

/** The token at `(node, label)`, or `undefined`. */
SimulationAPI.prototype.getToken = function(node, label) {
  const entry = this.getEntry(node, label);
  return entry && entry.token;
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

// Record a token in the maps, linking it under its parent (null = a tree root).
SimulationAPI.prototype._register = function(node, label, token, stackIndices, parent, position) {
  this._tokenMap.set(keyOf(node, label), { token, node, stackIndices, position });

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

function keyOf(node, label) {
  return node + '|' + label;
}

// A node where a token simply arrives and anchors at the symbol center: any event, an
// exclusive gateway (no synchronization), or any gateway with a single incoming flow. A
// non-exclusive gateway with several incoming flows is a real join — handled separately.
function anchorsAtCenter(element) {
  return is(element, 'bpmn:Event') ||
    is(element, 'bpmn:ExclusiveGateway') ||
    (is(element, 'bpmn:Gateway') && (element.incoming || []).length <= 1);
}
