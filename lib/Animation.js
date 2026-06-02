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

// the stack scroll is UI feedback, not simulation — a fixed speed (ms), independent
// of the (simulation) animationDuration that drives token movement / icons
const STACK_SCROLL_DURATION = 600;

// counter for the fresh marker ids minted when cloning connections (see _inlineMarkers)
let MARKER_SEQ = 0;

// default rest state — mirrors the bpmn-js-token-simulation look (bottom-left, bouncing)
const DEFAULT_POSITION = 'below-left';
const DEFAULT_BOUNCE = true;

// 3x3 anchor grid as fractions of the element's bounds (0 = top/left edge,
// 0.5 = center, 1 = bottom/right edge); a dot is centered on the point.
const VERTICAL = { above: 0, center: 0.5, below: 1 };
const HORIZONTAL = { left: 0, middle: 0.5, right: 1 };

function noop() {}

/**
 * @typedef { {
 *   position: string | null,       // '{above|center|below}-{left|middle|right}'
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
 * Fires on the eventBus: `token.click` `{ node, label, sequenceFlow }` and
 * `token.overflow.click` `{ node, hidden }` (the "+N" marker).
 */
export default function Animation(config, eventBus, canvas, overlays, elementRegistry) {

  this._eventBus = eventBus;
  this._canvas = canvas;
  this._overlays = overlays;
  this._elementRegistry = elementRegistry;

  this._duration = config && config.animationDuration != null ? config.animationDuration : DEFAULT_DURATION;
  this._maxVisible = (config && config.maxVisible) || DEFAULT_MAX_VISIBLE;

  this._tokens = new Map();            // "node|label|sequenceFlow" -> Token
  this._order = [];                    // all tokens in global order (front = first)
  this._nodeTokens = new Map();        // node -> Set<Token>
  this._nodeOverlays = new Map();      // node -> overlayId[]  (one per location cluster)
  this._activeAnimations = new Map();  // Token -> TokenAnimation
  this._movements = new Set();         // all live TokenAnimation instances
  this._filter = null;                 // visibility predicate, or null = show all
  this._selectedNodes = new Set();     // node ids with a selection outline
  this._stackSizes = new Map();        // node -> instance-stack size
  this._stackOverlays = new Map();     // node -> overlayId for the "+k hidden instances" marker

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this.clear());
}

Animation.$inject = [
  'config.animation',
  'eventBus',
  'canvas',
  'overlays',
  'elementRegistry'
];


// token API //////////////

/**
 * Place a token at a node. Replaces any token already at the same identity
 * `(node, label, state.sequenceFlow)`.
 *
 * @param {string} node element id
 * @param {string} label identifies the token at the node (and shown on hover)
 * @param {string} color any CSS color (name, hex, rgb(), hsl(), …)
 * @param {Partial<TokenState>} [state] rest state (default: below-left, bouncing)
 * @return {Token}
 */
Animation.prototype.createToken = function(node, label, color, state) {
  this._requireElement(node);

  if (label === undefined || label === null || label === '') {
    throw new Error('label is required');
  }

  if (!color) {
    throw new Error('color is required');
  }

  label = String(label);

  const normalized = normalizeState(state);

  const key = this._key(node, label, normalized.sequenceFlow);
  const existing = this._tokens.get(key);

  if (existing) {
    existing.color = color;
    existing.state = normalized;
    this._renderNode(node);

    return existing;
  }

  const token = { node, label, color, state: normalized, selected: false };

  this._tokens.set(key, token);
  this._order.push(token); // newest goes to the back of the global order
  this._addToNode(token, node);
  this._renderNode(node);

  return token;
};

/**
 * Send tokens along sequence flows. Each transition is
 * `{ node, label, sequenceFlow, state? }`: take the token at `(node, label)`,
 * animate it along `sequenceFlow`, and land it in `state`.
 *
 * One shape covers every case: one transition = **move**; several sharing a
 * `(node, label)` = **split**; transitions from different sources landing on one
 * node (on distinct flows) coexist and can be merged by moving to a shared anchor.
 * `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse →
 * source, e.g. rewind). The source must be unambiguous; an in-flight source is settled.
 *
 * @param {Array<{ node: string, label: string, sequenceFlow: string, state?: Partial<TokenState> }>} transitions
 * @return {Promise<Token[]>} resolves with the resulting tokens once landed
 */
