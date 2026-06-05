import {
  domify,
  query as domQuery,
  event as domEvent,
  classes as domClasses,
  closest as domClosest
} from 'min-dom';

import {
  create as svgCreate,
  append as svgAppend,
  appendTo as svgAppendTo,
  attr as svgAttr,
  remove as svgRemove
} from 'tiny-svg';

import { is } from 'bpmn-js/lib/util/ModelUtil';

import { getBBox } from 'diagram-js/lib/util/Elements';

const STYLE = typeof getComputedStyle !== 'undefined'
  ? getComputedStyle(document.documentElement)
  : null;

const DEFAULT_COLOR =
  (STYLE && STYLE.getPropertyValue('--token-simulation-green-base-44')) || '#10D070';

const MOVING_TOKEN_SIZE = 20; // the moving SVG dot
const DOT_SIZE = 25;          // the resting badge

// fixed animation time (ms), independent of flow length; overridable via
// `config.animation.animationDuration` or `setAnimationDuration()`.
const DEFAULT_DURATION = 1000;

const DEFAULT_MAX_VISIBLE = 3;

// diagonal shift (px, down-right) between successive shapes in an instance stack
const STACK_OFFSET = 4;

// implicit-process box (T4): left label banner width + padding around the content
const PROCESS_BOX_BANNER = 30;
const PROCESS_BOX_PADDING = 20;

// the stack scroll is UI feedback, not simulation — a fixed speed (ms), independent
// of the (simulation) animationDuration that drives token movement / icons
const STACK_SCROLL_DURATION = 600;

// counter for the fresh marker ids minted when cloning connections (see _inlineMarkers)
let MARKER_SEQ = 0;

// default rest state — centered on the shape, bouncing
const DEFAULT_POSITION = { left: 0.5, top: 0.5, hoffset: 0, voffset: 0 };
const DEFAULT_BOUNCE = true;

function noop() {}

/**
 * @typedef { {
 *   position: { left, top, hoffset, voffset } | null, // left/top = fraction of the shape
 *                                   //   (default 0.5), hoffset/voffset = px (default 0);
 *                                   //   mutually exclusive with sequenceFlow
 *   sequenceFlow: string | null,   // a connected sequence flow id (rest on it)
 *   bounce: boolean
 * } } TokenState
 *
 * @typedef { { node: string, label: string, color: string, state: TokenState, selected: boolean } } Token
 */

/**
 * The bpmn-js animation service — the package's single public API.
 *
 * It owns both:
 *  - **token animation**: a model of colored tokens that rest at nodes (clickable
 *    badges) and animate along sequence flows. A token is identified by
 *    `(node, label, sequenceFlow)`; its `state` ({ position | sequenceFlow, bounce })
 *    is a pure visual descriptor — the caller maps its own lifecycle onto positions.
 *  - **node animation**: `throwIcon(node)` / `catchIcon(node)` fly an element's
 *    own icon out/in.
 *
 * The low-level dot-along-a-connection tween (`TokenAnimation`, at the bottom of this
 * file) is adapted from bpmn-js-token-simulation; everything else here is specific to
 * this package.
 *
 * Fires on the eventBus: `token.click` `{ node, label, sequenceFlow, stackIndices }` and
 * `token.overflow.click` `{ node, hidden }` (the "+N" marker; each `hidden` ref carries
 * `stackIndices` too). The `stackIndices` lets a host address the clicked **instance's**
 * token (a stacked node shows only its front instance, so without it a selector resolves
 * to the base instance).
 */
export default function Animation(config, eventBus, canvas, overlays, elementRegistry, outline) {

  this._eventBus = eventBus;
  this._canvas = canvas;
  this._overlays = overlays;
  this._elementRegistry = elementRegistry;
  this._outline = outline;

  // Make the **native** diagram-js selection outline stack-aware: when a node is stacked,
  // grow its `.djs-outline` to wrap the whole stack (+ "+k" marker). Only the geometry
  // differs from native — selection state, events and interaction stay the documented
  // `selection` service, so the bpmn-js ecosystem (property panel, …) works unchanged.
  outline.registerProvider(1500, {
    getOutline() {}, // use the default rect; we only resize it
    updateOutline: (element, gfx) => {
      if (this.getStackSize(element.id) <= 1) {
        return false; // not stacked → default sizing
      }
      const o = outline.offset;
      const extent = this._stackExtent(element.id);
      const marker = this._stackMarkerWidth(element.id);
      svgAttr(gfx, {
        x: -o,
        y: -o,
        width: (element.width || 0) + o * 2 + extent + marker,
        height: (element.height || 0) + o * 2 + extent
      });
      return true;
    }
  });

  this._duration = config && config.animationDuration != null ? config.animationDuration : DEFAULT_DURATION;
  this._maxVisible = (config && config.maxVisible) || DEFAULT_MAX_VISIBLE;

  this._tokens = new Map();            // "node|label|flow|stackIndices" -> Token
  this._nodeTokens = new Map();        // node -> Set<Token>
  this._nodeOverlays = new Map();      // node -> overlayId[]  (one per location cluster)
  this._activeAnimations = new Map();  // Token -> TokenAnimation
  this._movements = new Set();         // all live TokenAnimation instances
  this._filter = null;                 // visibility predicate, or null = show all
  this._selectedNodes = new Set();     // node ids with a selection outline
  // per-instance state, keyed by ancestor-instance context (see _contextKey): a node's
  // stack size and its display order both depend on which ancestor instances are showing
  this._stackSizes = new Map();        // node -> Map<contextKey, size>
  this._stackOrder = new Map();        // node -> Map<contextKey, number[]>  (instance indices, front first)
  this._stackOverlays = new Map();     // node -> overlayId for the "+k hidden instances" marker
  this._processBox = null;             // { id, gfx, savedBounds } for an implicit-process box (T4)

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this.clear());

  // Built-in viewer interaction: double-click a stacked node to scroll its instances
  // (Shift = backward). On by default; disable with `config.animation.scrollOnDoubleClick:
  // false` — e.g. when pairing with a Modeler, where double-click edits labels.
  if (!config || config.scrollOnDoubleClick !== false) {
    eventBus.on('element.dblclick', e => this._scrollOnDoubleClick(e));
  }

  // Built-in viewer interaction: click a token to select it (blue ring) — sole-select, or
  // toggle within the selection with Shift. On by default; disable with
  // `config.animation.selectTokenOnClick: false`.
  if (!config || config.selectTokenOnClick !== false) {
    eventBus.on('token.click', e => this._selectOnClick(e));
  }
}

Animation.$inject = [
  'config.animation',
  'eventBus',
  'canvas',
  'overlays',
  'elementRegistry',
  'outline'
];


// token API //////////////

/**
 * Place a token at a node. Replaces any token already at the same identity
 * `(node, label, state.sequenceFlow, stackIndices)`.
 *
 * @param {string} node element id
 * @param {string} label identifies the token at the node (and shown on hover)
 * @param {string} color any CSS color (name, hex, rgb(), hsl(), …)
 * @param {Partial<TokenState>} [state] rest state (default: centered, bouncing)
 * @param {Object<string,number>} [stackIndices] which instance of each stacked ancestor
 *   (and the node itself if stacked) this token belongs to; omit unless the node or an
 *   ancestor is stacked.
 * @return {Token}
 */
Animation.prototype.createToken = function(node, label, color, state, stackIndices) {
  this._requireElement(node);

  if (label === undefined || label === null || label === '') {
    throw new Error('label is required');
  }

  if (!color) {
    throw new Error('color is required');
  }

  label = String(label);

  const normalized = normalizeState(state);
  const indices = stackIndices || {};

  const key = this._key(node, label, normalized.sequenceFlow, indices);
  const existing = this._tokens.get(key);

  if (existing) {
    existing.color = color;
    existing.state = normalized;
    this._renderNode(node);

    return existing;
  }

  const token = { node, label, color, state: normalized, selected: false, stackIndices: indices };

  this._tokens.set(key, token);
  this._addToNode(token, node);
  this._renderNode(node);

  return token;
};

/**
 * Travel tokens along the sequence flow they **already rest on** to the flow's far node,
 * leaving them **resting on the same flow** there. Each transition is
 * `{ node, label, sequenceFlow, stackIndices? }`: the token at `(node, label)` resting on
 * `sequenceFlow` (disambiguated by `stackIndices` if several match) animates along that
 * flow and comes to rest on it at the **other endpoint** — its `state` is unchanged
 * (`sequenceFlow` kept, no anchor). `sequenceFlow` may be **outgoing** (forward → target)
 * or **incoming** (reverse → source, e.g. rewind), inferred from which end `node` is.
 *
 * The token must be on the flow first — `setState(node, label, { sequenceFlow })` puts it
 * there; afterwards `setState(otherNode, label, { position })` anchors it on the node.
 * A **split** is the host's job (create a token on each outgoing flow). A move keeps the
 * token's `stackIndices`; while on a flow its own node's stack index doesn't gate it
 * (see `_isVisible`), so it stays visible traveling into a stacked node. An in-flight
 * source is settled first.
 *
 * @param {Array<{ node: string, label: string, sequenceFlow: string, stackIndices?: Object }>} transitions
 * @return {Promise<Token[]>} resolves with the resulting tokens once landed
 */
Animation.prototype.sendToken = function(transitions) {
  if (!Array.isArray(transitions) || !transitions.length) {
    return Promise.reject(new Error('sendToken requires a non-empty array of { node, label, sequenceFlow }'));
  }

  // resolve everything first, so an invalid transition rejects without side effects
  const moves = [];

  try {
    for (const transition of transitions) {
      const node = transition.node;
      const label = String(transition.label);
      const sequenceFlow = transition.sequenceFlow;

      if (!sequenceFlow) {
        throw new Error(`sendToken requires the sequenceFlow the token rests on for <${label}> at <${node}>`);
      }

      // the token must already rest on `sequenceFlow` (the flow it travels along)
      let matches = this._find(node, label).filter(t => (t.state.sequenceFlow || null) === sequenceFlow);

      // disambiguate by instance when several same-label tokens rest on the same flow
      if (matches.length > 1 && transition.stackIndices) {
        const k = this._contextKey(transition.stackIndices);
        matches = matches.filter(t => this._contextKey(t.stackIndices) === k);
      }

      if (!matches.length) {
        throw new Error(`no token <${label}> resting on <${sequenceFlow}> at <${node}> (setState it onto the flow first)`);
      }

      if (matches.length > 1) {
        throw new Error(`multiple tokens <${label}> on <${sequenceFlow}> at <${node}>; disambiguate with stackIndices`);
      }

      moves.push({ token: matches[0], ...this._resolveFlow(node, sequenceFlow) });
    }
  } catch (err) {
    return Promise.reject(err);
  }

  const branches = [];

  for (const { token, connection, toNode, waypoints } of moves) {

    // settle any in-flight transition, then consume the source token once
    this._settle(token);
    const indices = token.stackIndices;       // a move stays in the same instance
    const sequenceFlow = token.state.sequenceFlow;
    this._tokens.delete(this._key(token.node, token.label, sequenceFlow, indices));
    this._removeFromNode(token, token.node);
    this._renderNode(token.node);

    // lands resting on the SAME flow at the far node (host anchors it later via setState)
    const state = normalizeState({ sequenceFlow, bounce: token.state.bounce });
    const destKey = this._key(toNode, token.label, sequenceFlow, indices);
    const existing = this._tokens.get(destKey);
    const selected = !!token.selected || !!(existing && existing.selected);

    const branch = { node: toNode, label: token.label, color: token.color, state, selected, stackIndices: indices };

    // optimistic identity: addressable at the destination right away
    this._tokens.set(destKey, branch);

    branches.push(new Promise((resolve, reject) => {
      const movement = this._move(
        { waypoints },
        { color: token.color, element: connection, selected },
        () => {
          this._activeAnimations.delete(branch);
          this._addToNode(branch, toNode);
          this._renderNode(toNode);
          resolve(branch);
        }
      );

      if (!movement) {
        reject(new Error('could not animate token (no canvas layer)'));
        return;
      }

      this._activeAnimations.set(branch, movement);

      if (!this._isVisible(branch)) {
        movement.hide();
      }
    }));
  }

  return Promise.all(branches);
};

