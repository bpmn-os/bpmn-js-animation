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

// window (ms) within which two clicks on the same token count as a double-click. We synthesize
// `token.dblclick` from clicks rather than binding the native event: selecting on click re-renders
// the node (replacing the dot), so a native dblclick never sees two clicks on the same element.
const DOUBLE_CLICK_MS = 350;

// diagonal shift (px, down-right) between successive shapes in an instance stack
const STACK_OFFSET = 4;

// implicit-process box (T4): left label banner width + padding around the content
const PROCESS_BOX_BANNER = 30;
const PROCESS_BOX_PADDING = 45;

// the stack scroll is UI feedback, not simulation — a fixed speed (ms), independent
// of the (simulation) animationDuration that drives token movement / icons
const STACK_SCROLL_DURATION = 600;

// counter for the fresh marker ids minted when cloning connections (see _inlineMarkers)
let MARKER_SEQ = 0;

// default rest state — centered on the shape, bouncing
const DEFAULT_POSITION = { left: 0.5, top: 0.5, hoffset: 0, voffset: 0 };

// last-resort px to drop the sweep row when neither edge can hold the token clear of a boundary
// symbol (see `_sweepLayout` — the row is shifted down on its current edge so the dots don't sit
// under the symbols)
const BOUNDARY_VOFFSET = 20;

// boundary-avoidance tuning (named constants, tuned by visual inspection):
// - SWEEP_DOT_CLEARANCE: extra px beyond the dot radius kept between a resting badge and a boundary
//   symbol, so the two never touch;
// - SWEEP_MIN_ADVANCE: the smallest gap between two consecutive sweep stops, so a nudged stop still
//   reads as a real left-to-right advance rather than landing on top of the previous one.
const SWEEP_DOT_CLEARANCE = 2;
const SWEEP_MIN_ADVANCE = 20;
const SWEEP_EPS = 0.5; // tiny nudge to land just clear of a zone / strictly past the previous stop

function noop() {}

/**
 * @typedef { {
 *   position: { left, top, hoffset, voffset } | null, // left/top = fraction of the shape
 *                                   //   (default 0.5), hoffset/voffset = px (default 0);
 *                                   //   mutually exclusive with sequenceFlow
 *   sequenceFlow: string | null,   // a connected sequence flow id (rest on it)
 *   animate: string | null,        // a motion-cue effect name (-> `.bts-anim-<name>`), or null
 *   hidden: boolean                // park the dot (kept in the model, CSS display:none)
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
 *    `(node, label, sequenceFlow)`; its `state` ({ position | sequenceFlow, animate, hidden })
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
export default function Primitives(config, eventBus, canvas, overlays, elementRegistry, outline) {

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
      if (this._stackSize(element.id) <= 1) {
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
  this._selectedNodes = new Set();     // node ids with a selection outline
  // per-instance state, keyed by ancestor-instance context (see _contextKey): a node's ordered
  // instance keys per outer-instance context (front first); size = the key count
  this._stackOrder = new Map();        // node -> Map<contextKey, key[]>  (instance keys, front first)
  this._stackOverlays = new Map();     // node -> overlayId for the "+k hidden instances" marker
  this._stackAnims = new Map();        // node -> finish() for an in-flight stack-step gesture
  this._processBox = null;             // { id, gfx, savedBounds } for an implicit-process box (T4)
  this._dimmedFlows = new Set();       // sequence-flow ids currently dimmed (.bts-dim)
  this._loopNodes = new Set();         // loop activities with a dimmed marker / loop-toggle hit rect

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

Primitives.$inject = [
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
 * @param {Partial<TokenState>} [state] rest state (default: centered, still)
 * @param {Object<string,number>} [stackIndices] which instance of each stacked ancestor
 *   (and the node itself if stacked) this token belongs to; omit unless the node or an
 *   ancestor is stacked.
 * @return {Token}
 */