Animation.prototype.sendToken = function(transitions) {
  if (!Array.isArray(transitions) || !transitions.length) {
    return Promise.reject(new Error('sendToken requires a non-empty array of { node, label, sequenceFlow }'));
  }

  // resolve everything first (so an invalid transition rejects without side effects),
  // grouping by source token so a shared source is consumed once
  const groups = new Map();

  try {
    for (const transition of transitions) {
      const node = transition.node;
      const label = String(transition.label);

      const matches = this._find(node, label);

      if (!matches.length) {
        throw new Error(`no token <${label}> at <${node}>`);
      }

      if (matches.length > 1) {
        throw new Error(`multiple tokens <${label}> at <${node}>; settle or remove them first`);
      }

      const token = matches[0];
      const srcKey = this._key(node, label, token.state.sequenceFlow);

      let group = groups.get(srcKey);

      if (!group) {
        group = { node, label, color: token.color, token, flows: [] };
        groups.set(srcKey, group);
      }

      group.flows.push({
        ...this._resolveFlow(node, transition.sequenceFlow),
        state: normalizeState(transition.state)
      });
    }
  } catch (err) {
    return Promise.reject(err);
  }

  const branches = [];

  for (const group of groups.values()) {

    // settle any in-flight transition, then consume the source token once
    this._settle(group.token);
    this._tokens.delete(this._key(group.node, group.label, group.token.state.sequenceFlow));
    // branches inherit the source's slot in the global order (splits stay contiguous)
    let insertAt = this._removeFromOrder(group.token);
    if (insertAt < 0) {
      insertAt = this._order.length;
    }
    this._removeFromNode(group.token, group.node);
    this._renderNode(group.node);

    for (const { connection, toNode, waypoints, state } of group.flows) {

      // selection is carried (and copied to every branch on a split); if a token
      // already rests at the destination identity, the merge OR-s their selection
      const destKey = this._key(toNode, group.label, state.sequenceFlow);
      const existing = this._tokens.get(destKey);
      const selected = !!group.token.selected || !!(existing && existing.selected);

      const branch = { node: toNode, label: group.label, color: group.color, state, selected };

      // a branch merging onto an occupied identity replaces it in the global order too
      if (existing) {
        const ei = this._removeFromOrder(existing);
        if (ei !== -1 && ei < insertAt) {
          insertAt--;
        }
      }

      // optimistic identity: addressable at the destination right away
      this._tokens.set(destKey, branch);
      this._order.splice(insertAt++, 0, branch);

      branches.push(new Promise((resolve, reject) => {
        const movement = this._move(
          { waypoints },
          { color: group.color, element: connection, selected },
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
  }

  return Promise.all(branches);
};

/**
 * Update a resting token's state in place (partial merge). Setting `position`
 * clears `sequenceFlow` and vice versa; `bounce` is independent. The trailing
 * `sequenceFlow` selects which token when several same-label tokens rest at the
 * node. Changing the rest flow/position rekeys (merging into any token already at
 * the new identity — this is how a join completes).
 *
 * @param {string} node
 * @param {string} label
 * @param {Partial<TokenState>} state
 * @param {string} [sequenceFlow] current rest flow identifying the token
 * @return {Token}
 */
Animation.prototype.setState = function(node, label, state, sequenceFlow) {
  label = String(label);

  const oldKey = this._key(node, label, sequenceFlow);
  const token = this._tokens.get(oldKey);

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sequenceFlow ? ` on <${sequenceFlow}>` : ''}`);
  }

  this._tokens.delete(oldKey);
  this._removeFromNode(token, node);

  token.state = mergeState(token.state, state || {});

  // rekeying onto an occupied identity completes a join: OR the selection so a
  // selected token survives the merge (color is left as last-writer-wins)
  const newKey = this._key(node, label, token.state.sequenceFlow);
  const existing = this._tokens.get(newKey);

  if (existing && existing !== token) {
    token.selected = token.selected || existing.selected;
    this._removeFromOrder(existing); // absorbed by the join; `token` keeps its slot
  }

  this._tokens.set(newKey, token);
  this._addToNode(token, node);
  this._renderNode(node);

  return token;
};

/**
 * Remove the token at `(node, label, sequenceFlow?)`, cancelling any in-flight
 * animation. `sequenceFlow` defaults to the anchor-positioned token.
 *
 * @param {string} node
 * @param {string} label
 * @param {string} [sequenceFlow]
 */
Animation.prototype.removeToken = function(node, label, sequenceFlow) {
  label = String(label);

  const key = this._key(node, label, sequenceFlow);
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
  this._removeFromOrder(token);
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
Animation.prototype.selectToken = function(node, label, sequenceFlow) {
  return this._setTokenSelected(node, label, sequenceFlow, true);
};

/**
 * Clear the selection on the token at `(node, label, sequenceFlow?)`.
 *
 * @param {string} node
 * @param {string} label
 * @param {string} [sequenceFlow]
 * @return {Token}
 */
Animation.prototype.deselectToken = function(node, label, sequenceFlow) {
  return this._setTokenSelected(node, label, sequenceFlow, false);
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
 * All tokens in **global order** (front first). The order drives which token a
 * stacked node shows on top and the draw order within a cluster; control it with
 * `moveToFront` / `moveToBack`.
 *
 * @param {(token: Token) => boolean} [filter]
 * @return {Token[]} each `{ node, label, color, state, selected }`
 */
Animation.prototype.getTokens = function(filter) {
  return filter ? this._order.filter(filter) : this._order.slice();
};

/**
 * Move a token to the **front** of the global order — it becomes the first at its
 * node (the one a stacked node shows on top, and the first drawn in its cluster).
 * Takes the token object (from `createToken` / `getTokens`); a stale/unknown
 * reference is a no-op.
 *
 * @param {Token} token
 */
Animation.prototype.moveToFront = function(token) {
  const i = this._order.indexOf(token);

  if (i === -1) {
    return;
  }

  this._order.splice(i, 1);
  this._order.unshift(token);
  this._renderNode(token.node);
};

/**
 * Move a token to the **back** of the global order (the opposite of
 * `moveToFront`). Stale/unknown reference → no-op.
 *
 * @param {Token} token
 */
Animation.prototype.moveToBack = function(token) {
  const i = this._order.indexOf(token);

  if (i === -1) {
    return;
  }

  this._order.splice(i, 1);
  this._order.push(token);
  this._renderNode(token.node);
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
  this._order = [];

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

  // drop instance-stack shapes for nodes still present (elements may be gone on
  // diagram.clear/destroy — just forget them then)
  for (const node of Array.from(this._stackSizes.keys())) {
    const element = this._elementRegistry.get(node);

    if (element) {
      this._clearStackShapes(this._elementRegistry.getGraphics(element));
    }
  }

  this._stackSizes.clear();
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
  const gfx = this._elementRegistry.getGraphics(element);

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
  if (!gfx) {
    return;
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
 * Render an element as a **stack of its own shape** — the real node on top, with
 * `size - 1` faithful, opaque copies of the node's graphic peeking out behind it,
 * each shifted diagonally (down-right) by `STACK_OFFSET`. A visual cue that the
 * node has multiple instances. Copies are capped at `maxVisible`; `getStackSize`
 * still reports the true size. Purely visual & host-driven — the library does not
 * infer the size from tokens.
 *
 * The copies are inserted into the element's own graphics (so they track pan/zoom)
 * as leading children, painting *behind* the body. They are inert
 * (`pointer-events:none`) and opaque (they carry the node's own fill), so they hide
 * whatever is behind them.
 *
 * @param {string} node element id
 * @param {number} size number of shapes in the stack (`<= 1` removes it)
 */
Animation.prototype.setStackSize = function(node, size) {
  this._requireElement(node);

  const element = this._elementRegistry.get(node);
  const gfx = this._elementRegistry.getGraphics(element);

  // rebuild from scratch every time
  this._clearStackShapes(gfx);

  size = Math.floor(size) || 0;

  const visual = gfx && domQuery('.djs-visual', gfx);

  if (size > 1 && visual) {
    this._stackSizes.set(node, size);

    const copies = Math.min(size - 1, this._maxVisible);

    // insert farthest-to-nearest with insertBefore(firstChild): the loop leaves DOM
    // order [copyN … copy1, hit, visual], so the real node paints on top (front) and
    // each nearer copy paints over the farther ones behind it
    for (let i = 1; i <= copies; i++) {
      const shape = this._cloneNodeVisual(element, gfx);

      svgAttr(shape, 'transform', `translate(${i * STACK_OFFSET}, ${i * STACK_OFFSET})`);
      gfx.insertBefore(shape, gfx.firstChild);
    }
  } else {
    this._stackSizes.delete(node);
  }

  // keep a selection outline sized to the (new) stack
  if (this._selectedNodes.has(node)) {
    this._drawNodeOutline(node, element, gfx);
  }

  // a "+k" marker when the true size exceeds the drawn cap (hidden instances)
  this._drawStackMarker(node, element);

  // re-render tokens: a stacked node shows only its top token, a non-stacked node all
  this._renderNode(node);
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
 * @param {string} node
 * @return {number} the node's instance-stack size (0 if none)
 */
Animation.prototype.getStackSize = function(node) {
  return this._stackSizes.get(node) || 0;
};

/**
 * Animate the stack scrolling by one — a one-off gesture for "stepping" to the
 * next (`'forward'`) or previous (`'backward'`) instance. It's a **snapshot
 * transition** over clones: snapshot the current instance (A); optionally commit the
 * **next instance** onto the real children via `nestedStacks`; snapshot that (B); hide
 * the real node; animate A out / B in (the recycling clone arcs over the stack — lifts
 * clear, travels across, drops in — while the rest slide one slot); then reveal the
 * real node (now B) and rebuild the canonical stack.
 *
 * `nestedStacks` is `[{ node, stackSize }, …]` — it **fully describes** the nested
 * stacks of the instance that ends up at the **front** after the scroll (the host
 * passes the right one per direction). The container's existing descendant stacks are
 * **reset** first, then the spec is applied — so **no arg ⇒ the next instance has no
 * nested stacks**. The result is **committed** to the real diagram (it lands on the
 * next instance), between the two snapshots, synchronously, before the real node is
 * hidden — so no intermediate paint / flash. No-op if the node has no stack (or no Web
 * Animations API).
 *
 * @param {string} node element id
 * @param {'forward'|'backward'} [direction='forward']
 * @param {Array<{ node: string, stackSize: number }>} [nestedStacks] next instance's nested stacks
 * @return {Promise<void>} resolves when the gesture ends
 */
Animation.prototype.scrollStack = function(node, direction = 'forward', nestedStacks) {
  const element = this._elementRegistry.get(node);

  if (!element) {
    throw new Error(`unknown node <${node}>`);
  }

  const size = this.getStackSize(node);

  if (size <= 1) {
    return Promise.resolve();
  }

  const gfx = this._elementRegistry.getGraphics(element);
  const realFront = gfx && gfx.querySelector(':scope > .djs-visual');
  const realChildren = gfx && gfx.parentNode && gfx.parentNode.querySelector(':scope > .djs-children');
  const oldCopies = gfx ? Array.from(gfx.querySelectorAll('.bts-stack-shape')) : [];

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

  // snapshot the current instance (A), with content, before committing the next
  const clones = [ this._cloneNodeVisual(element, gfx, true) ]; // slot 0

  // commit the next instance (B) onto the real children — synchronous, so no paint
  // happens before we hide the real node below (no flash). `nestedStacks` *fully*
  // describes the next instance: reset the container's existing descendant stacks
  // first, then apply the spec — so no arg ⇒ the next instance has no nested stacks.
  for (const stacked of Array.from(this._stackSizes.keys())) {
    if (stacked !== node && this._isDescendant(stacked, node)) {
      this.setStackSize(stacked, 0);
    }
  }
  if (nestedStacks) {
    nestedStacks.forEach(s => this.setStackSize(s.node, s.stackSize));
  }

  // build the remaining clones: the incoming slot snapshots B (with content), the rest
  // are outline ghosts
  for (let i = 1; i <= n; i++) {
    clones[i] = this._cloneNodeVisual(element, gfx, i === incomingSlot);
  }

  // all cloning is done (while everything was visible) — now swap the real node and the
  // old static copies out for the animated clones, in one synchronous tick (no flash)
  oldCopies.forEach(c => svgRemove(c));
  realFront.style.display = 'none';
  if (realChildren) {
    realChildren.style.display = 'none';
  }

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
      // (setStackSize clears all .bts-stack-shape, including these animated clones)
      realFront.style.display = '';
      if (realChildren) {
        realChildren.style.display = '';
      }
      this.setStackSize(node, size);
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

  // container children: the sibling `.djs-children` of the element gfx
  const childrenGfx = gfx.parentNode && gfx.parentNode.querySelector(':scope > .djs-children');

  if (childrenGfx && childrenGfx.childNodes.length) {
    const childrenClone = this._cloneVisual(childrenGfx);

    // drop interaction rects + selection outlines; KEEP nested `.bts-stack-shape` so a
    // snapshot captures any stacked children faithfully (e.g. a stacked task inside)
    childrenClone.querySelectorAll('.djs-hit, .bts-node-outline')
      .forEach(el => el.remove());

    const compensator = svgCreate('g');
    svgAttr(compensator, 'transform', `translate(${-element.x}, ${-element.y})`);
    svgAppend(compensator, childrenClone);
    svgAppend(group, compensator);
  }

  // connections reference their arrowheads via `marker-end: url(#id)`; a shared <defs>
  // marker doesn't reliably paint on cloned content, so copy each referenced marker
  // with a fresh id into this clone and repoint the reference.
  this._inlineMarkers(group);

  return group;
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

Animation.prototype._key = function(node, label, sequenceFlow) {
  return `${node}|${label}|${sequenceFlow || ''}`;
};

/** Remove a token from the global order; returns its old index (or -1). */
Animation.prototype._removeFromOrder = function(token) {
  const i = this._order.indexOf(token);

  if (i !== -1) {
    this._order.splice(i, 1);
  }

  return i;
};

/** Visible (not filtered out) tokens at a node, in global order (front first). */
Animation.prototype._visibleTokensAt = function(node) {
  const set = this._nodeTokens.get(node);

  if (!set) {
    return [];
  }

  return this._order.filter(t => set.has(t) && this._isVisible(t));
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

Animation.prototype._setTokenSelected = function(node, label, sequenceFlow, selected) {
  label = String(label);

  const token = this._tokens.get(this._key(node, label, sequenceFlow));

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sequenceFlow ? ` on <${sequenceFlow}>` : ''}`);
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

/** Is `childId` nested (at any depth) inside `ancestorId`? */
Animation.prototype._isDescendant = function(childId, ancestorId) {
  const child = this._elementRegistry.get(childId);
  let el = child && child.parent;

  while (el) {
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

Animation.prototype._isVisible = function(token) {
  return !this._filter || !!this._filter(token);
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

  if (!element) {
    return;
  }

  // group tokens that rest at the same location (anchor or flow), in global order
  const clusters = new Map();

  let ordered = this._order.filter(t => set.has(t));
  for (const t of set) {
    if (!ordered.includes(t)) {
      ordered.push(t); // straggler: in the set but not yet ordered (merge in flight)
    }
  }

  // a stacked node shows only its **top stack's token** — the first visible token by
  // global order, at its normal anchor (the silhouette + "+k" convey the rest; scroll
  // or moveToFront brings another to the top)
  if (this.getStackSize(node) > 1) {
    const top = this._visibleTokensAt(node)[0];
    ordered = top ? [ top ] : [];
  }

  for (const token of ordered) {
    if (!this._isVisible(token)) {
      continue; // filtered out — not drawn, doesn't count toward the cap
    }

    const key = token.state.sequenceFlow
      ? `flow:${token.state.sequenceFlow}`
      : `pos:${token.state.position}`;

    let list = clusters.get(key);

    if (!list) {
      list = [];
      clusters.set(key, list);
    }

    list.push(token);
  }

  const overlayIds = [];
  const max = this._maxVisible;

  for (const tokens of clusters.values()) {

    // cap per cluster; show all when overflow would be just one
    let visible = tokens;
    let hidden = [];

    if (tokens.length > max + 1) {
      visible = tokens.slice(0, max);
      hidden = tokens.slice(max);
    }

    const dots = visible.map(t => this._dotHTML(t)).join('');
    const marker = hidden.length ? this._markerHTML(hidden.length) : '';

    const html = domify(`<div class="bts-token-count-parent">${dots}${marker}</div>`);

    const hiddenRefs = hidden.map(t => ({ node: t.node, label: t.label }));

    domEvent.bind(html, 'click', event => {
      const el = domClosest(event.target, '.bts-token-count', true);

      if (!el) {
        return;
      }

      if (domClasses(el).has('bts-overflow')) {
        this._eventBus.fire('token.overflow.click', { node, hidden: hiddenRefs, originalEvent: event });
      } else {
        this._eventBus.fire('token.click', {
          node,
          label: el.dataset.label,
          sequenceFlow: el.dataset.sequenceFlow || null,
          originalEvent: event
        });
      }

      if ('focus' in this._canvas) {
        this._canvas.focus();
      }
    });

    const point = this._clusterPoint(element, tokens[0].state);

    const id = this._overlays.add(element, 'bts-token-count', {
      position: { left: point.x - DOT_SIZE / 2, top: point.y - DOT_SIZE / 2 },
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

Animation.prototype._dotHTML = function(token) {
  const { position, sequenceFlow, bounce } = token.state;

  return `
    <div class="bts-token-count waiting${bounce ? ' bts-bounce' : ''}${token.selected ? ' bts-selected' : ''}"
         data-node-id="${escape(token.node)}"
         data-label="${escape(token.label)}"
         data-position="${escape(position || '')}"
         data-sequence-flow="${escape(sequenceFlow || '')}"
         data-bounce="${bounce}"
         data-selected="${!!token.selected}"
         title="${escape(token.label)}"
         style="background: ${token.color};"></div>
  `;
};

Animation.prototype._markerHTML = function(count) {
  return `
    <div class="bts-token-count bts-overflow" title="${count} more">+${count}</div>
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
Animation.prototype._move = function(connection, token, done = noop) {
  const group = this._movementGroup(token);

  if (!group) {
    return;
  }

  const gfx = svgAppendTo(svgCreate(movingTokenSVG(token).trim()), group);

  const movement = new TokenAnimation(gfx, connection.waypoints, this._duration, () => {
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

/** Identity within a node: label + rest flow (anchor tokens share an empty flow). */
function identityOf(token) {
  return `${token.label}|${token.state.sequenceFlow || ''}`;
}

/**
 * The element's icon geometry to clone for `throwIcon`/`catchIcon`: any child
 * shape that is NOT the full-size body/outline (the event boundary ring, task
 * rect, gateway diamond, …). Identified by **size, not tag** — so an icon drawn
 * with a path, circle, rect, polygon, etc. is all picked up; the body/outline is
 * dropped because its bounding box spans (almost) the whole element.
 */
function iconNodes(gfx, element) {
  if (!gfx) {
    return [];
  }

  const w = element.width || 0;
  const h = element.height || 0;

  const shapes = gfx.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line');

  return Array.from(shapes).filter(el => {
    let bbox;

    try {
      bbox = el.getBBox();
    } catch (e) {
      return true; // can't measure -> keep it
    }

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

function validatePosition(position) {
  const parts = String(position).split('-');

  if (parts.length !== 2 || !(parts[0] in VERTICAL) || !(parts[1] in HORIZONTAL)) {
    throw new Error(`invalid position <${position}> (expected {above|center|below}-{left|middle|right})`);
  }

  return position;
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
    position = DEFAULT_POSITION;
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
  const [ v, h ] = String(position).split('-');

  return {
    x: HORIZONTAL[h] * element.width,
    y: VERTICAL[v] * element.height
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