/**
 * Update a resting token's state in place (partial merge). Setting `position`
 * clears `sequenceFlow` and vice versa; `bounce` is independent. The `selector`
 * (`{ sequenceFlow?, stackIndices? }`) picks which token when several same-label tokens
 * rest at the node (different rest flows or instances). Changing the rest flow/position
 * rekeys (merging into any token already at the new identity — this is how a join
 * completes). Crossing the **flow↔anchor** boundary adjusts the token's own-node stack
 * index: anchoring a flow-resting token (sequenceFlow → position) commits it into the
 * node's **currently-visible** instance (`stackIndices[node] = getStackIndex(node)`);
 * stepping onto a flow drops that index (flow tokens are instance-agnostic). Ancestor
 * indices are never touched. When the resting point moves and `animationDuration > 0`, the
 * dot **glides** to the new point (over a third of the flow-move duration) instead of
 * jumping; the returned token is updated synchronously regardless (the glide is cosmetic).
 *
 * @param {string} node
 * @param {string} label
 * @param {Partial<TokenState>} state
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @return {Token}
 */
Animation.prototype.setState = function(node, label, state, selector) {
  return this._setState(node, label, state, selector);
};

/**
 * Like {@link setState}, but **awaitable**: resolves when the token has come to rest at
 * the new point — after the glide finishes when one runs (`animationDuration > 0` and the
 * rest point moved), or immediately otherwise. Lets a caller sequence several rest-point
 * changes so the dot visibly travels through each (rather than the synchronous `setState`,
 * which `_settle`s the prior move and would snap through intermediates).
 *
 * Pass `via` — an array of intermediate `position` objects — to make the dot travel
 * through them in **one continuous glide** before resting at `state` (the model commits
 * to `state` only; the `via` points are visual waypoints). This keeps a multi-step
 * advance smooth instead of stopping at each step.
 *
 * @param {string} node
 * @param {string} label
 * @param {Partial<TokenState>} state
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @param {Array<{left,top,hoffset,voffset}>} [via] intermediate positions to glide through
 * @return {Promise<Token>}
 */
Animation.prototype.glideToState = function(node, label, state, selector, via) {
  return new Promise(resolve => {
    this._setState(node, label, state, selector, resolve, via);
  });
};