Primitives.prototype.createToken = function(node, label, color, state, stackIndices) {
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
  const existing = this._head(key);

  if (existing) {
    existing.color = color;
    existing.state = normalized;
    this._renderNode(node);
    this._eventBus.fire('token.updated', { token: existing });

    return existing;
  }

  const token = { node, label, color, state: normalized, selected: false, stackIndices: indices };

  this._pushToken(key, token);
  this._addToNode(token, node);
  this._renderNode(node);
  this._eventBus.fire('token.added', { token });

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
Primitives.prototype.sendToken = function(transitions) {
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
    const fromNode = token.node;              // source node (for the token.moved event)
    const indices = token.stackIndices;       // a move stays in the same instance
    const sequenceFlow = token.state.sequenceFlow;
    this._dropToken(this._key(token.node, token.label, sequenceFlow, indices), token);
    this._removeFromNode(token, token.node);
    this._renderNode(token.node);

    // lands resting on the SAME flow at the far node (host anchors it later via setState)
    const state = normalizeState({ sequenceFlow, animate: token.state.animate });
    const destKey = this._key(toNode, token.label, sequenceFlow, indices);
    const selected = !!token.selected;

    const branch = { node: toNode, label: token.label, color: token.color, state, selected, stackIndices: indices };

    // optimistic identity: addressable at the destination right away (queued if one already rests there)
    this._pushToken(destKey, branch);

    // announce the node change synchronously, so UI can update the moved token in place — find its
    // entry by the old node and retag it to the new node (no guessing across same-label tokens)
    this._eventBus.fire('token.moved', { token: branch, label: token.label, from: fromNode, to: toNode, stackIndices: indices });

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
 * clears `sequenceFlow` and vice versa; `animate`/`hidden` are independent. The `selector`
 * (`{ sequenceFlow?, stackIndices? }`) picks which token when several same-label tokens
 * rest at the node (different rest flows or instances). Changing the rest flow/position
 * rekeys (merging into any token already at the new identity — this is how a join
 * completes). Crossing the **flow↔anchor** boundary adjusts the token's own-node stack
 * index: anchoring a flow-resting token (sequenceFlow → position) commits it into the
 * node's **currently-visible** instance (`stackIndices[node] = getCurrentStack(node)`);
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
Primitives.prototype.setState = function(node, label, state, selector) {
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
Primitives.prototype.glideToState = function(node, label, state, selector, via) {
  return new Promise(resolve => {
    this._setState(node, label, state, selector, resolve, via);
  });
};

// setState's body, with an `onSettled(token)` hook called once the token is at rest
// (immediately, or in the glide's done callback). setState ignores it; glideToState
// resolves its promise with it. `via` adds intermediate glide waypoints (see above).
Primitives.prototype._setState = function(node, label, state, selector, onSettled = noop, via) {
  label = String(label);

  const sel = selector || {};
  const indices = sel.stackIndices || {};
  const oldKey = this._key(node, label, sel.sequenceFlow, indices);
  const token = this._head(oldKey);

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

  this._dropToken(oldKey, token);
  this._removeFromNode(token, node);

  const prevFlow = token.state.sequenceFlow;
  token.state = mergeState(token.state, state || {});
  const nowFlow = token.state.sequenceFlow;

  // crossing the flow<->anchor boundary commits the token into / releases it from this
  // node's stack instance: a flow token is instance-agnostic for its own node (only
  // ancestors gate it), an anchored token belongs to a specific instance. So anchoring
  // (flow -> position) joins the instance **currently on screen**; stepping onto a flow
  // drops the own-node index.
  if (this._stackSize(node) > 1) {
    if (prevFlow && !nowFlow) {
      token.stackIndices = { ...token.stackIndices, [node]: this.getCurrentStack(node) };
    } else if (!prevFlow && nowFlow) {
      token.stackIndices = { ...token.stackIndices };
      delete token.stackIndices[node];
    }
  }

  // rekeying onto an occupied identity **queues** the token there (FIFO) — concurrent same-instance
  // paths converging at a node coexist as a stack of homogeneous dots rather than collapsing. (An
  // explicit gateway join is `joinTokens`/`mergeTokens`, which removes the branches itself.)
  const newKey = this._key(node, label, token.state.sequenceFlow, token.stackIndices);
  this._pushToken(newKey, token);

  // a same-node state change (phase, rest flow, …) — let UI update this token's row in place
  this._eventBus.fire('token.updated', { token });

  // glide the dot from its old rest point to the new one (cosmetic — the model is already
  // updated, so the token is addressable immediately). Skip when instant (duration 0), the
  // resting point didn't move (e.g. an animate-only change), or the token isn't on screen —
  // either **parked** (`state.hidden`) or on a **back-stack instance** (`_isVisible` false). An
  // off-screen glide would show a moving graphic and re-render the node mid-glide, jostling the
  // visible instance's dots; jump instantly instead so the token repositions unseen.
  const to = canAnimate ? this._clusterPoint(element, token.state) : null;
  const moved = from && to && (Math.round(from.x) !== Math.round(to.x) || Math.round(from.y) !== Math.round(to.y));

  if (this._duration > 0 && moved && !token.state.hidden && this._isVisible(token)) {
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
      // tracked so `_syncMovements` can hide this dot if the front instance changes mid-glide (the glide
      // only starts for the on-screen instance — a back instance jumps instead, see the skip above)
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
Primitives.prototype.removeToken = function(node, label, selector, gesture) {
  label = String(label);

  const sel = selector || {};
  const key = this._key(node, label, sel.sequenceFlow, sel.stackIndices || {});
  const token = this._head(key); // FIFO: remove the first-arrived of a queued slot

  if (!token) {
    return Promise.resolve();
  }

  // for a gestured removal (flip-fade on consume): clone the live dot into a detached **ghost** NOW,
  // before we drop the identity and re-render. The ghost lives in its own layer — independent of
  // `_renderNode`, so it survives concurrent re-renders — and self-removes when its effects finish.
  // The model identity goes immediately (synchronous); the **returned Promise** resolves when the
  // flip-fade has finished — so a caller can sequence a container teardown (a process box / stack
  // collapse) *after* the dot has faded, while still not blocking the synchronous model removal.
  // Skipped at `animationDuration: 0` — there's no visible gesture, so removal is fully instant.
  const ghost = (gesture && gesture.length && this._duration > 0) ? this._ghostFor(token) : null;

  const movement = this._activeAnimations.get(token);

  if (movement) {
    this._stopMovement(movement);
    this._activeAnimations.delete(token);
  }

  this._dropToken(key, token);
  this._removeFromNode(token, node);
  this._renderNode(node);
  this._eventBus.fire('token.removed', { token });

  return ghost ? this._playGhost(ghost, gesture) : Promise.resolve();
};

// Persistent HTML layer holding detached ghost dots — created once in the canvas container, above the
// diagram (absolute, inset 0, click-through). Not managed by `_renderNode`, so ghosts ride re-renders.
Primitives.prototype._ghostLayer = function() {
  if (!this._ghostLayerEl || !this._ghostLayerEl.parentNode) {
    const layer = domify('<div class="bts-token-ghosts"></div>');
    this._canvas.getContainer().appendChild(layer);
    this._ghostLayerEl = layer;
  }
  return this._ghostLayerEl;
};

// Clone a token's currently-drawn dot into the ghost layer at its on-screen position, or null if the
// token isn't drawn (parked / in a `+N` overflow) — then there's nothing to flip-fade.
Primitives.prototype._ghostFor = function(token) {
  const dot = this._dotElement(token);

  if (!dot) {
    return null;
  }

  const cRect = this._canvas.getContainer().getBoundingClientRect();
  const dRect = dot.getBoundingClientRect();

  const ghost = dot.cloneNode(true);
  domClasses(ghost).add('bts-token-ghost');
  // drop looping cues / selection so the ghost shows a clean flip-fade
  Array.from(ghost.classList).forEach(c => {
    if (c.indexOf('bts-anim-') === 0 || c === 'bts-selected') {
      ghost.classList.remove(c);
    }
  });
  ghost.style.position = 'absolute';
  ghost.style.margin = '0';
  ghost.style.left = (dRect.left - cRect.left) + 'px';
  ghost.style.top = (dRect.top - cRect.top) + 'px';

  this._ghostLayer().appendChild(ghost);
  return ghost;
};

// Play the one-shot effects in sequence on a detached ghost, then remove it. Returns a Promise that
// resolves once the effects have finished and the ghost is gone (callers may ignore it — fire-and-forget).
Primitives.prototype._playGhost = function(ghost, effects) {
  let chain = Promise.resolve();

  for (const effect of effects) {
    chain = chain.then(() => this._playOnce(ghost, effect));
  }

  return chain.then(() => {
    if (ghost.parentNode) {
      ghost.parentNode.removeChild(ghost);
    }
  });
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
Primitives.prototype.selectToken = function(node, label, selector) {
  return this._setTokenSelected(node, label, selector, true);
};

/**
 * Dim / undim a **sequence flow** — a `.bts-dim` class on its graphics that drops the line + arrowhead
 * to semi-transparent (and reverts cleanly, leaving the flow's own colours untouched). The host uses
 * this to fade a diverging gateway's unchosen outflows. Tracked so `clear` reverts any left dimmed.
 *
 * @param {string} flowId  a sequence-flow id
 * @param {boolean} [on=true]
 */
Primitives.prototype.setFlowDimmed = function(flowId, on = true) {
  const gfx = this._elementRegistry.getGraphics(flowId);
  if (!gfx) {
    return;
  }
  domClasses(gfx).toggle('bts-dim', !!on);
  if (on) {
    this._dimmedFlows.add(flowId);
  } else {
    this._dimmedFlows.delete(flowId);
  }
};

/**
 * Dim / undim a **node** — the same `.bts-dim` mechanism as `setFlowDimmed`, on a flow node's graphics.
 * The simulator uses this to fade candidate **link catch** events while the user picks the jump target
 * of an ambiguous link throw. Tracked alongside dimmed flows, so `clear` reverts any left dimmed.
 *
 * @param {string} nodeId
 * @param {boolean} [on=true]
 */
Primitives.prototype.setNodeDimmed = function(nodeId, on = true) {
  this.setFlowDimmed(nodeId, on); // identical: getGraphics + `.bts-dim` toggle, same tracking set
};

// The BPMN **standard-loop marker** (the ↻ glyph, drawn by bpmn-js with `data-marker="loop"`): dim it
// (`.bts-dim`) to signal "the token will leave the loop" vs full-black "the token will loop again".
// No-op if the node has no loop marker.
Primitives.prototype.setLoopMarkerDimmed = function(node, dimmed = true) {
  const gfx = this._elementRegistry.getGraphics(node);
  const marker = gfx && gfx.querySelector('[data-marker="loop"]');
  if (!marker) {
    return;
  }
  domClasses(marker).toggle('bts-dim', !!dimmed);
  if (dimmed) {
    this._loopNodes.add(node);
  }
};

// Make the loop marker **clickable** while a loop activity awaits its loop/exit decision. bpmn-js's
// `.djs-hit-all` rect covers the shape (the marker paths are not hit targets), so we lay our own
// transparent hit rect over the marker (appended last → on top of the hit rect) that fires
// `loop.marker.click` `{ node }`. `on=false` removes it (and un-dims the marker).
Primitives.prototype.setLoopToggleEnabled = function(node, on = true) {
  const gfx = this._elementRegistry.getGraphics(node);
  if (!gfx) {
    return;
  }
  const existing = gfx.querySelector('.bts-loop-hit');
  if (existing) {
    svgRemove(existing);
  }
  if (!on) {
    this.setLoopMarkerDimmed(node, false);
    this._loopNodes.delete(node);
    return;
  }
  const marker = gfx.querySelector('[data-marker="loop"]');
  if (!marker) {
    return;
  }
  const b = marker.getBBox(); // element-local coords (the marker sits in the shape's own group)
  const pad = 5;
  const hit = svgCreate('rect');
  svgAttr(hit, {
    x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, class: 'bts-loop-hit'
  });
  hit.addEventListener('click', e => {
    e.stopPropagation(); // don't also fire the shape's element.click
    this._eventBus.fire('loop.marker.click', { node });
  });
  svgAppend(gfx, hit);
  this._loopNodes.add(node);
};

/**
 * Clear the selection on the token at `(node, label, selector?)`.
 *
 * @param {string} node
 * @param {string} label
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @return {Token}
 */
Primitives.prototype.deselectToken = function(node, label, selector) {
  return this._setTokenSelected(node, label, selector, false);
};

/**
 * The currently selected tokens (e.g. to feed a side panel). Convenience for
 * `getTokens(t => t.selected)`.
 *
 * @return {Token[]}
 */
Primitives.prototype.getSelectedTokens = function() {
  return this.getTokens(t => t.selected);
};

/**
 * The ids of the currently selected nodes (those with a selection outline).
 *
 * @return {string[]}
 */
Primitives.prototype.getSelectedNodes = function() {
  return Array.from(this._selectedNodes);
};

/**
 * All tokens (each `{ node, label, color, state, selected, stackIndices }`), in
 * insertion order.
 *
 * @param {(token: Token) => boolean} [filter]
 * @return {Token[]}
 */
Primitives.prototype.getTokens = function(filter) {
  const all = this._allTokens();
  return filter ? all.filter(filter) : all;
};

/**
 * Bring a stacked node's **instance** `key` to the front of its display order (the front
 * instance is the one whose tokens show), **animating** the swap — a back copy arcs over to
 * the front while the visible pile slides one slot back (the `scrollStack('backward')`
 * gesture). Operates on the node's order **in the current ancestor context**; the rest keep
 * their relative order. The order + re-render update synchronously (so a sync read of
 * `getCurrentStack` sees the new front); the arc is cosmetic. No-op if the node isn't stacked
 * (size ≤ 1), `key` is unknown, or `key` is **already the front** (nothing to reveal).
 *
 * @param {string} node
 * @param {string|number} key instance key (a Animation label, or a numeric index)
 * @return {Promise<void>} resolves when the gesture ends
 */
Primitives.prototype.moveToFront = function(node, key) {
  const order = this._resolveOrder(node);

  if (!order || order.length <= 1) {
    return Promise.resolve();
  }

  const i = order.indexOf(key);

  if (i <= 0) { // unknown (-1) or already front (0) -> nothing to reveal
    return Promise.resolve();
  }

  return this._animateStackStep(node, this._elementRegistry.get(node), 'backward', () => {
    const j = order.indexOf(key);
    order.splice(j, 1);
    order.unshift(key);
  });
};

/**
 * Send a stacked node's instance `key` to the **back** of its display order. When `key` is the
 * front (so the shown instance changes), this **animates** — the top copy arcs over to the back
 * while the rest slide one slot forward (the `scrollStack('forward')` gesture). When `key` is
 * **not** the front, the visible (front) instance is unaffected, so the reorder is **instant**
 * (no animation). No-op if the node isn't stacked (size ≤ 1) or `key` is unknown.
 *
 * @param {string} node
 * @param {string|number} key
 * @return {Promise<void>} resolves when the reorder/gesture ends
 */
Primitives.prototype.moveToBack = function(node, key) {
  const order = this._resolveOrder(node);

  if (!order || order.length <= 1) {
    return Promise.resolve();
  }

  const i = order.indexOf(key);

  if (i === -1) {
    return Promise.resolve();
  }

  if (i !== 0) {
    // not the shown instance -> the front doesn't change -> reorder instantly, no gesture
    order.splice(i, 1);
    order.push(key);
    this._renderStackSubtree(node);
    return Promise.resolve();
  }

  return this._animateStackStep(node, this._elementRegistry.get(node), 'forward', () => {
    order.push(order.shift()); // front -> back
  });
};

/**
 * Re-render a node's subtree after its front instance changes (reorder/jump/scroll). The
 * new instance can change, across the whole subtree, both **which tokens are visible** and
 * **descendant stack sizes** (a nested stack's size is per outer instance). So redraw the
 * node's stack + every descendant stack (silhouette/`+k`/tokens), and re-render any other
 * descendant that merely carries tokens.
 */
Primitives.prototype._renderStackSubtree = function(node, redrawSelf = true) {
  const done = new Set([ node ]);

  // `redrawSelf` is false mid-scroll: the gesture owns the node's own silhouette (animated
  // clones), so only re-render its tokens — but still redraw descendant silhouettes.
  redrawSelf ? this._redrawStack(node) : this._renderNode(node);

  for (const id of Array.from(this._stackOrder.keys())) {
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

  // resting dots re-render above, but **in-flight movements** live outside `_renderNode`
  // (a moving SVG dot, not an overlay) — a front change here can flip whether a travelling
  // token's instance is the shown one, so re-sync each live movement's visibility too
  // (without this, a still-travelling token of a now-hidden stack stays visible on top).
  this._syncMovements();
};

/**
 * Re-evaluate every in-flight movement against the resolution rule (`_isVisible`) and
 * hide/show its moving dot. A movement is visibility-checked once at departure, but the
 * shown instance can change mid-flight (a reorder/scroll/new spawn) — so a token that
 * departed visible must hide when its instance falls behind, and vice versa.
 */
Primitives.prototype._syncMovements = function() {
  for (const [ token, movement ] of this._activeAnimations) {
    this._isVisible(token) ? movement.show() : movement.hide();
  }
};

/** Remove all tokens and animations. */
Primitives.prototype.clear = function() {
  // drop any pending deferred token-click
  clearTimeout(this._tokenClickTimer);
  this._tokenClickTimer = null;
  this._lastTokenClick = null;

  // settle any in-flight stack-step gestures (reveal the real node, drop the clones)
  for (const finish of Array.from(this._stackAnims.values())) {
    finish();
  }

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

  // drop any in-flight consume ghosts (the detached flip-fade clones)
  if (this._ghostLayerEl && this._ghostLayerEl.parentNode) {
    this._ghostLayerEl.parentNode.removeChild(this._ghostLayerEl);
  }
  this._ghostLayerEl = null;

  // undim any flows left dimmed (elements may be gone on diagram.clear/destroy — just forget them)
  for (const flowId of Array.from(this._dimmedFlows)) {
    const gfx = this._elementRegistry.getGraphics(flowId);
    if (gfx) {
      domClasses(gfx).remove('bts-dim');
    }
  }
  this._dimmedFlows.clear();

  // restore any loop markers (un-dim) and drop their loop-toggle hit rects
  for (const node of Array.from(this._loopNodes)) {
    if (this._elementRegistry.get(node)) {
      this.setLoopToggleEnabled(node, false);
    }
  }
  this._loopNodes.clear();

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
  for (const node of Array.from(this._stackOrder.keys())) {
    const element = this._elementRegistry.get(node);

    if (element) {
      this._clearStackShapes(this._stackGfx(element));
    }
  }

  this._stackOrder.clear();

  // a bulk clear drops the whole token model without per-token `token.removed` events — signal it so
  // incremental UIs (e.g. the Token panel list) can flush in one go
  this._eventBus.fire('tokens.cleared');
};

/**
 * Set the fixed animation duration (ms) — shared by token movement and
 * `throwIcon`/`catchIcon`.
 *
 * @param {number} duration
 */
Primitives.prototype.setAnimationDuration = function(duration) {
  this._duration = duration;
};

Primitives.prototype.getAnimationDuration = function() {
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
Primitives.prototype.getMaxVisible = function() {
  return this._maxVisible;
};


// node API //////////////

/**
 * Play an element's own icon (the rendered event icon / task-type icon) as a one-off **throw**,
 * emitted **from a token**: the icon starts centered on the token's dot and flies out diagonally
 * to the upper-right, fading out. Native icon color; shared animation duration. The cue is always
 * anchored to a token (`(node, label, selector)`), never the bare node — no-op if that token isn't
 * resting, or the element has no icon. Direction is the caller's choice (pair with `catchIcon`).
 *
 * @param {string} node element id (the icon geometry + the token's node)
 * @param {string} label
 * @param {{ sequenceFlow?: string, stackIndices?: object }} [selector]
 * @return {Promise<void>} resolves when the effect ends
 */
Primitives.prototype.throwIcon = function(node, label, selector) {
  return this._animateIcon(node, label, selector, 'emit');
};

/**
 * Play an element's own icon as a one-off **catch**, received **into a token**: the icon flies in
 * diagonally from the upper-left, fading in, to land centered on the token's dot. Counterpart to
 * `throwIcon`.
 *
 * @param {string} node
 * @param {string} label
 * @param {{ sequenceFlow?: string, stackIndices?: object }} [selector]
 * @return {Promise<void>} resolves when the effect ends
 */
Primitives.prototype.catchIcon = function(node, label, selector) {
  return this._animateIcon(node, label, selector, 'receive');
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
Primitives.prototype.setNodeSelected = function(node, selected = true) {
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
Primitives.prototype._stackExtent = function(node) {
  const size = this._stackSize(node);

  return size <= 1 ? 0 : Math.min(size - 1, this._maxVisible) * STACK_OFFSET;
};

/**
 * Create or resize the selection outline rect so it wraps the element **and its
 * instance stack** (which extends down-right by the stack extent). Called when the
 * node is selected and whenever its stack size changes.
 */
Primitives.prototype._drawNodeOutline = function(node, element, gfx) {
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
Primitives.prototype._stackMarkerWidth = function(node) {
  const hidden = this._stackSize(node) - (this._maxVisible + 1);

  if (hidden <= 0) {
    return 0;
  }

  return ('+' + hidden).length * 7; // ~bold 12px Arial per char; hugs the marker (~3px gap)
};

/**
 * Set a node's instance stack to an explicit ordered list of **instance keys** (front first),
 * in the given ancestor-instance context — the label-aware primitive. Each key identifies an
 * instance independent of position, so removing one (vs `setStackSize`'s count) never shifts
 * the others. The node itself (or, for an implicit process, its box) is the first instance and
 * the remaining `keys.length - 1` become offset copies; `[]`/falsy clears the stack. Purely
 * visual & host-driven. Omit `ancestorStackIndices` to target the instance on screen (`{}` =
 * base). `getStacks` reads it back.
 *
 * @param {string} node element id
 * @param {Array<string|number>} keys ordered instance keys, front first
 * @param {Object<string,*>} [ancestorStackIndices] the outer-instance context (omit = current)
 */
Primitives.prototype.setStacks = function(node, keys, ancestorStackIndices) {
  this._requireElement(node);

  const context = ancestorStackIndices === undefined ? this._currentContext(node) : ancestorStackIndices;
  const ctxKey = this._contextKey(context);
  keys = (keys || []).slice();

  if (keys.length) {
    let orders = this._stackOrder.get(node);
    if (!orders) {
      this._stackOrder.set(node, orders = new Map());
    }
    orders.set(ctxKey, keys);
  } else {
    const orders = this._stackOrder.get(node);
    if (orders) {
      orders.delete(ctxKey);
      if (!orders.size) this._stackOrder.delete(node);
    }
  }

  // re-render the node **and its descendants**: changing the key list can change which instance
  // is on screen (e.g. removing the front one), and descendant token visibility resolves against
  // this node's front (the resolution rule), so it must be refreshed too — not just `_redrawStack`.
  this._renderStackSubtree(node);
};

/** The node's ordered instance keys (front first) in its current context; `[]` if unstacked. */
Primitives.prototype.getStacks = function(node) {
  this._requireElement(node);
  return (this._resolveOrder(node) || []).slice();
};

/**
 * Draw the node's stack silhouette + `+k` marker + selection outline for the instance
 * **currently on screen** (`getStackSize` resolved against the current context), and
 * re-render its tokens. Idempotent; called whenever the resolved size/context may change.
 */
Primitives.prototype._redrawStack = function(node) {
  const element = this._elementRegistry.get(node);
  const size = this._stackSize(node);

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
Primitives.prototype._refreshNativeOutline = function(element) {
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
Primitives.prototype._drawStackMarker = function(node, element) {
  const existing = this._stackOverlays.get(node);

  if (existing !== undefined) {
    this._overlays.remove(existing);
    this._stackOverlays.delete(node);
  }

  const hidden = this._stackSize(node) - (this._maxVisible + 1);

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
 * The node's instance-stack size for the instance currently on screen (= its key count in the
 * current ancestor context; 0 if none). Internal — public callers use `getStacks(node).length`.
 *
 * @param {string} node
 * @return {number}
 */
Primitives.prototype._stackSize = function(node) {
  return (this._resolveOrder(node) || []).length;
};

/**
 * The graphics to stack against. Normally the element's own gfx, but for an implicit
 * **process box** (T4) the element is the root — whose gfx is the *layer* — so we return
 * the pool-style box `<g>` (with the `.djs-visual` we drew) instead.
 */
Primitives.prototype._stackGfx = function(element) {
  if (this._processBox && this._processBox.id === element.id) {
    return this._processBox.gfx;
  }
  return this._elementRegistry.getGraphics(element);
};

/** Is `element` the currently-drawn implicit-process box? */
Primitives.prototype._isProcessBox = function(element) {
  return !!(this._processBox && element && this._processBox.id === element.id);
};

/**
 * The process box's "content" gfx — the root's flow-node/connection groups, which sit in
 * the active layer beside the box gfx (a bare root has no `.djs-children` wrapper). Used as
 * the scroll snapshot's content + hidden during the gesture.
 */
Primitives.prototype._processBoxContent = function() {
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
Primitives.prototype.getProcessBox = function() {
  return this._processBox ? this._processBox.id : null;
};

/**
 * Ensure a pool-style box exists around an implicit (pool-less) `bpmn:Process` so it can
 * be stacked. Computes bounds from the process's flow nodes, **sets them on the root
 * element** (so all bounds-based code — overlays/anchors/outline/`+k` — works on it), and
 * draws the box gfx into the default layer behind the content. Idempotent; one at a time.
 */
Primitives.prototype._ensureProcessBox = function(element) {
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

  // The root now has bounds (the process token's overlay is anchored to the root, at root.x/y). If an
  // overlay container for the root already exists from a previous session, reposition it to the new
  // bounds so the token doesn't lag at a stale spot after a pan / mode round-trip. Reposition the
  // container **directly** via the overlays service — do NOT fire `element.changed`, which would also
  // make diagram-js draw a (wrong) selection outline for the root and re-evaluate its hit area (which
  // mis-routes double-clicks inside the box to a spawn).
  this._repositionOverlayContainer(element);
};

// Reposition the overlay container for `element` to its current x/y, without an `element.changed` event.
// Used for the implicit-process root, whose bounds we mutate directly. No-op if the container or the
// (semi-private) overlays helpers are unavailable.
Primitives.prototype._repositionOverlayContainer = function(element) {
  const overlays = this._overlays;
  if (!overlays || !overlays._getOverlayContainer || !overlays._updateOverlayContainer) {
    return;
  }
  const container = overlays._getOverlayContainer(element, true);
  if (container) {
    overlays._updateOverlayContainer(container);
  }
};

/** Build + insert the pool-style box gfx (rect + left banner divider + rotated name). */
Primitives.prototype._drawProcessBox = function(element) {
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
Primitives.prototype._removeProcessBox = function() {
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
Primitives.prototype.getCurrentStack = function(node) {
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
Primitives.prototype.getCurrentStacks = function(node) {
  this._requireElement(node);

  const indices = this._currentContext(node); // stacked ancestors -> their front index

  if (this._stackSize(node) > 1) {
    indices[node] = this.getCurrentStack(node);
  }

  return indices;
};

/**
 * Step the stack to the next (`'forward'`) or previous (`'backward'`) instance — thin sugar
 * over `moveToFront`/`moveToBack`: `'forward'` sends the front instance to the back (the next
 * becomes front); `'backward'` brings the last instance to the front. The animated gesture
 * lives in `moveTo*`. No-op if the node has no stack.
 *
 * @param {string} node element id
 * @param {'forward'|'backward'} [direction='forward']
 * @return {Promise<void>} resolves when the gesture ends
 */
Primitives.prototype.scrollStack = function(node, direction = 'forward') {
  const element = this._elementRegistry.get(node);

  if (!element) {
    throw new Error(`unknown node <${node}>`);
  }

  const order = this._resolveOrder(node);

  if (!order || order.length <= 1) {
    return Promise.resolve();
  }

  return direction === 'backward'
    ? this.moveToFront(node, order[order.length - 1]) // last -> front
    : this.moveToBack(node, order[0]);                // front -> back
};

/**
 * The shared stack-step gesture driven by `moveToFront`/`moveToBack` (and so `scrollStack`).
 * A **snapshot transition** over clones: snapshot the current instance (A); run `reorder` to
 * rotate the node's display order so a new instance is front; snapshot that (B); hide the real
 * node; animate A out / B in (the recycling clone arcs over the stack — lifts clear, travels
 * across, drops in — while the rest slide one slot); then reveal the real node (now B) and
 * rebuild the canonical stack. `direction` is purely the **visual**: `'backward'` = a back
 * copy rises to the front; `'forward'` = the front copy sinks to the back. The arc is
 * front-agnostic (the hidden copies are identical silhouettes) — it only conveys "the front
 * swapped," not the exact permutation, so the same gesture serves any `reorder`.
 *
 * Which tokens (at the node and in its scope) show is resolved from the data — each token's
 * `stackIndices` matched against the new front — so there is **no callback**. Settles any
 * in-flight gesture on this node first (rapid `autoFocus` never piles up). The `reorder` +
 * re-render run **synchronously**; only the arc is async. Instant (no arc) when drilled *into*
 * this node (the gesture would play off-screen) or the Web Animations API is unavailable.
 *
 * @param {string} node
 * @param {Object} element
 * @param {'forward'|'backward'} direction
 * @param {() => void} reorder mutates the node's order array (the bookkeeping)
 * @return {Promise<void>}
 */
Primitives.prototype._animateStackStep = function(node, element, direction, reorder) {
  // wrap the caller's reorder so any front change notifies UI — a different instance is now on top,
  // so which tokens are visible/hidden (at this node and in its scope) has flipped
  const applyReorder = reorder;
  reorder = () => {
    applyReorder();
    this._eventBus.fire('stack.changed', { node });
  };

  // settle any in-flight gesture on this node before starting a new one
  const inflight = this._stackAnims.get(node);
  if (inflight) {
    inflight();
  }

  // If an ANCESTOR of this node is already mid-scroll, that arc owns the visuals: it hid this node's
  // shape + token overlays and will re-render the whole subtree on finish, and its snapshots animate
  // this node's content. Running our own gesture here is pointless (our clones sit inside the
  // ancestor's hidden children, off-screen) and harmful — the "scrolled node's own flow token stays
  // put" rule below would keep this node's outer-thread overlay (e.g. an MI activity's parent token on
  // its incoming flow) visible, leaking it onto the ancestor's currently-shown (different) instance.
  // So just apply the reorder; the ancestor's finish renders the new front.
  for (const animNode of this._stackAnims.keys()) {
    if (this._isDescendant(node, animNode)) {
      reorder();
      return Promise.resolve();
    }
  }

  // The arc gesture animates offset clones on the element's own gfx — its shape on its
  // parent plane (for a collapsed sub-process, the collapsed box). If we're drilled INTO
  // this node (its shape sits on a different plane than the active root), that animation is
  // off-screen, so playing it would only hide the on-plane token overlays for the gesture's
  // duration and snap them back at the end. Swap instantly instead (reorder + re-render).
  const canvas = this._canvas;
  const elementRoot = canvas.findRoot && canvas.findRoot(element);
  const activeRoot = canvas.getRootElement && canvas.getRootElement();

  const gfx = this._stackGfx(element);
  const realFront = gfx && gfx.querySelector(':scope > .djs-visual');
  const oldCopies = gfx ? Array.from(gfx.querySelectorAll('.bts-stack-shape')) : [];

  if ((elementRoot && activeRoot && elementRoot !== activeRoot) ||
      !realFront || !oldCopies.length || !realFront.animate) {
    reorder();
    this._renderStackSubtree(node);
    return Promise.resolve();
  }

  // content to hide during the gesture (the snapshot stands in): a normal container's
  // sibling `.djs-children`, or — for the process box (T4) — the root's flow/connection
  // groups in the layer beside the box gfx
  const isBox = this._isProcessBox(element);
  const realChildren = isBox ? null : (gfx && gfx.parentNode && gfx.parentNode.querySelector(':scope > .djs-children'));
  const contentNodes = isBox ? this._processBoxContent() : [];

  const back = direction === 'backward';
  // fixed UI speed (not the simulation duration), but instant when animation is off (duration 0)
  const duration = this._duration > 0 ? STACK_SCROLL_DURATION : 0;
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

  // step the front instance: run the caller's bookkeeping (rotate/extract on this node's
  // order in its current context), then re-render the subtree so B and the landing show the
  // new instance's tokens (resolved from each token's stackIndices — no callback)
  reorder();
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
      // the **scrolled node's own** flow / arrival overlay is instance-agnostic, so it stays put
      // through the gesture (descendant flow overlays hide — their dots ride the snapshot)
      if (isOwn && o.html.querySelector(
        '.bts-token-count[data-sequence-flow]:not([data-sequence-flow=""]), .bts-token-count[data-left="0"][data-top="0.5"]')) {
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
  const paintSwap = setTimeout(() => {
    if (back) {
      gfx.insertBefore(recycler, realFront); // on top
    } else {
      gfx.insertBefore(recycler, gfx.firstChild); // behind
    }
  }, duration * 0.45);

  return new Promise(resolve => {
    const finish = () => {
      // guard against a double-run: re-entry settle (or clear) calls finish, then the
      // anims' own .finished resolves and would call it again
      if (this._stackAnims.get(node) !== finish) {
        return;
      }
      this._stackAnims.delete(node);
      clearTimeout(paintSwap);
      anims.forEach(a => a.cancel());

      // reveal the real node (now showing instance B) and rebuild the canonical stack
      // (clears all .bts-stack-shape, including these animated clones, and re-renders the
      // token overlay + "+k" marker for the new top)
      realFront.style.display = '';
      if (realChildren) {
        realChildren.style.display = '';
      }
      contentNodes.forEach(c => { c.style.display = ''; });
      hiddenOverlays.forEach(el => { el.style.display = ''; });
      // rebuild the canonical stack (clears the animated clones) + re-render the subtree
      // (descendant stacks may have changed size with the new instance) — skip if the node
      // is gone (diagram.clear/destroy mid-gesture)
      if (this._elementRegistry.get(node)) {
        this._renderStackSubtree(node);
      }
      resolve();
    };

    this._stackAnims.set(node, finish);
    Promise.all(anims.map(a => a.finished)).then(finish, finish);
  });
};

/** An id-stripped deep clone of `.djs-visual` (so it can be placed in the DOM safely). */
Primitives.prototype._cloneVisual = function(visual) {
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
Primitives.prototype._cloneNodeVisual = function(element, gfx, withContent) {
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
Primitives.prototype._drawTokenDots = function(group, element) {
  const nodes = new Set();

  for (const token of this._allTokens()) {
    if (!this._isVisible(token)) {
      continue;
    }
    if (token.node === element.id) {
      if (this._ownNodeExempt(token)) {
        continue; // the scrolled node's own flow / arrival token: instance-agnostic, stays put
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
      // the scrolled node's own flow / arrival tokens stay put; descendant flow tokens ride
      .filter(t => !(id === element.id && this._ownNodeExempt(t)))
      .forEach(t => this._appendTokenDot(group, element, de, t));
  }
};

/**
 * Is `de` rendered on the **same plane** as `element` (so its token dots belong on
 * `element`'s scroll snapshot)? A collapsed sub-process's children live on a separate
 * drill plane, reached only by crossing a **drill-plane root** (id !== its businessObject
 * id); crossing one means `de` is on a different plane and must be skipped.
 */
Primitives.prototype._coRendered = function(de, element) {
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
Primitives.prototype._appendTokenDot = function(group, element, tokenElement, token) {
  if (token.state.hidden) {
    return; // a parked (hidden) dot is display:none — keep it absent from scroll snapshots too,
            // so e.g. an MI activity's hidden outer token doesn't flash while an ancestor stack scrolls
  }

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
Primitives.prototype._inlineMarkers = function(group) {
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

Primitives.prototype._clearStackShapes = function(gfx) {
  if (!gfx) {
    return;
  }

  gfx.querySelectorAll('.bts-stack-shape').forEach(el => svgRemove(el));
};

Primitives.prototype._animateIcon = function(node, label, selector, direction) {
  const element = this._elementRegistry.get(node);

  if (!element) {
    throw new Error(`unknown node <${node}>`);
  }

  // the icon is emitted from / into a specific resting **token**, not the bare node
  const sel = selector || {};
  const token = this._head(this._key(node, String(label), sel.sequenceFlow, sel.stackIndices || {}));

  if (!token) {
    return Promise.resolve(); // no token to emit from / into
  }

  // the icon flies from the token's on-screen dot, so only when that dot is actually shown: skip a
  // token on a back-stack instance (not the front one) or a parked/hidden token — else an icon would
  // fly in/out from a hidden position.
  if (!this._isVisible(token) || token.state.hidden) {
    return Promise.resolve();
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

  // outer group positions the icon; inner group carries the CSS animation
  const outer = svgCreate('g');
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

  // center the icon on the **token's** resolved dot (not the node center): measure the icon's
  // element-local bbox, then translate `outer` so the icon's centre lands on the token's point.
  // (append → measure → set transform is synchronous, so there's no flash at the origin.)
  const bbox = inner.getBBox();
  const pt = this._clusterPoint(element, token.state); // element-local
  const x = element.x + pt.x - (bbox.x + bbox.width / 2);
  const y = element.y + pt.y - (bbox.y + bbox.height / 2);
  svgAttr(outer, 'transform', `translate(${x}, ${y})`);

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

/**
 * Play a **one-shot** CSS effect on a resting token's dot — e.g. `'flip'` (a single flip)
 * or `'fade-out'` — resolving when the animation ends. Unlike `state.animate` (a persistent,
 * **looping** cue), this is a transient gesture: a `.bts-once-<effect>` class is applied to
 * the dot for the duration of `animationDuration`, removed when it finishes, and the Promise
 * resolves — so a caller can **sequence** it in front of a depart/consume, e.g.
 * `playTokenEffect(node, label, 'fade-out').then(() => removeToken(node, label))`.
 *
 * No-op (resolves immediately) when the token doesn't exist or isn't currently drawn
 * (parked/`hidden`, or hidden behind a `+N` overflow marker).
 *
 * @param {string} node
 * @param {string} label
 * @param {string} effect  one-shot effect name → `.bts-once-<effect>`
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @return {Promise}
 */
Primitives.prototype.playTokenEffect = function(node, label, effect, selector) {
  if (!this._elementRegistry.get(node)) {
    throw new Error(`unknown node <${node}>`);
  }

  const sel = selector || {};
  const token = this._head(this._key(node, String(label), sel.sequenceFlow, sel.stackIndices || {}));

  if (!token) {
    return Promise.resolve(); // no such token
  }

  const dot = this._dotElement(token);

  if (!dot) {
    return Promise.resolve(); // not currently drawn (parked / in overflow)
  }

  return this._playOnce(dot, effect);
};

/**
 * Like {@link playTokenEffect} but plays a **sequence** of one-shot effects on the resting dot, one
 * after the other — e.g. `['fade-in', 'flip']` as a token's **entrance** (the reverse of a
 * `['flip', 'fade-out']` consume). No-op (resolves immediately) when there are no effects or the token
 * isn't currently drawn.
 *
 * @param {string} node
 * @param {string} label
 * @param {string[]} effects  one-shot effect names, played in order
 * @param {{ sequenceFlow?: string, stackIndices?: Object }} [selector]
 * @return {Promise}
 */
Primitives.prototype.playTokenEffects = function(node, label, effects, selector) {
  if (!effects || !effects.length) {
    return Promise.resolve();
  }
  if (!this._elementRegistry.get(node)) {
    throw new Error(`unknown node <${node}>`);
  }

  const sel = selector || {};
  const token = this._head(this._key(node, String(label), sel.sequenceFlow, sel.stackIndices || {}));
  const dot = token && this._dotElement(token);

  if (!dot) {
    return Promise.resolve();
  }

  let chain = Promise.resolve();
  for (const effect of effects) {
    chain = chain.then(() => this._playOnce(dot, effect));
  }
  return chain;
};

// Play a single one-shot effect on a dot element (live or a detached ghost): add `.bts-once-<effect>`
// for `animationDuration/3` (snappy quick-feedback timing), strip it when it ends, resolve. One-shot
// gestures are quick feedback (flip on trigger, fade before consume); still instant at duration 0.
Primitives.prototype._playOnce = function(dot, effect) {
  const dur = Math.round(this.getAnimationDuration() / 3);
  const cls = 'bts-once-' + effect;
  dot.style.animationDuration = dur + 'ms';
  domClasses(dot).add(cls);

  return new Promise(resolve => {
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      domClasses(dot).remove(cls);
      dot.style.animationDuration = '';
      resolve();
    };

    domEvent.bind(dot, 'animationend', finish);

    // fallback in case animationend doesn't fire (e.g. duration 0)
    setTimeout(finish, dur + 50);
  });
};

/**
 * The live DOM dot (`.bts-token-count`) currently rendered for a token, or `null` if the
 * token isn't drawn (parked or rolled into a `+N` overflow marker). Matches on the same
 * identity the dot carries in its dataset (label + rest flow + stack indices).
 */
Primitives.prototype._dotElement = function(token) {
  const ids = this._nodeOverlays.get(token.node) || [];
  const wantFlow = token.state.sequenceFlow || '';
  const wantStack = JSON.stringify(token.stackIndices || {});

  for (const id of ids) {
    const overlay = this._overlays.get(id);

    if (!overlay || !overlay.html || !overlay.html.querySelectorAll) {
      continue;
    }

    for (const dot of overlay.html.querySelectorAll('.bts-token-count')) {
      if (domClasses(dot).has('bts-overflow') || domClasses(dot).has('bts-hidden')) {
        continue;
      }

      if (dot.dataset.label === String(token.label) &&
          (dot.dataset.sequenceFlow || '') === wantFlow &&
          dot.dataset.stackIndices === wantStack) {
        return dot;
      }
    }
  }

  return null;
};


// token internals //////////////

Primitives.prototype._key = function(node, label, sequenceFlow, stackIndices) {
  return `${node}|${label}|${sequenceFlow || ''}|${this._contextKey(stackIndices)}`;
};

// `_tokens` maps an identity key to a **FIFO list** of homogeneous tokens (length 1 in the normal
// case — transparent). Several tokens can share an identity only when concurrent same-instance
// paths converge (e.g. a non-interrupting boundary fired twice). They're interchangeable
// (visualization-level relaxation); operations act on the **head** and advance FIFO.

/** The head (first-arrived) token at an identity key, or undefined. */
Primitives.prototype._head = function(key) {
  const list = this._tokens.get(key);
  return list && list[0];
};

/** Append a token to its identity key's FIFO list (creating the list). */
Primitives.prototype._pushToken = function(key, token) {
  let list = this._tokens.get(key);
  if (!list) {
    list = [];
    this._tokens.set(key, list);
  }
  list.push(token);
};

/** Remove a specific token from its identity key's list; drop the key when the list empties. */
Primitives.prototype._dropToken = function(key, token) {
  const list = this._tokens.get(key);
  if (!list) {
    return;
  }
  const i = list.indexOf(token);
  if (i !== -1) {
    list.splice(i, 1);
  }
  if (!list.length) {
    this._tokens.delete(key);
  }
};

/** All tokens across all identity slots (flattening the FIFO lists). */
Primitives.prototype._allTokens = function() {
  const out = [];
  for (const list of this._tokens.values()) {
    out.push(...list);
  }
  return out;
};

/**
 * Canonical string for an instance map `{ stackedNodeId: index }` — non-zero entries
 * only (omitted/0 = the base/default instance), sorted by node id. So `{}`, `undefined`
 * and `{A:0}` all yield `''` (one canonical identity/context).
 */
Primitives.prototype._contextKey = function(indices) {
  return contextKey(indices);
};

/**
 * The current ancestor-instance context of a node: `{ A: getCurrentStack(A) }` for each
 * stacked **ancestor** `A` (not the node itself). Resolved against the live front indices.
 */
Primitives.prototype._currentContext = function(node) {
  const ctx = {};
  const element = this._elementRegistry.get(node);
  let el = element && element.parent;

  while (el) {
    el = this._shapeOf(el);
    // a stacked ancestor enters the context as soon as it has any instance (>= 1) — NOT only at
    // size > 1. Otherwise the context key would flip when an outer node grows 1 -> 2 instances
    // (e.g. a 2nd process instance), orphaning descendant stacks (MI/event-sub) stored under the
    // old key. `_contextKey` still drops a count-based front index of 0, so base stays base; only
    // a truthy (label) key now keys at size 1 — which is exactly the stable membership we want.
    if (this._stackSize(el.id) >= 1) {
      ctx[el.id] = this.getCurrentStack(el.id);
    }
    el = el.parent;
  }

  return ctx;
};

/** The display order array for a node in its current context (creating a default if missing). */
Primitives.prototype._resolveOrder = function(node) {
  const orders = this._stackOrder.get(node);

  if (!orders) {
    return null;
  }

  const key = this._contextKey(this._currentContext(node));
  return orders.has(key) ? orders.get(key) : null;
};

/** Visible (not filtered out) tokens at a node. */
Primitives.prototype._visibleTokensAt = function(node) {
  const set = this._nodeTokens.get(node);

  if (!set) {
    return [];
  }

  return Array.from(set).filter(t => this._isVisible(t));
};

/** All tokens at `(node, label)` regardless of rest flow. */
Primitives.prototype._find = function(node, label) {
  return this._allTokens().filter(token => token.node === node && token.label === label);
};

Primitives.prototype._setTokenSelected = function(node, label, selector, selected) {
  label = String(label);

  const sel = selector || {};
  const token = this._head(this._key(node, label, sel.sequenceFlow, sel.stackIndices || {}));

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sel.sequenceFlow ? ` on <${sel.sequenceFlow}>` : ''}`);
  }

  token.selected = selected;
  this._renderNode(node);
  // notify listeners (e.g. the simulation panel) — programmatic selection has no click event
  this._eventBus.fire('token.selection.changed', { node, label, selected, token });

  return token;
};

Primitives.prototype._requireElement = function(node) {
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
/**
 * Drill the canvas to a node's **plane** — so a token inside a **collapsed sub-process** becomes
 * visible (its body lives on a separate plane). The "follow the action across planes" counterpart to
 * auto-focus's follow-across-instances: drilling **in** when the node is on an inner plane, back **out**
 * when it's on the active root's plane. A no-op when the node is already on the active plane, when the
 * node is unknown, or when the viewer has no planes (older bpmn-js). Used by the `animator`'s replay.
 *
 * @param {string} node element id
 */
Primitives.prototype.drillTo = function(node) {
  const canvas = this._canvas;
  if (!canvas.findRoot || !canvas.setRootElement) {
    return;
  }
  const element = this._elementRegistry.get(node);
  if (!element) {
    return;
  }
  const root = canvas.findRoot(this._shapeOf(element));
  if (root && canvas.getRootElement() !== root) {
    canvas.setRootElement(root);
  }
};

Primitives.prototype._shapeOf = function(el) {
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
Primitives.prototype._scrollOnDoubleClick = function(event) {
  let el = event.element;

  if (!el || el.waypoints || !el.businessObject) {
    return;
  }

  el = this._shapeOf(el);

  if (this._stackSize(el.id) <= 1) {
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
Primitives.prototype._selectOnClick = function(event) {
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
Primitives.prototype._isDescendant = function(childId, ancestorId) {
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

Primitives.prototype._resolveFlow = function(node, sequenceFlowId) {
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
 * A token is visible iff, for every stacked node `A` in the token's node + ancestors, the
 * token's recorded instance for `A` equals `A`'s current front key —
 * `(stackIndices[A] ?? 0) === getCurrentStack(A)`. Non-stacked nodes aren't checked, so
 * flat/`stackSize<=1` tokens are always visible.
 *
 * **A token resting on a sequence flow ignores its own node's stack index** — only its
 * *ancestor* instances gate it. A flow is drawn to the stack as a whole (not one
 * instance), so a token in transit shows regardless of which instance of its end node is
 * front; the host commits it into a specific instance afterwards (createToken/removeToken,
 * or setState with the full stackIndices).
 */
// A token "exempt" from its **own node's** stack gate: one resting on a flow (a flow is drawn to the
// stack as a whole), or the MI outer/main token at the ARRIVAL anchor (left:0/top:0.5) — an "arrived"
// outer thread. Such tokens stay **visible and put** while their sub-instances stack the node (they are
// instance-agnostic for that node), and they are skipped by the scroll snapshot (they don't ride).
Primitives.prototype._ownNodeExempt = function(token) {
  const pos = token.state.position;
  return !!token.state.sequenceFlow || (!!pos && pos.left === 0 && pos.top === 0.5);
};

Primitives.prototype._isVisible = function(token) {
  const exemptOwnNode = this._ownNodeExempt(token);
  let el = this._elementRegistry.get(token.node);
  let ownNode = true;

  while (el) {
    el = this._shapeOf(el);
    if (!(exemptOwnNode && ownNode) && this._stackSize(el.id) > 1) {
      const want = (token.stackIndices && token.stackIndices[el.id]) || 0;
      if (want !== this.getCurrentStack(el.id)) {
        return false;
      }
    }
    ownNode = false;
    el = el.parent;
  }

  return true;
};

Primitives.prototype._planeLayer = function(element) {
  const canvas = this._canvas;

  // bpmn-js@9+ : the plane layer for the element's root; else the viewport
  if ('findRoot' in canvas) {
    const root = canvas.findRoot(element);
    return root ? canvas._findPlaneForRoot(root).layer : null;
  }

  return domQuery('.viewport', canvas._svg);
};

Primitives.prototype._settle = function(token) {
  const movement = this._activeAnimations.get(token);

  // finish() synchronously runs the done callback (lands the token at its
  // target, re-renders, clears the active-animation entry)
  if (movement) {
    movement.finish();
  }
};

Primitives.prototype._addToNode = function(token, node) {
  let set = this._nodeTokens.get(node);

  if (!set) {
    set = new Set();
    this._nodeTokens.set(node, set);
  }

  // homogeneous tokens (same identity) coexist as a queue — keep distinct objects, insertion-ordered
  set.add(token);
};

Primitives.prototype._removeFromNode = function(token, node) {
  const set = this._nodeTokens.get(node);

  if (!set) {
    return;
  }

  set.delete(token); // the specific token object (others sharing its identity stay queued)

  if (!set.size) {
    this._nodeTokens.delete(node);
  }
};

Primitives.prototype._renderNode = function(node) {

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

    // anchored token on a process/activity → larger; flow tokens and the MI arrival token stay small
    // (both are "arrived" threads, not anchored instances)
    const big = onActivity && !this._ownNodeExempt(tokens[0]);

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

    const fireToken = (name, el, event) => {
      let stackIndices = {};
      try {
        stackIndices = JSON.parse(el.dataset.stackIndices || '{}');
      } catch (e) { /* keep {} */ }

      this._eventBus.fire(name, {
        node,
        label: el.dataset.label,
        sequenceFlow: el.dataset.sequenceFlow || null,
        stackIndices,
        originalEvent: event
      });
    };

    domEvent.bind(html, 'click', event => {
      const el = domClosest(event.target, '.bts-token-count', true);

      if (!el) {
        return;
      }

      // a click on a token is for the token — don't let it fall through to select the node beneath it
      event.stopPropagation();

      if (domClasses(el).has('bts-overflow')) {
        this._eventBus.fire('token.overflow.click', { node, hidden: hiddenRefs, originalEvent: event });
      } else {
        // Synthesize `token.dblclick` (the simulator's advance gesture) from two clicks on the same
        // token — a native dblclick can't survive the selection re-render between clicks. The single
        // click (token.click) is **deferred**: a second click within the window cancels it and fires
        // dblclick instead, so a double-click never sole-selects first (which would flash the list).
        const dblKey = `${node}|${el.dataset.label}|${el.dataset.sequenceFlow || ''}|${el.dataset.stackIndices || ''}`;

        if (this._tokenClickTimer && this._lastTokenClick === dblKey) {
          clearTimeout(this._tokenClickTimer);
          this._tokenClickTimer = null;
          this._lastTokenClick = null;
          fireToken('token.dblclick', el, event);
        } else {
          clearTimeout(this._tokenClickTimer);
          this._lastTokenClick = dblKey;
          this._tokenClickTimer = setTimeout(() => {
            this._tokenClickTimer = null;
            this._lastTokenClick = null;
            fireToken('token.click', el, event);
          }, DOUBLE_CLICK_MS);
        }
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
Primitives.prototype._clusterPoint = function(element, state) {
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

  return this._avoidBoundaryEvents(element, anchorPoint(state.position || DEFAULT_POSITION, element));
};

// Keep the activity's top-edge sweep (entry/busy/completion, `top: 0`) clear of boundary symbols.
// Only those three stops are adjusted; a center anchor (lower half) and activities with no attachers
// are left as-is. The whole sweep is laid out together (see `_sweepLayout`) because a nudged stop
// must sit to the right of the previous one — so a stop can no longer be placed in isolation. The
// incoming point is mapped to its sweep stop by nearest ideal x, then returned at the laid-out point.
Primitives.prototype._avoidBoundaryEvents = function(element, pt) {
  const attachers = element.attachers;

  if (!attachers || !attachers.length || pt.y >= element.height / 2) {
    return pt;
  }

  const layout = this._sweepLayout(element);

  if (!layout) {
    return { x: pt.x, y: pt.y + BOUNDARY_VOFFSET }; // last resort: drop the row on its current edge
  }

  const ideals = [ 0, element.width / 2, element.width ];
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < ideals.length; i++) {
    const d = Math.abs(pt.x - ideals[i]);
    if (d < best) {
      best = d;
      idx = i;
    }
  }

  return { x: layout.xs[idx], y: layout.y };
};

// Lay out the three sweep stops for an activity, avoiding its boundary symbols. Prefer the **upper**
// edge: try to place all three stops clear of the top symbols. If they don't all fit, try the
// **lower** edge (the dots then sit on the bottom). If neither edge can hold them, return `null` and
// the caller drops the row. Returns `{ y, xs: [entryX, busyX, completionX] }` (element-local).
Primitives.prototype._sweepLayout = function(element) {
  const W = element.width;
  const m = DOT_SIZE / 2 + SWEEP_DOT_CLEARANCE; // half-dot + clearance: how far a center clears a zone

  const top = placeSweepStops(W, this._boundaryZones(element, 'top', m));
  if (top) {
    return { y: 0, xs: top };
  }

  const bottom = placeSweepStops(W, this._boundaryZones(element, 'bottom', m));
  if (bottom) {
    return { y: element.height, xs: bottom };
  }

  return null;
};

// The forbidden horizontal intervals (element-local x) for a boundary-event-free **center** on the
// given edge: each attacher on that edge, its bbox widened by `m` on both sides, merged. A center
// landing outside every interval keeps the badge clear of the symbol. An attacher is on the top edge
// when its center sits in the activity's upper half, otherwise the bottom edge.
Primitives.prototype._boundaryZones = function(element, edge, m) {
  const half = element.height / 2;
  const zones = [];

  for (const b of element.attachers) {
    const onTop = b.y + b.height / 2 - element.y < half;
    if ((edge === 'top') !== onTop) {
      continue;
    }
    zones.push([ b.x - element.x - m, b.x + b.width - element.x + m ]);
  }

  return mergeIntervals(zones);
};

Primitives.prototype._dotHTML = function(token, big) {
  const { position, sequenceFlow, animate, hidden } = token.state;

  return `
    <div class="bts-token-count waiting${animate ? ' bts-anim-' + escape(animate) : ''}${token.selected ? ' bts-selected' : ''}${hidden ? ' bts-hidden' : ''}${big ? ' bts-on-activity' : ''}"
         data-node-id="${escape(token.node)}"
         data-label="${escape(token.label)}"
         data-left="${escape(position ? position.left : '')}"
         data-top="${escape(position ? position.top : '')}"
         data-hoffset="${escape(position ? position.hoffset : '')}"
         data-voffset="${escape(position ? position.voffset : '')}"
         data-sequence-flow="${escape(sequenceFlow || '')}"
         data-stack-indices="${escape(JSON.stringify(token.stackIndices || {}))}"
         data-animate="${escape(animate || '')}"
         data-selected="${!!token.selected}"
         data-hidden="${!!hidden}"
         title="${escape(token.label)}"
         style="background: ${token.color};"></div>
  `;
};

Primitives.prototype._markerHTML = function(count, big) {
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
Primitives.prototype._move = function(connection, token, done = noop, duration = this._duration) {
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

Primitives.prototype._stopMovement = function(movement) {
  movement.remove();
  this._movements.delete(movement);
};

Primitives.prototype._movementGroup = function(token) {
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
    animate: state.animate != null ? String(state.animate) : null,
    hidden: !!state.hidden
  };
}

/** Partial merge for setState: position/sequenceFlow stay mutually exclusive, animate/hidden independent. */
function mergeState(current, patch) {
  if (patch.position != null && patch.sequenceFlow != null) {
    throw new Error('state.position and state.sequenceFlow are mutually exclusive');
  }

  const next = {
    position: current.position,
    sequenceFlow: current.sequenceFlow,
    animate: current.animate,
    hidden: current.hidden
  };

  if (patch.position != null) {
    next.position = validatePosition(patch.position);
    next.sequenceFlow = null;
  }

  if (patch.sequenceFlow != null) {
    next.sequenceFlow = String(patch.sequenceFlow);
    next.position = null;
  }

  if (patch.animate !== undefined) {
    next.animate = patch.animate != null ? String(patch.animate) : null;
  }

  if (patch.hidden != null) {
    next.hidden = !!patch.hidden;
  }

  return next;
}

function anchorPoint(position, element) {
  return {
    x: position.left * element.width + position.hoffset,
    y: position.top * element.height + position.voffset
  };
}

// Place the three sweep stops (entry/busy/completion, ideals 0 / W/2 / W) left to right, each clear
// of the forbidden `zones` and strictly to the right of the previous stop. Returns the placed x's, or
// `null` if a stop is forced past the right corner (this edge cannot hold the sweep).
function placeSweepStops(W, zones) {
  const ideals = [ 0, W / 2, W ];
  const xs = [];
  let prev = -Infinity;

  for (const ideal of ideals) {
    const x = placeStop(ideal, prev, zones, W);
    if (x === null) {
      return null;
    }
    xs.push(x);
    prev = x;
  }

  return xs;
}

// One sweep stop: advance as far right as possible without passing the ideal x, staying clear of the
// zones and at least `SWEEP_MIN_ADVANCE` past the previous stop. Only when nothing fits at or before
// the ideal do we pass it, taking the first free spot beyond — which leaves the most room downstream.
function placeStop(ideal, prevX, zones, W) {
  const lo = prevX === -Infinity ? 0 : prevX + SWEEP_MIN_ADVANCE; // smallest x allowed here
  if (lo > W) {
    return null;
  }

  // prefer the rightmost free spot in [lo, ideal] (advance towards, but not past, the ideal)
  const hiTarget = Math.min(ideal, W);
  if (hiTarget >= lo) {
    const x = rightmostFree(lo, hiTarget, zones);
    if (x !== null) {
      return x;
    }
  }

  // nothing free at or before the ideal — overshoot to the first free spot beyond it
  return leftmostFree(Math.max(ideal, lo), W, zones);
}

// The largest x in [lo, hi] outside every (sorted, merged) zone, or null if the whole span is blocked.
function rightmostFree(lo, hi, zones) {
  let x = hi;
  for (let i = zones.length - 1; i >= 0; i--) {
    if (x >= zones[i][0] && x <= zones[i][1]) {
      x = zones[i][0] - SWEEP_EPS; // slide just left of this zone, then re-check earlier zones
    }
  }
  return x < lo ? null : x;
}

// The smallest x in [lo, hi] outside every (sorted, merged) zone, or null if the whole span is blocked.
function leftmostFree(lo, hi, zones) {
  let x = lo;
  for (let i = 0; i < zones.length; i++) {
    if (x >= zones[i][0] && x <= zones[i][1]) {
      x = zones[i][1] + SWEEP_EPS; // slide just right of this zone, then re-check later zones
    }
  }
  return x > hi ? null : x;
}

// Merge overlapping/touching intervals into a sorted, disjoint list.
function mergeIntervals(intervals) {
  if (!intervals.length) {
    return [];
  }

  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [ sorted[0].slice() ];

  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      out.push(sorted[i].slice());
    }
  }

  return out;
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
