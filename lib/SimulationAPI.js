import { getDistinctColor } from './color';
import { classify } from './simulation/classify';
import { positionFor } from './simulation/positions';

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
 * Create a token for a new process/participant instance.
 *
 * Case: `node` must classify as a `bpmn:Process` or `bpmn:Participant`. Increments the
 * node's instance stack and creates the (root) token of that instance at the **ready**
 * position, with a fresh distinct color.
 *
 * @param {string} node   the process / participant element id
 * @param {string} label  the instance id (e.g. "Instance_1")
 * @return {object} the created token
 */
SimulationAPI.prototype.createToken = function(node, label) {
  const element = this._requireElement(node);
  const c = classify(element);

  if (!c.process && c.profile !== 'container') {
    throw new Error(`createToken: "${node}" is not a bpmn:Process or bpmn:Participant`);
  }

  // instance index = number of instances already present; grow the stack to include it
  const index = this._animation.getStackSize(node);
  this._animation.setStackSize(node, index + 1, {});

  const color = this._nextDistinctColor();
  const stackIndices = { [node]: index };
  const state = { position: positionFor('ready') };
  const token = this._animation.createToken(node, label, color, state, stackIndices);

  this._register(node, label, token, stackIndices, null);

  return this._touched(token);
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

// Record a token in the maps, linking it under its parent (null = a tree root).
SimulationAPI.prototype._register = function(node, label, token, stackIndices, parent) {
  this._tokenMap.set(keyOf(node, label), { token, node, stackIndices });

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

function keyOf(node, label) {
  return node + '|' + label;
}