// setState's body, with an `onSettled(token)` hook called once the token is at rest
// (immediately, or in the glide's done callback). setState ignores it; glideToState
// resolves its promise with it. `via` adds intermediate glide waypoints (see above).
Animation.prototype._setState = function(node, label, state, selector, onSettled = noop, via) {
  label = String(label);

  const sel = selector || {};
  const indices = sel.stackIndices || {};
  const oldKey = this._key(node, label, sel.sequenceFlow, indices);
  const token = this._tokens.get(oldKey);

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sel.sequenceFlow ? ` on <${sel.sequenceFlow}>` : ''}`);
  }

  // finish any in-flight move so the glide starts from a settled rest point
  this._settle(token);

  const element = this._elementRegistry.get(node);
  const canAnimate = element && element.width != null;
  const from = canAnimate ? this._clusterPoint(element, token.state) : null;
  // intermediate glide waypoints — resolved against the *current* state (before commit)
  const viaPoints = canAnimate && via
    ? via.map(position => this._clusterPoint(element, mergeState(token.state, { position })))
    : [];

  this._tokens.delete(oldKey);
  this._removeFromNode(token, node);

  const prevFlow = token.state.sequenceFlow;
  token.state = mergeState(token.state, state || {});
  const nowFlow = token.state.sequenceFlow;

  // crossing the flow<->anchor boundary commits the token into / releases it from this
  // node's stack instance: a flow token is instance-agnostic for its own node (only
  // ancestors gate it), an anchored token belongs to a specific instance. So anchoring
  // (flow -> position) joins the instance **currently on screen**; stepping onto a flow
  // drops the own-node index.
  if (this.getStackSize(node) > 1) {
    if (prevFlow && !nowFlow) {
      token.stackIndices = { ...token.stackIndices, [node]: this.getStackIndex(node) };
    } else if (!prevFlow && nowFlow) {
      token.stackIndices = { ...token.stackIndices };
      delete token.stackIndices[node];
    }
  }

  // rekeying onto an occupied identity completes a join: OR the selection so a
  // selected token survives the merge (color is left as last-writer-wins)
  const newKey = this._key(node, label, token.state.sequenceFlow, token.stackIndices);
  const existing = this._tokens.get(newKey);

  if (existing && existing !== token) {
    token.selected = token.selected || existing.selected;
  }

  this._tokens.set(newKey, token);

  // glide the dot from its old rest point to the new one (cosmetic — the model is already
  // updated, so the token is addressable immediately). Skip when instant (duration 0) or
  // the resting point didn't move (e.g. a bounce-only change), which stays synchronous.
  const to = canAnimate ? this._clusterPoint(element, token.state) : null;
  const moved = from && to && (Math.round(from.x) !== Math.round(to.x) || Math.round(from.y) !== Math.round(to.y));

  if (this._duration > 0 && moved) {
    this._renderNode(node); // the moved token's badge is absent (removed above) — only the glide shows
    // one continuous path: from → each via point → to (timing is distributed by segment
    // length, so it glides through the via points without stopping)
    const waypoints = [ from, ...viaPoints, to ].map(p => ({ x: p.x + element.x, y: p.y + element.y }));
    // a short glide per segment — a third of a full flow move each, so multi-step stays steady
    const duration = (this._duration / 3) * (viaPoints.length + 1);
    const movement = this._move({ waypoints }, { element, color: token.color, selected: token.selected }, () => {
      this._activeAnimations.delete(token);
      this._addToNode(token, node);
      this._renderNode(node);
      onSettled(token);
    }, duration);

    if (movement) {
      this._activeAnimations.set(token, movement);
      return token;
    }
  }

  this._addToNode(token, node);
  this._renderNode(node);
  onSettled(token);

  return token;
};

/**
 * Remove the token at `(node, label, selector?)`, cancelling any in-flight animation.
 * `selector` (`{ sequenceFlow?, stackIndices? }`) defaults to the anchor token of the
 * base instance.
 *
 * @param {string} node
 * @param {string} label
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 */
Animation.prototype.removeToken = function(node, label, selector) {
  label = String(label);

  const sel = selector || {};
  const key = this._key(node, label, sel.sequenceFlow, sel.stackIndices || {});
  const token = this._tokens.get(key);

  if (!token) {
    return;
  }

  const movement = this._activeAnimations.get(token);

  if (movement) {
    this._stopMovement(movement);
    this._activeAnimations.delete(token);
  }

  this._tokens.delete(key);
  this._removeFromNode(token, node);
  this._renderNode(node);
};

/**
 * Mark the token at `(node, label, sequenceFlow?)` as **selected** — drawing a
 * modeller-style blue ring around its resting dot. Selection is a carried token
 * property (like `color`, not part of the per-landing `state`): it survives a
 * `sendToken` move, is copied to every branch on a split, and OR-merges on a join
 * (the merged token stays selected if any of its inputs was). `sequenceFlow`
 * disambiguates when several same-label tokens rest at the node.
 *
 * @param {string} node
 * @param {string} label
 * @param {string} [sequenceFlow]
 * @return {Token}
 */
Animation.prototype.selectToken = function(node, label, selector) {
  return this._setTokenSelected(node, label, selector, true);
};

/**
 * Clear the selection on the token at `(node, label, selector?)`.
 *
 * @param {string} node
 * @param {string} label
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @return {Token}
 */
Animation.prototype.deselectToken = function(node, label, selector) {
  return this._setTokenSelected(node, label, selector, false);
};

/**
 * The currently selected tokens (e.g. to feed a side panel). Convenience for
 * `getTokens(t => t.selected)`.
 *
 * @return {Token[]}
 */
Animation.prototype.getSelectedTokens = function() {
  return this.getTokens(t => t.selected);
};

/**
 * The ids of the currently selected nodes (those with a selection outline).
 *
 * @return {string[]}
 */
Animation.prototype.getSelectedNodes = function() {
  return Array.from(this._selectedNodes);
};

/**
 * All tokens (each `{ node, label, color, state, selected, stackIndices }`), in
 * insertion order.
 *
 * @param {(token: Token) => boolean} [filter]
 * @return {Token[]}
 */
Animation.prototype.getTokens = function(filter) {
  const all = Array.from(this._tokens.values());
  return filter ? all.filter(filter) : all;
};

/**
 * Bring a stacked node's **instance** to the front of its display order (the front
 * instance is the one whose tokens show). Operates on the node's order **in the current
 * ancestor context**; the rest keep their relative order. No-op if the node isn't stacked
 * or the index is out of range. Re-renders the node's subtree.
 *
 * @param {string} node
 * @param {number} instanceIndex
 */
Animation.prototype.moveToFront = function(node, instanceIndex) {
  this._reorderStack(node, instanceIndex, true);
};

/**
 * Send a stacked node's instance to the **back** of its display order (opposite of
 * `moveToFront`).
 *
 * @param {string} node
 * @param {number} instanceIndex
 */
Animation.prototype.moveToBack = function(node, instanceIndex) {
  this._reorderStack(node, instanceIndex, false);
};

/** Move `instanceIndex` to the front (`toFront`) or back of `node`'s current-context order. */
Animation.prototype._reorderStack = function(node, instanceIndex, toFront) {
  const order = this._resolveOrder(node);
  const i = order ? order.indexOf(instanceIndex) : -1;

  if (i === -1) {
    return;
  }

  order.splice(i, 1);
  toFront ? order.unshift(instanceIndex) : order.push(instanceIndex);
  this._renderStackSubtree(node);
};

/**
 * Re-render a node's subtree after its front instance changes (reorder/jump/scroll). The
 * new instance can change, across the whole subtree, both **which tokens are visible** and
 * **descendant stack sizes** (a nested stack's size is per outer instance). So redraw the
 * node's stack + every descendant stack (silhouette/`+k`/tokens), and re-render any other
 * descendant that merely carries tokens.
 */
Animation.prototype._renderStackSubtree = function(node, redrawSelf = true) {
  const done = new Set([ node ]);

  // `redrawSelf` is false mid-scroll: the gesture owns the node's own silhouette (animated
  // clones), so only re-render its tokens — but still redraw descendant silhouettes.
  redrawSelf ? this._redrawStack(node) : this._renderNode(node);

  for (const id of Array.from(this._stackSizes.keys())) {
    if (id !== node && this._isDescendant(id, node)) {
      this._redrawStack(id);
      done.add(id);
    }
  }

  for (const key of Array.from(this._nodeTokens.keys())) {
    if (!done.has(key) && this._isDescendant(key, node)) {
      this._renderNode(key);
    }
  }
};

/**
 * Set a visibility filter. Tokens for which `predicate(token)` is falsy are
 * hidden — **not removed**: `getTokens` still returns them and `sendToken` /
 * `setState` still work; they just aren't drawn (and don't count toward the
 * `+N` overflow cap). Pass `null` to show everything again.
 *
 * @param {((token: Token) => boolean) | null} predicate
 */
Animation.prototype.setFilter = function(predicate) {
  this._filter = typeof predicate === 'function' ? predicate : null;

  for (const node of Array.from(this._nodeTokens.keys())) {
    this._renderNode(node);
  }

  for (const [ token, movement ] of this._activeAnimations) {
    if (this._isVisible(token)) {
      movement.show();
    } else {
      movement.hide();
    }
  }
};

/** Remove all tokens and animations. */
Animation.prototype.clear = function() {
  for (const movement of Array.from(this._movements)) {
    this._stopMovement(movement);
  }

  this._activeAnimations.clear();

  for (const overlayIds of this._nodeOverlays.values()) {
    overlayIds.forEach(id => this._overlays.remove(id));
  }

  this._nodeOverlays.clear();
  this._nodeTokens.clear();
  this._tokens.clear();

  // drop selection outlines for nodes still present (on diagram.clear/destroy
  // the elements may already be gone — just forget them then)
  for (const node of Array.from(this._selectedNodes)) {
    if (this._elementRegistry.get(node)) {
      this.setNodeSelected(node, false);
    }
  }

  this._selectedNodes.clear();

  // drop the stack "+k" overflow markers
  for (const id of this._stackOverlays.values()) {
    this._overlays.remove(id);
  }

  this._stackOverlays.clear();

  // drop the implicit-process box (restores the root's bounds) before clearing sizes
  this._removeProcessBox();

  // drop instance-stack shapes for nodes still present (elements may be gone on
  // diagram.clear/destroy — just forget them then)
  for (const node of Array.from(this._stackSizes.keys())) {
    const element = this._elementRegistry.get(node);

    if (element) {
      this._clearStackShapes(this._stackGfx(element));
    }
  }

  this._stackSizes.clear();
  this._stackOrder.clear();
};

/**
 * Set the fixed animation duration (ms) — shared by token movement and
 * `throwIcon`/`catchIcon`.
 *
 * @param {number} duration
 */
Animation.prototype.setAnimationDuration = function(duration) {
  this._duration = duration;
};

Animation.prototype.getAnimationDuration = function() {
  return this._duration;
};

/**
 * The per-cluster visible cap (`config.animation.maxVisible`, default 3) — the
 * number of token dots shown before the `+N` overflow marker, and the number of
 * stacked-shape copies drawn by `setStackSize`. Exposed so callers can size a
 * stack so its last shape lines up with the overflow marker.
 *
 * @return {number}
 */
Animation.prototype.getMaxVisible = function() {
  return this._maxVisible;
};


// node API //////////////

/**
 * Play an element's own icon (the rendered event icon / task-type icon) as a
 * one-off **throw**: the icon flies out diagonally to the upper-right and fades
 * out. Native icon color; shared animation duration. No-op if the element has no
 * icon. The direction is the caller's choice (pair with `catchIcon` for the
 * reverse) — the library reads no BPMN semantics here.
 *
 * @param {string} node element id
 * @return {Promise<void>} resolves when the effect ends
 */
Animation.prototype.throwIcon = function(node) {
  return this._animateIcon(node, 'emit');
};

/**
 * Play an element's own icon as a one-off **catch**: the icon flies in
 * diagonally from the upper-left and fades in. Counterpart to `throwIcon`.
 *
 * @param {string} node element id
 * @return {Promise<void>} resolves when the effect ends
 */
Animation.prototype.catchIcon = function(node) {
  return this._animateIcon(node, 'receive');
};

/**
 * Toggle a **selection outline** on an element — the same blue boundary the
 * bpmn-js modeller draws around a selected shape. We draw our own outline rect
 * into the element's graphics (matching the modeller's 5px offset / rounded
 * corners) rather than relying on diagram-js's Outline module, which a bare
 * viewer may not load. A `bts-selected` marker class is added too as a styling
 * hook. Selecting several nodes is allowed; each is independent. Cleared on
 * `diagram.clear`/`destroy` like everything else.
 *
 * @param {string} node element id
 * @param {boolean} [selected=true] pass `false` to clear
 */
Animation.prototype.setNodeSelected = function(node, selected = true) {
  this._requireElement(node);

  const element = this._elementRegistry.get(node);
  const gfx = this._stackGfx(element);

  if (!selected) {
    this._canvas.removeMarker(node, 'bts-selected');

    const outline = gfx && domQuery('.bts-node-outline', gfx);

    if (outline) {
      svgRemove(outline);
    }

    this._selectedNodes.delete(node);
    return;
  }

  this._canvas.addMarker(node, 'bts-selected');
  this._selectedNodes.add(node);

  this._drawNodeOutline(node, element, gfx);
};

/** Extra width/height the selection outline needs to cover a node's instance stack. */
Animation.prototype._stackExtent = function(node) {
  const size = this.getStackSize(node);

  return size <= 1 ? 0 : Math.min(size - 1, this._maxVisible) * STACK_OFFSET;
};

/**
 * Create or resize the selection outline rect so it wraps the element **and its
 * instance stack** (which extends down-right by the stack extent). Called when the
 * node is selected and whenever its stack size changes.
 */
Animation.prototype._drawNodeOutline = function(node, element, gfx) {
  if (!gfx || element.width == null) {
    return; // no gfx, or a bare process root with no box yet (nothing to outline)
  }

  let outline = domQuery('.bts-node-outline', gfx);

  if (!outline) {
    outline = svgCreate('rect');
    svgAttr(outline, { rx: 4, class: 'bts-node-outline' });
    svgAppend(gfx, outline);
  }

  const offset = 5;
  const extent = this._stackExtent(node);
  const marker = this._stackMarkerWidth(node); // 0 when there's no "+k" marker

  svgAttr(outline, {
    x: -offset,
    y: -offset,
    // the "+k" marker sits past the stack on the right — span over it too
    width: (element.width || 0) + offset * 2 + extent + marker,
    height: (element.height || 0) + offset * 2 + extent
  });
};

/**
 * Approximate element-local width the stack "+k" marker reaches past the stack's
 * right edge (its text width plus a small gap), or 0 when there's no marker. Used to
 * size the selection outline so it spans the marker.
 */
Animation.prototype._stackMarkerWidth = function(node) {
  const hidden = this.getStackSize(node) - (this._maxVisible + 1);

  if (hidden <= 0) {
    return 0;
  }

  return ('+' + hidden).length * 7; // ~bold 12px Arial per char; hugs the marker (~3px gap)
};

/**
 * Declare an element's **instance count** and render it as a **stack of its own shape** —
 * the node itself (or, for an implicit process, its box) is the first instance, with the
 * remaining `size - 1` instances as opaque copies peeking out behind it (shifted by
 * `STACK_OFFSET`, capped at `maxVisible`). So **size 1 is a single instance with no
 * copies**, and `0`/`null` clears it. Purely visual & host-driven; never inferred from tokens.
 *
 * The count is declared **per ancestor-instance context**: `ancestorStackIndices` (a map
 * `{ stackedAncestorId: index }`) says *which outer instance this count applies to*, so a
 * nested activity can have a different count under each outer instance. **Contexts are
 * independent** — a count set for one outer instance does *not* leak to others; an unset
 * context has no stack. Omitting `ancestorStackIndices` targets the instance **currently
 * on screen** (pass `{}` to target the base/flat context explicitly). `getStackSize`
 * resolves against whichever instance is on screen.
 *
 * @param {string} node element id
 * @param {number} size instance count (`>= 1` records it; `0`/`null` clears it in this context)
 * @param {Object<string,number>} [ancestorStackIndices] the outer-instance context (omit = current)
 */
Animation.prototype.setStackSize = function(node, size, ancestorStackIndices) {
  this._requireElement(node);

  size = Math.floor(size) || 0;
  // an omitted context targets the instance **currently on screen** (so a host
  // configuring the visible instance needn't recompute it); pass `{}` for the base.
  const context = ancestorStackIndices === undefined ? this._currentContext(node) : ancestorStackIndices;
  const ctxKey = this._contextKey(context);

  // `size` is the **instance count**, uniform across node kinds: `>= 1` records it,
  // `0`/`null` removes. The *first* instance is drawn by whatever already represents the
  // node — a regular node's own shape, or the implicit process's box (T4) — and only the
  // additional `size - 1` instances become offset copies (so size 1 draws no copies).
  if (size >= 1) {
    let sizes = this._stackSizes.get(node);
    if (!sizes) {
      this._stackSizes.set(node, sizes = new Map());
    }
    sizes.set(ctxKey, size);

    let orders = this._stackOrder.get(node);
    if (!orders) {
      this._stackOrder.set(node, orders = new Map());
    }
    orders.set(ctxKey, this._buildOrder(size, orders.get(ctxKey)));
  } else {
    const sizes = this._stackSizes.get(node);
    if (sizes) {
      sizes.delete(ctxKey);
      if (!sizes.size) this._stackSizes.delete(node);
    }
    const orders = this._stackOrder.get(node);
    if (orders) {
      orders.delete(ctxKey);
      if (!orders.size) this._stackOrder.delete(node);
    }
  }

  this._redrawStack(node);
};

/** A display order `[0…size-1]`, preserving an existing order's arrangement where it fits. */
Animation.prototype._buildOrder = function(size, existing) {
  const order = (existing || []).filter(i => i < size);
  for (let i = 0; i < size; i++) {
    if (!order.includes(i)) order.push(i);
  }
  return order;
};

/**
 * Draw the node's stack silhouette + `+k` marker + selection outline for the instance
 * **currently on screen** (`getStackSize` resolved against the current context), and
 * re-render its tokens. Idempotent; called whenever the resolved size/context may change.
 */
Animation.prototype._redrawStack = function(node) {
  const element = this._elementRegistry.get(node);
  const size = this.getStackSize(node);

  // an implicit process (no pool) has no shape to stack — lazily draw/remove our own
  // pool-style box and stack against that (T4). The box is the process frame: drawn for a
  // single instance too (size >= 1), removed only at 0/null.
  if (is(element, 'bpmn:Process')) {
    if (size >= 1) {
      this._ensureProcessBox(element);
    } else {
      this._removeProcessBox();
    }
  }

  const gfx = this._stackGfx(element);

  this._clearStackShapes(gfx); // rebuild from scratch

  const visual = gfx && domQuery('.djs-visual', gfx);

  if (size > 1 && visual) {
    const copies = Math.min(size - 1, this._maxVisible);

    // insert farthest-to-nearest so the real node paints on top and nearer copies over
    // farther ones
    for (let i = 1; i <= copies; i++) {
      const shape = this._cloneNodeVisual(element, gfx);

      svgAttr(shape, 'transform', `translate(${i * STACK_OFFSET}, ${i * STACK_OFFSET})`);
      gfx.insertBefore(shape, gfx.firstChild);
    }
  }

  if (this._selectedNodes.has(node)) {
    this._drawNodeOutline(node, element, gfx);
  }

  // keep the native diagram-js selection outline (if present) sized to the stack
  this._refreshNativeOutline(element);

  this._drawStackMarker(node, element);
  this._renderNode(node);
};

/**
 * Re-run the native outline sizing for `element` after its stack changed, so a selected
 * node's `.djs-outline` (drawn by diagram-js, resized by our OutlineProvider) follows the
 * stack. Skips the implicit-process box (no per-shape gfx; it uses our own outline).
 */
Animation.prototype._refreshNativeOutline = function(element) {
  if (!this._outline || element.width == null || is(element, 'bpmn:Process')) {
    return;
  }

  const gfx = this._elementRegistry.getGraphics(element);
  const outline = gfx && domQuery(':scope > .djs-outline', gfx);

  if (outline) {
    this._outline.updateShapeOutline(outline, element);
  }
};

/**
 * Draw (or remove) the **stack overflow marker** — a plain `+k` text just outside the
 * bottom-right of the stack, where `k = stackSize − (maxVisible + 1)` is the number of
 * instances beyond the drawn cap. Stack-level and independent of tokens; redrawn on
 * every `setStackSize` and removed when the size no longer overflows.
 */
Animation.prototype._drawStackMarker = function(node, element) {
  const existing = this._stackOverlays.get(node);

  if (existing !== undefined) {
    this._overlays.remove(existing);
    this._stackOverlays.delete(node);
  }

  const hidden = this.getStackSize(node) - (this._maxVisible + 1);

  if (hidden <= 0) {
    return;
  }

  const extent = this._stackExtent(node);

  // plain text (no badge circle), unlike the token cluster's `+k`
  const html = domify(`<div class="bts-stack-count" title="${hidden} more instances">+${hidden}</div>`);

  // on the right of the stack, halfway between the node's middle and bottom (a
  // usually-vacant band), pushed clear of the stack silhouette by its extent
  const id = this._overlays.add(element, 'bts-stack-overflow', {
    position: {
      left: (element.width || 0) + extent + 2,
      top: (element.height || 0) * 0.75 - DOT_SIZE / 2
    },
    html,
    show: { minZoom: 0.5 }
  });

  this._stackOverlays.set(node, id);
};

/**
 * The node's instance-stack size **for the instance currently on screen** — resolved
 * against the current ancestor context (the size set for *that* context; contexts are
 * independent, so no fall-back to the base). 0 if none.
 *
 * @param {string} node
 * @return {number}
 */
Animation.prototype.getStackSize = function(node) {
  const sizes = this._stackSizes.get(node);

  if (!sizes) {
    return 0;
  }

  const key = this._contextKey(this._currentContext(node));
  return sizes.get(key) || 0;
};

/**
 * The graphics to stack against. Normally the element's own gfx, but for an implicit
 * **process box** (T4) the element is the root — whose gfx is the *layer* — so we return
 * the pool-style box `<g>` (with the `.djs-visual` we drew) instead.
 */
Animation.prototype._stackGfx = function(element) {
  if (this._processBox && this._processBox.id === element.id) {
    return this._processBox.gfx;
  }
  return this._elementRegistry.getGraphics(element);
};

/** Is `element` the currently-drawn implicit-process box? */
Animation.prototype._isProcessBox = function(element) {
  return !!(this._processBox && element && this._processBox.id === element.id);
};

/**
 * The process box's "content" gfx — the root's flow-node/connection groups, which sit in
 * the active layer beside the box gfx (a bare root has no `.djs-children` wrapper). Used as
 * the scroll snapshot's content + hidden during the gesture.
 */
Animation.prototype._processBoxContent = function() {
  const box = this._processBox;

  if (!box || !box.gfx.parentNode) {
    return [];
  }

  return Array.from(box.gfx.parentNode.children).filter(c => c !== box.gfx);
};

/**
 * The id of the implicit-process box currently drawn (T4), or `null`. The host targets it
 * with the normal stack/token API (it's the `bpmn:Process` id).
 *
 * @return {string|null}
 */
Animation.prototype.getProcessBox = function() {
  return this._processBox ? this._processBox.id : null;
};

/**
 * Ensure a pool-style box exists around an implicit (pool-less) `bpmn:Process` so it can
 * be stacked. Computes bounds from the process's flow nodes, **sets them on the root
 * element** (so all bounds-based code — overlays/anchors/outline/`+k` — works on it), and
 * draws the box gfx into the default layer behind the content. Idempotent; one at a time.
 */
Animation.prototype._ensureProcessBox = function(element) {
  if (this._processBox && this._processBox.id === element.id) {
    return;
  }

  this._removeProcessBox();

  const shapes = (element.children || []).filter(c => !c.waypoints);

  if (!shapes.length) {
    return; // nothing to wrap
  }

  const bb = getBBox(shapes);
  const bounds = {
    x: bb.x - (PROCESS_BOX_BANNER + PROCESS_BOX_PADDING),
    y: bb.y - PROCESS_BOX_PADDING,
    width: bb.width + PROCESS_BOX_BANNER + 2 * PROCESS_BOX_PADDING,
    height: bb.height + 2 * PROCESS_BOX_PADDING
  };

  // save + set the root's bounds (bare roots have none)
  const savedBounds = { x: element.x, y: element.y, width: element.width, height: element.height };
  element.x = bounds.x;
  element.y = bounds.y;
  element.width = bounds.width;
  element.height = bounds.height;

  const gfx = this._drawProcessBox(element);

  this._processBox = { id: element.id, gfx, savedBounds };
};

/** Build + insert the pool-style box gfx (rect + left banner divider + rotated name). */
Animation.prototype._drawProcessBox = function(element) {
  const w = element.width, h = element.height;

  const g = svgCreate('g');
  svgAttr(g, 'class', 'bts-process-box');
  svgAttr(g, 'transform', `translate(${element.x}, ${element.y})`);

  const visual = svgCreate('g');
  svgAttr(visual, 'class', 'djs-visual');

  const rect = svgCreate('rect');
  svgAttr(rect, { x: 0, y: 0, width: w, height: h });
  svgAppend(visual, rect);

  const divider = svgCreate('line');
  svgAttr(divider, { x1: PROCESS_BOX_BANNER, y1: 0, x2: PROCESS_BOX_BANNER, y2: h });
  svgAppend(visual, divider);

  const bo = element.businessObject;
  const name = (bo && (bo.name || bo.id)) || element.id;
  const label = svgCreate('text');
  svgAttr(label, {
    class: 'bts-process-box-label',
    transform: `translate(${PROCESS_BOX_BANNER / 2}, ${h / 2}) rotate(-90)`,
    'text-anchor': 'middle',
    'dominant-baseline': 'central'
  });
  label.textContent = name;
  svgAppend(visual, label);

  svgAppend(g, visual);

  // behind the flow nodes, in the **active root's** layer (where the root's `.djs-children`
  // lives) so it pans/zooms with them and sits beside their container
  const layer = this._canvas.getActiveLayer();
  layer.insertBefore(g, layer.firstChild);

  return g;
};

/** Remove the process box and restore the root's original (bounds-less) state. */
Animation.prototype._removeProcessBox = function() {
  const box = this._processBox;

  if (!box) {
    return;
  }

  const element = this._elementRegistry.get(box.id);

  if (element) {
    const s = box.savedBounds;
    element.x = s.x;
    element.y = s.y;
    element.width = s.width;
    element.height = s.height;
  }

  svgRemove(box.gfx);
  this._processBox = null;
};

/**
 * The node's current front-instance index — `stackOrder[0]` resolved against the current
 * ancestor context (0 if none/unstacked).
 *
 * @param {string} node
 * @return {number}
 */
Animation.prototype.getStackIndex = function(node) {
  const order = this._resolveOrder(node);
  return (order && order[0]) || 0;
};

/**
 * The instance membership a token resting at `node` must carry to belong to the instance
 * **currently on screen**: `{ id: frontIndex }` for `node` itself (when stacked) and each
 * stacked ancestor. Pass it as a token's `stackIndices` (createToken/sendToken) or inside a
 * selector (setState/removeToken/selectToken) so the action targets the **visible** instance
 * instead of the base. `{}` when nothing in the chain is stacked.
 *
 * @param {string} node
 * @return {Object<string,number>}
 */
Animation.prototype.getStackIndices = function(node) {
  this._requireElement(node);

  const indices = this._currentContext(node); // stacked ancestors -> their front index

  if (this.getStackSize(node) > 1) {
    indices[node] = this.getStackIndex(node);
  }

  return indices;
};

/**
 * Jump a stacked node to a given instance (no animation): make `index` the front of the
 * node's display order in its current context. Wraps into range; no-op if not stacked.
 *
 * @param {string} node
 * @param {number} index
 */
Animation.prototype.setStackIndex = function(node, index) {
  this._requireElement(node);

  const size = this.getStackSize(node);

  if (size <= 1) {
    return;
  }

  this.moveToFront(node, ((Math.floor(index) || 0) % size + size) % size);
};

/**
 * Animate the stack scrolling by one — a one-off gesture for "stepping" to the
 * next (`'forward'`) or previous (`'backward'`) instance. It's a **snapshot transition**
 * over clones: snapshot the current instance (A); **rotate the node's display order** by
 * one (front↔back) so the next instance is current; snapshot that (B); hide the real node;
 * animate A out / B in (the recycling clone arcs over the stack — lifts clear, travels
 * across, drops in — while the rest slide one slot); then reveal the real node (now B) and
 * rebuild the canonical stack.
 *
 * Which tokens (at the node and in its scope) show is resolved from the data — each
 * token's `stackIndices` matched against the new front indices — so there is **no
 * callback**. No-op if the node has no stack (or no Web Animations API).
 *
 * @param {string} node element id
 * @param {'forward'|'backward'} [direction='forward']
 * @return {Promise<void>} resolves when the gesture ends
 */
Animation.prototype.scrollStack = function(node, direction = 'forward') {
  const element = this._elementRegistry.get(node);

  if (!element) {
    throw new Error(`unknown node <${node}>`);
  }

  const size = this.getStackSize(node);

  if (size <= 1) {
    return Promise.resolve();
  }

  // The arc gesture animates offset clones on the element's own gfx — its shape on its
  // parent plane (for a collapsed sub-process, the collapsed box). If we're drilled INTO
  // this node (its shape sits on a different plane than the active root), that animation is
  // off-screen, so playing it would only hide the on-plane token overlays for the gesture's
  // duration and snap them back at the end. Swap instantly instead (rotate + re-render).
  const canvas = this._canvas;
  const elementRoot = canvas.findRoot && canvas.findRoot(element);
  const activeRoot = canvas.getRootElement && canvas.getRootElement();

  if (elementRoot && activeRoot && elementRoot !== activeRoot) {
    const order = this._resolveOrder(node);
    if (order) {
      direction === 'backward' ? order.unshift(order.pop()) : order.push(order.shift());
      this._renderStackSubtree(node);
    }
    return Promise.resolve();
  }

  const gfx = this._stackGfx(element);
  const realFront = gfx && gfx.querySelector(':scope > .djs-visual');
  const oldCopies = gfx ? Array.from(gfx.querySelectorAll('.bts-stack-shape')) : [];

  // content to hide during the gesture (the snapshot stands in): a normal container's
  // sibling `.djs-children`, or — for the process box (T4) — the root's flow/connection
  // groups in the layer beside the box gfx
  const isBox = this._isProcessBox(element);
  const realChildren = isBox ? null : (gfx && gfx.parentNode && gfx.parentNode.querySelector(':scope > .djs-children'));
  const contentNodes = isBox ? this._processBoxContent() : [];

  if (!realFront || !oldCopies.length || !realFront.animate) {
    return Promise.resolve();
  }

  const back = direction === 'backward';
  const duration = STACK_SCROLL_DURATION; // fixed UI speed, not the simulation duration
  const off = STACK_OFFSET;
  const n = oldCopies.length;               // animated clones occupy slots 0..n
  const lift = -(element.height + 10);       // clear the body, plus a gap
  const tf = slot => `translate(${slot * off}px, ${slot * off}px)`;

  // Only the two clones that occupy the front carry real content (children + nested):
  // the outgoing current instance (A, slot 0) and the incoming next instance (B, the
  // slot that ends at the front). All other (behind) clones are outline-only ghosts —
  // they represent instances whose content is unknown.
  const incomingSlot = back ? n : 1;

  // snapshot the current instance (A), with content (shapes + token dots), before stepping
  const clones = [ this._cloneNodeVisual(element, gfx, true) ]; // slot 0

  // step the front instance by one: rotate this node's display order (in its current
  // context), then re-render the subtree so B and the landing show the new instance's
  // tokens (resolved from each token's stackIndices — no callback)
  const order = this._resolveOrder(node);
  if (back) {
    order.unshift(order.pop());
  } else {
    order.push(order.shift());
  }
  this._renderStackSubtree(node, false); // gesture owns this node's silhouette

  // build the remaining clones: the incoming slot snapshots B (with content), the rest
  // are outline ghosts
  for (let i = 1; i <= n; i++) {
    clones[i] = this._cloneNodeVisual(element, gfx, i === incomingSlot);
  }

  // token badges are HTML overlays (separate layer) — hide the node's **and its
  // descendants'** for the gesture (the snapshot dots stand in), restore on finish. Read
  // after the commit so we hide the new instance's overlays. The container's own "+k"
  // marker stays (stack-level, count unchanged); descendant "+k" markers hide (their
  // content rides the snapshot).
  const hiddenOverlays = [];
  const collectOverlay = (id, isOwn) => {
    const o = id !== undefined && this._overlays.get(id);
    if (o && o.html) {
      // the **scrolled node's own** flow-cluster overlay is instance-agnostic, so it stays
      // put through the gesture; descendant flow overlays hide (their dots ride the snapshot)
      if (isOwn && o.html.querySelector('.bts-token-count[data-sequence-flow]:not([data-sequence-flow=""])')) {
        return;
      }
      hiddenOverlays.push(o.html);
    }
  };
  for (const [ key, ids ] of this._nodeOverlays) {
    if (key === node || this._isDescendant(key, node)) {
      ids.forEach(id => collectOverlay(id, key === node));
    }
  }
  for (const [ key, id ] of this._stackOverlays) {
    if (this._isDescendant(key, node)) {
      collectOverlay(id, false);
    }
  }

  // all cloning is done (while everything was visible) — now swap the real node and the
  // old static copies out for the animated clones, in one synchronous tick (no flash)
  oldCopies.forEach(c => svgRemove(c));
  realFront.style.display = 'none';
  if (realChildren) {
    realChildren.style.display = 'none';
  }
  contentNodes.forEach(c => { c.style.display = 'none'; });
  hiddenOverlays.forEach(el => { el.style.display = 'none'; });

  // place clones slot n (back) … slot 0 (front, on top)
  for (let i = n; i >= 0; i--) {
    svgAttr(clones[i], 'transform', `translate(${i * off}, ${i * off})`);
    gfx.insertBefore(clones[i], realFront);
  }

  const anims = [];
  const animate = (el, keyframes, easing) =>
    anims.push(el.animate(keyframes, { duration, easing, fill: 'forwards' }));

  const fromS = back ? n : 0;
  const toS = back ? 0 : n;
  const recycler = clones[fromS]; // the clone that arcs across to the far slot

  animate(recycler, [
    { transform: tf(fromS), offset: 0 },
    { transform: `translate(${fromS * off}px, ${lift}px)`, offset: 0.3 },
    { transform: `translate(${toS * off}px, ${lift + (toS - fromS) * off}px)`, offset: 0.6 },
    { transform: tf(toS), offset: 1 }
  ], 'ease-in-out');

  // every other clone slides one slot toward the vacated origin
  for (let i = 0; i <= n; i++) {
    if (i === fromS) {
      continue;
    }
    const to = back ? i + 1 : i - 1;
    animate(clones[i], [ { transform: tf(i) }, { transform: tf(to) } ], 'ease-out');
  }

  // swap the recycler's paint order at the apex — after it lifts clear, before it drops
  const reorder = setTimeout(() => {
    if (back) {
      gfx.insertBefore(recycler, realFront); // on top
    } else {
      gfx.insertBefore(recycler, gfx.firstChild); // behind
    }
  }, duration * 0.45);

  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(reorder);
      anims.forEach(a => a.cancel());

      // reveal the real node (now showing instance B) and rebuild the canonical stack
      // (setStackSize clears all .bts-stack-shape, including these animated clones, and
      // re-renders the token overlay + "+k" marker for the new top)
      realFront.style.display = '';
      if (realChildren) {
        realChildren.style.display = '';
      }
      contentNodes.forEach(c => { c.style.display = ''; });
      hiddenOverlays.forEach(el => { el.style.display = ''; });
      // rebuild the canonical stack (clears the animated clones) + re-render the subtree
      // (descendant stacks may have changed size with the new instance)
      this._renderStackSubtree(node);
      resolve();
    };

    Promise.all(anims.map(a => a.finished)).then(finish, finish);
  });
};

/** An id-stripped deep clone of `.djs-visual` (so it can be placed in the DOM safely). */
Animation.prototype._cloneVisual = function(visual) {
  const clone = visual.cloneNode(true);

  // strip ids (the visual's and any descendants') to avoid duplicates in the DOM
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

  return clone;
};

/**
 * A `<g class="bts-stack-shape">` stack copy of an element — a clone of its
 * `.djs-visual` (the shape silhouette). The static stack uses **outline only** (the
 * silhouette is enough at the small offset). With `withContent`, it also clones the
 * container's **contents** (the *sibling* `.djs-children`, compensated by
 * `translate(-x, -y)` since children carry absolute coords; `.djs-hit`/outlines
 * stripped, nested `.bts-stack-shape` kept; arrowhead `<marker>`s inlined with fresh
 * ids) — used for the `scrollStack` snapshots that show a real instance. Tokens are
 * overlays (separate DOM) and are never cloned.
 */
Animation.prototype._cloneNodeVisual = function(element, gfx, withContent) {
  const group = svgCreate('g');
  svgAttr(group, 'class', 'bts-stack-shape');

  const visual = domQuery('.djs-visual', gfx);

  if (visual) {
    svgAppend(group, this._cloneVisual(visual));
  }

  if (!withContent) {
    return group; // outline only (static stacking)
  }

  // content to clone, compensated by translate(-x,-y) (it carries absolute coords):
  //  - a normal container → its *sibling* `.djs-children`;
  //  - the process box (T4) → the root's flow/connection groups in the layer beside the
  //    box gfx (a bare root has no `.djs-children` wrapper).
  const sources = this._isProcessBox(element)
    ? this._processBoxContent()
    : (() => {
      const childrenGfx = gfx.parentNode && gfx.parentNode.querySelector(':scope > .djs-children');
      return childrenGfx && childrenGfx.childNodes.length ? [ childrenGfx ] : [];
    })();

  if (sources.length) {
    const compensator = svgCreate('g');
    svgAttr(compensator, 'transform', `translate(${-element.x}, ${-element.y})`);

    sources.forEach(src => {
      const clone = this._cloneVisual(src);

      // drop interaction rects + selection outlines (`.djs-outline` is native diagram-js;
      // it would otherwise light up under a selected ancestor's `.selected` marker during
      // the scroll). KEEP nested `.bts-stack-shape` so a snapshot captures stacked children.
      clone.querySelectorAll('.djs-hit, .bts-node-outline, .djs-outline').forEach(el => el.remove());

      svgAppend(compensator, clone);
    });

    svgAppend(group, compensator);
  }

  // connections reference their arrowheads via `marker-end: url(#id)`; a shared <defs>
  // marker doesn't reliably paint on cloned content, so copy each referenced marker
  // with a fresh id into this clone and repoint the reference.
  this._inlineMarkers(group);

  // tokens ride the snapshot: the node's own top token (3c) + its descendants' visible
  // scope tokens (3e)
  this._drawTokenDots(group, element);

  return group;
};

/**
 * Draw the node's currently-visible tokens — at the node and on its descendants — as SVG
 * dots into a snapshot clone so they ride the scroll arc, in the clone's element-local
 * space. Visibility is the resolution rule (`_isVisible`), so only the current instance's
 * tokens are drawn (matching what `_renderNode` shows / what lands). **The scrolled node's
 * own flow-resting tokens are skipped** (they're instance-agnostic for that node, so they
 * stay put), but **descendant flow tokens ride** — they're instance-specific via the
 * scrolled node as an ancestor (e.g. tokens on a sub-process's internal flows).
 */
Animation.prototype._drawTokenDots = function(group, element) {
  const nodes = new Set();

  for (const token of this._tokens.values()) {
    if (!this._isVisible(token)) {
      continue;
    }
    if (token.node === element.id) {
      if (token.state.sequenceFlow) {
        continue; // the scrolled node's own flow token: instance-agnostic, stays put
      }
      nodes.add(token.node);
      continue;
    }
    // a descendant's dot rides the snapshot only if it's drawn on the **same plane** as
    // `element` — a collapsed sub-process's children live on a separate drill plane, so
    // their tokens must not appear on the collapsed-view snapshot
    const de = this._elementRegistry.get(token.node);
    if (de && this._isDescendant(token.node, element.id) && this._coRendered(de, element)) {
      nodes.add(token.node);
    }
  }

  for (const id of nodes) {
    const de = id === element.id ? element : this._elementRegistry.get(id);

    if (!de) {
      continue;
    }

    this._visibleTokensAt(id)
      // the scrolled node's own flow tokens stay put; descendant flow tokens ride
      .filter(t => !(id === element.id && t.state.sequenceFlow))
      .forEach(t => this._appendTokenDot(group, element, de, t));
  }
};

/**
 * Is `de` rendered on the **same plane** as `element` (so its token dots belong on
 * `element`'s scroll snapshot)? A collapsed sub-process's children live on a separate
 * drill plane, reached only by crossing a **drill-plane root** (id !== its businessObject
 * id); crossing one means `de` is on a different plane and must be skipped.
 */
Animation.prototype._coRendered = function(de, element) {
  if (de.id === element.id) {
    return true;
  }

  let el = de.parent;

  while (el) {
    if (el.id === element.id) {
      return true;
    }
    if (el.businessObject && el.id !== el.businessObject.id) {
      return false; // crossed into another plane
    }
    el = el.parent;
  }

  return false;
};

/**
 * Append one `.bts-stack-token` dot for `token` (resting on `tokenElement`) into a clone
 * of `element`, positioned at the token's cluster point translated into `element`-local
 * coordinates (`tokenElement === element` for the at-node token → no offset).
 */
Animation.prototype._appendTokenDot = function(group, element, tokenElement, token) {
  const p = this._clusterPoint(tokenElement, token.state);
  const dot = svgCreate('circle');

  // match the overlay sizing: larger only for an anchored token on a process/activity;
  // flow tokens stay small even there
  const big = !token.state.sequenceFlow && (is(tokenElement, 'bpmn:Activity') || is(tokenElement, 'bpmn:Process'));

  svgAttr(dot, {
    class: 'bts-stack-token',
    r: (big ? DOT_SIZE : MOVING_TOKEN_SIZE) / 2,
    cx: p.x + (tokenElement.x - element.x),
    cy: p.y + (tokenElement.y - element.y),
    fill: token.color
  });

  svgAppend(group, dot);
};

/**
 * Within a cloned group, replace every `marker-{start,mid,end}: url(#id)` reference
 * with a private copy of the referenced `<marker>` (a fresh id, in a local `<defs>`),
 * so the arrowheads render on the clone.
 */
Animation.prototype._inlineMarkers = function(group) {
  const props = [ 'marker-start', 'marker-mid', 'marker-end' ];
  const idMap = new Map(); // original id -> new id (or null if not found)
  let defs = null;

  group.querySelectorAll('*').forEach(el => {
    props.forEach(prop => {
      const fromStyle = el.style && el.style.getPropertyValue(prop);
      const value = fromStyle || (el.getAttribute && el.getAttribute(prop));
      const match = value && /#([^)"']+)/.exec(value);

      if (!match) {
        return;
      }

      const oldId = match[1];
      let newId = idMap.get(oldId);

      if (newId === undefined) {
        const original = document.getElementById(oldId);

        if (original && original.tagName.toLowerCase() === 'marker') {
          newId = 'bts-marker-' + (++MARKER_SEQ);

          const markerClone = original.cloneNode(true);
          markerClone.querySelectorAll('[id]').forEach(d => d.removeAttribute('id'));
          markerClone.setAttribute('id', newId);

          if (!defs) {
            defs = svgCreate('defs');
            svgAppend(group, defs);
          }
          svgAppend(defs, markerClone);
        } else {
          newId = null;
        }

        idMap.set(oldId, newId);
      }

      if (!newId) {
        return;
      }

      const ref = `url(#${newId})`;

      if (fromStyle) {
        el.style.setProperty(prop, ref);
      } else {
        el.setAttribute(prop, ref);
      }
    });
  });
};

Animation.prototype._clearStackShapes = function(gfx) {
  if (!gfx) {
    return;
  }

  gfx.querySelectorAll('.bts-stack-shape').forEach(el => svgRemove(el));
};

Animation.prototype._animateIcon = function(node, direction) {
  const element = this._elementRegistry.get(node);

  if (!element) {
    throw new Error(`unknown node <${node}>`);
  }

  const gfx = this._elementRegistry.getGraphics(element);
  const icons = iconNodes(gfx, element);

  if (!icons.length) {
    return Promise.resolve(); // nothing to animate
  }

  const layer = this._planeLayer(element);

  if (!layer) {
    return Promise.resolve();
  }

  // outer group positions the (element-local) icon over the element;
  // inner group carries the CSS animation
  const outer = svgCreate('g');
  svgAttr(outer, 'transform', `translate(${element.x}, ${element.y})`);

  const inner = svgCreate('g');
  const cls = direction === 'emit' ? 'bts-icon-emit' : 'bts-icon-receive';
  svgAttr(inner, 'class', `bts-icon ${cls}`);
  inner.style.animationDuration = this.getAnimationDuration() + 'ms';

  icons.forEach(shape => {
    const clone = shape.cloneNode(true);
    clone.removeAttribute('id');
    svgAppend(inner, clone);
  });

  svgAppend(outer, inner);
  svgAppend(layer, outer);

  return new Promise(resolve => {
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      svgRemove(outer);
      resolve();
    };

    domEvent.bind(inner, 'animationend', finish);

    // fallback in case animationend doesn't fire (e.g. duration 0)
    setTimeout(finish, this.getAnimationDuration() + 50);
  });
};


// token internals //////////////

Animation.prototype._key = function(node, label, sequenceFlow, stackIndices) {
  return `${node}|${label}|${sequenceFlow || ''}|${this._contextKey(stackIndices)}`;
};

/**
 * Canonical string for an instance map `{ stackedNodeId: index }` — non-zero entries
 * only (omitted/0 = the base/default instance), sorted by node id. So `{}`, `undefined`
 * and `{A:0}` all yield `''` (one canonical identity/context).
 */
Animation.prototype._contextKey = function(indices) {
  return contextKey(indices);
};

/**
 * The current ancestor-instance context of a node: `{ A: getStackIndex(A) }` for each
 * stacked **ancestor** `A` (not the node itself). Resolved against the live front indices.
 */
Animation.prototype._currentContext = function(node) {
  const ctx = {};
  const element = this._elementRegistry.get(node);
  let el = element && element.parent;

  while (el) {
    el = this._shapeOf(el);
    if (this.getStackSize(el.id) > 1) {
      ctx[el.id] = this.getStackIndex(el.id);
    }
    el = el.parent;
  }

  return ctx;
};

/** The display order array for a node in its current context (creating a default if missing). */
Animation.prototype._resolveOrder = function(node) {
  const orders = this._stackOrder.get(node);

  if (!orders) {
    return null;
  }

  const key = this._contextKey(this._currentContext(node));
  return orders.has(key) ? orders.get(key) : null;
};

/** Visible (not filtered out) tokens at a node. */
Animation.prototype._visibleTokensAt = function(node) {
  const set = this._nodeTokens.get(node);

  if (!set) {
    return [];
  }

  return Array.from(set).filter(t => this._isVisible(t));
};

/** All tokens at `(node, label)` regardless of rest flow. */
Animation.prototype._find = function(node, label) {
  const matches = [];

  for (const token of this._tokens.values()) {
    if (token.node === node && token.label === label) {
      matches.push(token);
    }
  }

  return matches;
};

Animation.prototype._setTokenSelected = function(node, label, selector, selected) {
  label = String(label);

  const sel = selector || {};
  const token = this._tokens.get(this._key(node, label, sel.sequenceFlow, sel.stackIndices || {}));

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sel.sequenceFlow ? ` on <${sel.sequenceFlow}>` : ''}`);
  }

  token.selected = selected;
  this._renderNode(node);

  return token;
};

Animation.prototype._requireElement = function(node) {
  if (!this._elementRegistry.get(node)) {
    throw new Error(`unknown node <${node}>`);
  }
};

/**
 * Bridge a collapsed sub-process's **drill-plane root** to its **shape element**. The
 * children of a collapsed sub-process hang off a separate root element whose id is
 * `<subprocess>_plane` (so `el.id !== el.businessObject.id`) and whose `parent` is null —
 * but the *shape* that gets stacked lives on the parent plane under the businessObject's
 * id. Mapping the plane root to that shape lets ancestor/descendant walks cross the
 * boundary (so stacking a collapsed sub-process governs its drilled-in children). A plain
 * element (`el.id === el.businessObject.id`) is returned unchanged.
 */
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

/**
 * Double-click handler (when `scrollOnDoubleClick` is enabled): scroll a stacked node's
 * instances — forward, or backward with Shift. Skips connections and non-stacked nodes;
 * maps a drilled-into plane root to its shape so the implicit-process root and collapsed
 * sub-processes scroll too.
 */
Animation.prototype._scrollOnDoubleClick = function(event) {
  let el = event.element;

  if (!el || el.waypoints || !el.businessObject) {
    return;
  }

  el = this._shapeOf(el);

  if (this.getStackSize(el.id) <= 1) {
    return;
  }

  const dir = event.originalEvent && event.originalEvent.shiftKey ? 'backward' : 'forward';
  this.scrollStack(el.id, dir);
};

/**
 * Token-click handler (when `selectTokenOnClick` is enabled): select the clicked token
 * (blue ring). A plain click makes it the **sole** selection (clicking the sole selection
 * clears it); Shift toggles it within the current selection.
 */
Animation.prototype._selectOnClick = function(event) {
  const { node, label } = event;
  const sequenceFlow = event.sequenceFlow || undefined;
  const stackIndices = event.stackIndices;
  const selector = { sequenceFlow, stackIndices };

  const key = this._key(node, label, sequenceFlow, stackIndices || {});
  const token = this.getTokens(t =>
    this._key(t.node, t.label, t.state.sequenceFlow, t.stackIndices) === key)[0];

  if (!token) {
    return;
  }

  const additive = event.originalEvent && event.originalEvent.shiftKey;

  if (additive) {
    token.selected ? this.deselectToken(node, label, selector) : this.selectToken(node, label, selector);
    return;
  }

  // plain click: clear the rest, select this — unless it was the sole selection (toggle off)
  const selected = this.getTokens(t => t.selected);
  const wasSole = selected.length === 1 && token.selected;

  selected.forEach(t => {
    if (t !== token) {
      this.deselectToken(t.node, t.label, { sequenceFlow: t.state.sequenceFlow || undefined, stackIndices: t.stackIndices });
    }
  });

  // toggle the clicked token: clears it if it was the sole selection, otherwise selects it
  if (wasSole) {
    this.deselectToken(node, label, selector);
  } else {
    this.selectToken(node, label, selector);
  }
};

/** Is `childId` nested (at any depth) inside `ancestorId`? */
Animation.prototype._isDescendant = function(childId, ancestorId) {
  const child = this._elementRegistry.get(childId);
  let el = child && child.parent;

  while (el) {
    el = this._shapeOf(el);
    if (el.id === ancestorId) {
      return true;
    }
    el = el.parent;
  }

  return false;
};

Animation.prototype._resolveFlow = function(node, sequenceFlowId) {
  const connection = this._elementRegistry.get(sequenceFlowId);

  if (!connection) {
    throw new Error(`unknown sequence flow <${sequenceFlowId}>`);
  }

  if (!connection.waypoints || !connection.source || !connection.target) {
    throw new Error(`<${sequenceFlowId}> is not a routable connection`);
  }

  // outgoing flow -> forward to its target
  if (connection.source.id === node) {
    return {
      connection,
      toNode: connection.target.id,
      waypoints: connection.waypoints
    };
  }

  // incoming flow -> reverse to its source (e.g. rewinding a step)
  if (connection.target.id === node) {
    return {
      connection,
      toNode: connection.source.id,
      waypoints: connection.waypoints.slice().reverse()
    };
  }

  throw new Error(`<${sequenceFlowId}> is not connected to <${node}>`);
};

/**
 * A token is visible iff the host `_filter` passes **and**, for every stacked node `A`
 * in the token's node + ancestors, the token's recorded instance for `A` equals `A`'s
 * current front index — `(stackIndices[A] ?? 0) === getStackIndex(A)`. Non-stacked nodes
 * aren't checked, so flat/`stackSize<=1` tokens are always (filter-)visible.
 *
 * **A token resting on a sequence flow ignores its own node's stack index** — only its
 * *ancestor* instances gate it. A flow is drawn to the stack as a whole (not one
 * instance), so a token in transit shows regardless of which instance of its end node is
 * front; the host commits it into a specific instance afterwards (createToken/removeToken,
 * or setState with the full stackIndices).
 */
Animation.prototype._isVisible = function(token) {
  if (this._filter && !this._filter(token)) {
    return false;
  }

  const onFlow = !!token.state.sequenceFlow;
  let el = this._elementRegistry.get(token.node);
  let ownNode = true;

  while (el) {
    el = this._shapeOf(el);
    if (!(onFlow && ownNode) && this.getStackSize(el.id) > 1) {
      const want = (token.stackIndices && token.stackIndices[el.id]) || 0;
      if (want !== this.getStackIndex(el.id)) {
        return false;
      }
    }
    ownNode = false;
    el = el.parent;
  }

  return true;
};

Animation.prototype._planeLayer = function(element) {
  const canvas = this._canvas;

  // bpmn-js@9+ : the plane layer for the element's root; else the viewport
  if ('findRoot' in canvas) {
    const root = canvas.findRoot(element);
    return root ? canvas._findPlaneForRoot(root).layer : null;
  }

  return domQuery('.viewport', canvas._svg);
};

Animation.prototype._settle = function(token) {
  const movement = this._activeAnimations.get(token);

  // finish() synchronously runs the done callback (lands the token at its
  // target, re-renders, clears the active-animation entry)
  if (movement) {
    movement.finish();
  }
};

Animation.prototype._addToNode = function(token, node) {
  let set = this._nodeTokens.get(node);

  if (!set) {
    set = new Set();
    this._nodeTokens.set(node, set);
  }

  // one token per identity (label + rest flow) at a node
  const id = identityOf(token);

  for (const t of set) {
    if (identityOf(t) === id) {
      set.delete(t);
    }
  }

  set.add(token);
};

Animation.prototype._removeFromNode = function(token, node) {
  const set = this._nodeTokens.get(node);

  if (!set) {
    return;
  }

  const id = identityOf(token);

  for (const t of set) {
    if (identityOf(t) === id) {
      set.delete(t);
    }
  }

  if (!set.size) {
    this._nodeTokens.delete(node);
  }
};

Animation.prototype._renderNode = function(node) {

  // tear down this node's existing cluster overlays
  const existing = this._nodeOverlays.get(node);

  if (existing) {
    existing.forEach(id => this._overlays.remove(id));
    this._nodeOverlays.delete(node);
  }

  const set = this._nodeTokens.get(node);

  if (!set || !set.size) {
    return;
  }

  const element = this._elementRegistry.get(node);

  if (!element || element.width == null) {
    return; // no element, or a bare process root with no box yet (no bounds to anchor on)
  }

  // group tokens that rest at the same location (anchor or flow). A stacked node's
  // non-front-instance tokens are simply not visible (the resolution rule), so this
  // naturally shows only the current instance's tokens.
  const clusters = new Map();

  for (const token of set) {
    if (!this._isVisible(token)) {
      continue; // filtered out / not this instance — not drawn, doesn't count toward the cap
    }

    // queue tokens that resolve to the same point (so equivalent specs cluster together)
    let key;
    if (token.state.sequenceFlow) {
      key = `flow:${token.state.sequenceFlow}`;
    } else {
      const p = anchorPoint(token.state.position, element);
      key = `pos:${Math.round(p.x)},${Math.round(p.y)}`;
    }

    let list = clusters.get(key);

    if (!list) {
      list = [];
      clusters.set(key, list);
    }

    list.push(token);
  }

  const overlayIds = [];
  const max = this._maxVisible;
  // a process/activity carries larger dots; flows, events and gateways carry the smaller
  // (moving-token) size — so a dot doesn't cover an event/gateway's type symbol
  const onActivity = is(element, 'bpmn:Activity') || is(element, 'bpmn:Process');

  for (const tokens of clusters.values()) {

    // anchored token on a process/activity → larger; flow tokens stay small even there
    const big = !tokens[0].state.sequenceFlow && onActivity;

    // cap per cluster; show all when overflow would be just one
    let visible = tokens;
    let hidden = [];

    if (tokens.length > max + 1) {
      visible = tokens.slice(0, max);
      hidden = tokens.slice(max);
    }

    const dots = visible.map(t => this._dotHTML(t, big)).join('');
    const marker = hidden.length ? this._markerHTML(hidden.length, big) : '';

    const html = domify(`<div class="bts-token-count-parent">${dots}${marker}</div>`);

    const hiddenRefs = hidden.map(t => ({ node: t.node, label: t.label, stackIndices: t.stackIndices }));

    domEvent.bind(html, 'click', event => {
      const el = domClosest(event.target, '.bts-token-count', true);

      if (!el) {
        return;
      }

      if (domClasses(el).has('bts-overflow')) {
        this._eventBus.fire('token.overflow.click', { node, hidden: hiddenRefs, originalEvent: event });
      } else {
        let stackIndices = {};
        try {
          stackIndices = JSON.parse(el.dataset.stackIndices || '{}');
        } catch (e) { /* keep {} */ }

        this._eventBus.fire('token.click', {
          node,
          label: el.dataset.label,
          sequenceFlow: el.dataset.sequenceFlow || null,
          stackIndices,
          originalEvent: event
        });
      }

      if ('focus' in this._canvas) {
        this._canvas.focus();
      }
    });

    const point = this._clusterPoint(element, tokens[0].state);
    const size = big ? DOT_SIZE : MOVING_TOKEN_SIZE;

    const id = this._overlays.add(element, 'bts-token-count', {
      position: { left: point.x - size / 2, top: point.y - size / 2 },
      html,
      show: { minZoom: 0.5 }
    });

    overlayIds.push(id);
  }

  this._nodeOverlays.set(node, overlayIds);
};

/**
 * Element-local point (relative to the element's top-left) at which a cluster of
 * tokens with the given state should be anchored.
 */
Animation.prototype._clusterPoint = function(element, state) {
  if (state.sequenceFlow) {
    const connection = this._elementRegistry.get(state.sequenceFlow);

    if (connection && connection.waypoints && connection.waypoints.length) {
      const atSource = connection.source && connection.source.id === element.id;
      const wp = atSource
        ? connection.waypoints[0]
        : connection.waypoints[connection.waypoints.length - 1];

      return { x: wp.x - element.x, y: wp.y - element.y };
    }
  }

  return anchorPoint(state.position || DEFAULT_POSITION, element);
};

Animation.prototype._dotHTML = function(token, big) {
  const { position, sequenceFlow, bounce } = token.state;

  return `
    <div class="bts-token-count waiting${bounce ? ' bts-bounce' : ''}${token.selected ? ' bts-selected' : ''}${big ? ' bts-on-activity' : ''}"
         data-node-id="${escape(token.node)}"
         data-label="${escape(token.label)}"
         data-left="${escape(position ? position.left : '')}"
         data-top="${escape(position ? position.top : '')}"
         data-hoffset="${escape(position ? position.hoffset : '')}"
         data-voffset="${escape(position ? position.voffset : '')}"
         data-sequence-flow="${escape(sequenceFlow || '')}"
         data-stack-indices="${escape(JSON.stringify(token.stackIndices || {}))}"
         data-bounce="${bounce}"
         data-selected="${!!token.selected}"
         title="${escape(token.label)}"
         style="background: ${token.color};"></div>
  `;
};

Animation.prototype._markerHTML = function(count, big) {
  return `
    <div class="bts-token-count bts-overflow${big ? ' bts-on-activity' : ''}" title="${count} more">+${count}</div>
  `;
};


// low-level token movement (drives sendToken) //////////////

/**
 * Animate a token graphic along a connection's waypoints.
 *
 * @param {{ waypoints: Array<{x,y}> }} connection
 * @param {{ color: string, element: Object }} token
 * @param {Function} [done]
 * @return {TokenAnimation}
 */
Animation.prototype._move = function(connection, token, done = noop, duration = this._duration) {
  const group = this._movementGroup(token);

  if (!group) {
    return;
  }

  const gfx = svgAppendTo(svgCreate(movingTokenSVG(token).trim()), group);

  const movement = new TokenAnimation(gfx, connection.waypoints, duration, () => {
    this._stopMovement(movement);
    done();
  });

  this._movements.add(movement);
  movement.play();

  return movement;
};

Animation.prototype._stopMovement = function(movement) {
  movement.remove();
  this._movements.delete(movement);
};

Animation.prototype._movementGroup = function(token) {
  const layer = this._planeLayer(token.element);

  if (!layer) {
    return null;
  }

  let group = domQuery('.bts-animation-tokens', layer);

  if (!group) {
    group = svgCreate('<g class="bts-animation-tokens" />');
    svgAppendTo(group, layer);
  }

  return group;
};


// helpers //////////////

/**
 * Identity within a node: label + rest flow + instance (so same-label tokens in different
 * instances coexist in the node's render set; anchor tokens share an empty flow).
 */
function identityOf(token) {
  return `${token.label}|${token.state.sequenceFlow || ''}|${contextKey(token.stackIndices)}`;
}

/** Standalone `_contextKey` (for `identityOf`, which has no `this`). */
function contextKey(indices) {
  if (!indices) {
    return '';
  }
  return Object.keys(indices).filter(id => indices[id]).sort().map(id => `${id}:${indices[id]}`).join(',');
}

/**
 * The element's icon geometry to clone for `throwIcon`/`catchIcon`. Only two node
 * kinds carry a flyable icon:
 *
 * - a **`bpmn:Task`** — its top-left **type icon** (user/service/send/receive/… glyph,
 *   typically several `<path>`s). Other activity kinds (sub-process, call activity, …)
 *   have no type icon, so nothing flies; their markers and indicator boxes stay put.
 * - a **`bpmn:Event`** — its centered symbol (timer, message, signal, …).
 *
 * Everything else (gateways, data objects, the process box, …) has no icon → `[]`.
 *
 * Within a task we drop the full-size body/outline (bbox ≈ the whole element) and every
 * **marker** — multi-instance (`‖`/`≡`), loop (`↻`), compensation, ad-hoc — which
 * bpmn-js tags with a `data-marker` attribute; the un-tagged remainder is the icon.
 * Events have no markers, so only the body/outline is dropped (unchanged behavior).
 * Shapes are matched by **size, not tag**, so an icon drawn with a path, circle, rect,
 * polygon, etc. is all picked up.
 */
function iconNodes(gfx, element) {
  if (!gfx || !element.businessObject) {
    return [];
  }

  const isTask = is(element, 'bpmn:Task');
  const isEvent = is(element, 'bpmn:Event');

  if (!isTask && !isEvent) {
    return [];
  }

  const w = element.width || 0;
  const h = element.height || 0;

  const shapes = gfx.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line');

  return Array.from(shapes).filter(el => {

    // drop markers (multi-instance / loop / compensation / ad-hoc) — tagged by bpmn-js
    if (el.closest && el.closest('[data-marker]')) {
      return false;
    }

    let bbox;

    try {
      bbox = el.getBBox();
    } catch (e) {
      return true; // can't measure -> keep it
    }

    // drop the body/outline (spans nearly the whole element)
    return !(w && h && bbox.width >= 0.8 * w && bbox.height >= 0.8 * h);
  });
}

function movingTokenSVG(token) {
  const color = token.color || DEFAULT_COLOR;
  const c = MOVING_TOKEN_SIZE / 2;

  // selected in-flight token: a blue ring offset from the dot, matching the
  // resting badge's outline (radius = dot + ~gap, so a small gap shows through)
  const ring = token.selected
    ? `<circle class="bts-token-ring" r="${c + 3}" cx="${c}" cy="${c}" />`
    : '';

  return `
    <g class="bts-token">
      <circle class="bts-circle" r="${c}" cx="${c}" cy="${c}" fill="${ color }" />
      ${ring}
    </g>
  `;
}

/**
 * Normalize a position spec to `{ left, top, hoffset, voffset }`. `left`/`top` are
 * **fractions** of the shape (0 = left/top edge, 1 = right/bottom, may exceed; default
 * center `0.5`); `hoffset`/`voffset` are **pixel** nudges added on top (default 0). So a
 * point = a proportional anchor plus a constant offset, e.g. `{ left: 0.5, top: 1,
 * voffset: 20 }` is 20px below the bottom-center.
 */
function validatePosition(position) {
  if (typeof position === 'string') {
    throw new Error(`position is now an object { left, top, hoffset?, voffset? } (got string <${position}>)`);
  }
  if (typeof position !== 'object' || position === null) {
    throw new Error('position must be an object { left, top, hoffset?, voffset? }');
  }

  return {
    left: position.left != null ? position.left : 0.5,
    top: position.top != null ? position.top : 0.5,
    hoffset: position.hoffset || 0,
    voffset: position.voffset || 0
  };
}

/** Full state with defaults filled in (for createToken / sendToken landing). */
function normalizeState(state) {
  state = state || {};

  if (state.position != null && state.sequenceFlow != null) {
    throw new Error('state.position and state.sequenceFlow are mutually exclusive');
  }

  let position = null;
  let sequenceFlow = null;

  if (state.sequenceFlow != null) {
    sequenceFlow = String(state.sequenceFlow);
  } else if (state.position != null) {
    position = validatePosition(state.position);
  } else {
    position = { ...DEFAULT_POSITION };
  }

  return {
    position,
    sequenceFlow,
    bounce: state.bounce != null ? !!state.bounce : DEFAULT_BOUNCE
  };
}

/** Partial merge for setState: position/sequenceFlow stay mutually exclusive, bounce independent. */
function mergeState(current, patch) {
  if (patch.position != null && patch.sequenceFlow != null) {
    throw new Error('state.position and state.sequenceFlow are mutually exclusive');
  }

  const next = {
    position: current.position,
    sequenceFlow: current.sequenceFlow,
    bounce: current.bounce
  };

  if (patch.position != null) {
    next.position = validatePosition(patch.position);
    next.sequenceFlow = null;
  }

  if (patch.sequenceFlow != null) {
    next.sequenceFlow = String(patch.sequenceFlow);
    next.position = null;
  }

  if (patch.bounce != null) {
    next.bounce = !!patch.bounce;
  }

  return next;
}

function anchorPoint(position, element) {
  return {
    x: position.left * element.width + position.hoffset,
    y: position.top * element.height + position.voffset
  };
}

function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ──────────────────────────────────────────────────────────────────────────────
// Low-level token animator — adapted from bpmn-js-token-simulation (MIT, Camunda
// Services GmbH): lib/animation/Animation.js. Moves an SVG node along a path's
// waypoints over a fixed duration with per-segment easing. Everything ABOVE this
// banner is specific to this package; keep edits below minimal so upstream fixes
// can be re-applied.
// ──────────────────────────────────────────────────────────────────────────────

function getSegmentEasing(index, waypoints) {
  if (waypoints.length === 2) {
    return EASE_IN_OUT;
  }
  if (index === 1) {
    return EASE_IN;
  }
  if (index === waypoints.length - 1) {
    return EASE_OUT;
  }
  return EASE_LINEAR;
}

const EASE_LINEAR = pos => pos;
const EASE_IN = pos => -Math.cos(pos * Math.PI / 2) + 1;
const EASE_OUT = pos => Math.sin(pos * Math.PI / 2);
const EASE_IN_OUT = pos => -Math.cos(pos * Math.PI) / 2 + 0.5;

/**
 * @param {SVGElement} gfx
 * @param {Array<{x:number,y:number}>} waypoints
 * @param {number} duration fixed total duration (ms); use 0 for an instant jump
 * @param {Function} done
 */
function TokenAnimation(gfx, waypoints, duration, done) {
  this.gfx = gfx;
  this.waypoints = waypoints;
  this.done = done;
  this._duration = duration;

  this._paused = true;
  this._t = 0;
  this._parts = [];

  this.create();
}

TokenAnimation.prototype.pause = function() {
  this._paused = true;
};

TokenAnimation.prototype.play = function() {
  if (this._paused) {
    this._paused = false;
    this.tick(0);
  }
  this.schedule();
};

TokenAnimation.prototype.schedule = function() {
  if (this._paused || this._scheduled) {
    return;
  }

  const last = Date.now();
  this._scheduled = true;

  requestAnimationFrame(() => {
    this._scheduled = false;

    if (this._paused) {
      return;
    }

    this.tick(Date.now() - last);
    this.schedule();
  });
};

TokenAnimation.prototype.tick = function(tElapsed) {
  const t = this._t = this._t + tElapsed;

  const part = this._parts.find(p => p.startTime <= t && p.endTime > t);

  if (!part) {
    return this.completed();
  }

  const segmentTime = t - part.startTime;
  const segmentLength = part.length * part.easing(segmentTime / part.duration);
  const point = this._path.getPointAtLength(part.startLength + segmentLength);

  this.move(point.x, point.y);
};

TokenAnimation.prototype.move = function(x, y) {
  svgAttr(this.gfx, 'transform', `translate(${x}, ${y})`);
};

TokenAnimation.prototype.create = function() {
  const waypoints = this.waypoints;

  const parts = waypoints.reduce((parts, point, index) => {
    const lastPoint = waypoints[index - 1];

    if (lastPoint) {
      const lastPart = parts[parts.length - 1];
      const startLength = lastPart && lastPart.endLength || 0;
      const length = distance(lastPoint, point);

      parts.push({
        startLength,
        endLength: startLength + length,
        length,
        easing: getSegmentEasing(index, waypoints)
      });
    }

    return parts;
  }, []);

  const totalLength = parts.reduce((length, part) => length + part.length, 0);

  const d = waypoints.reduce((d, waypoint, index) => {
    const x = waypoint.x - MOVING_TOKEN_SIZE / 2,
          y = waypoint.y - MOVING_TOKEN_SIZE / 2;

    d.push([ index > 0 ? 'L' : 'M', x, y ]);

    return d;
  }, []).flat().join(' ');

  // fixed total time, independent of length; distributed across segments by
  // length so the token moves at a steady speed along the path
  const totalDuration = this._duration;

  this._parts = parts.reduce((parts, part, index) => {
    const duration = totalDuration / totalLength * part.length;
    const startTime = index > 0 ? parts[index - 1].endTime : 0;
    const endTime = startTime + duration;

    return [ ...parts, { ...part, startTime, endTime, duration } ];
  }, []);

  this._path = svgCreate(`<path d="${d}" />`);
  this._t = 0;
};

TokenAnimation.prototype.show = function() {
  svgAttr(this.gfx, 'display', '');
};

TokenAnimation.prototype.hide = function() {
  svgAttr(this.gfx, 'display', 'none');
};

TokenAnimation.prototype.completed = function() {
  if (this._done) {
    return;
  }
  this._done = true;
  this.done();
};

/** Fast-forward to the end immediately, firing completion exactly once. */
TokenAnimation.prototype.finish = function() {
  this.pause();
  this.completed();
};

TokenAnimation.prototype.remove = function() {
  this.pause();
  svgRemove(this.gfx);
};

function distance(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}
