import {
  domify,
  event as domEvent,
  classes as domClasses,
  closest as domClosest
} from 'min-dom';

const DEFAULT_MAX_VISIBLE = 3;

const DOT_SIZE = 25;

// default rest state — mirrors the bpmn-js-token-simulation look (bottom-left, bouncing)
const DEFAULT_POSITION = 'below-left';
const DEFAULT_BOUNCE = true;

// 3x3 anchor grid as fractions of the element's bounds (0 = top/left edge,
// 0.5 = center, 1 = bottom/right edge); a dot is centered on the point, so
// edge/corner anchors half-overlap the node.
const VERTICAL = { above: 0, center: 0.5, below: 1 };
const HORIZONTAL = { left: 0, middle: 0.5, right: 1 };

/**
 * @typedef { {
 *   position: string | null,       // '{above|center|below}-{left|middle|right}'
 *   sequenceFlow: string | null,   // a connected sequence flow id (rest on it)
 *   bounce: boolean
 * } } TokenState
 *
 * @typedef { { node: string, label: string, color: string, state: TokenState } } Token
 */

/**
 * API-driven token controller.
 *
 * A token rests at a node (a clickable colored dot) until sent along a sequence
 * flow or removed. Its `state` describes *where it sits* and *whether it bounces*
 * — a pure visual descriptor; the caller maps its own lifecycle semantics onto
 * positions. `state.position` (a 3x3 anchor) and `state.sequenceFlow` (rest on a
 * flow) are mutually exclusive; `bounce` is orthogonal (the "user action needed" cue).
 *
 * Identity is `(node, label, sequenceFlow)` — the rest flow is part of the key so
 * that multiple same-label tokens can coexist at one node when resting on
 * *different* incoming flows (e.g. branches piling up at a merging gateway).
 * Anchor-positioned tokens have an empty flow, so at most one per `(node, label)`.
 *
 * Fires on the eventBus:
 *  - `token.click`          `{ node, label, sequenceFlow }`
 *  - `token.overflow.click` `{ node, hidden }`   (the "+N" marker)
 */
export default function Tokens(
    config, eventBus, canvas,
    overlays, elementRegistry, animation) {

  this._eventBus = eventBus;
  this._canvas = canvas;
  this._overlays = overlays;
  this._elementRegistry = elementRegistry;
  this._animation = animation;

  this._maxVisible = (config && config.maxVisible) || DEFAULT_MAX_VISIBLE;

  this._tokens = new Map();            // "node|label|sequenceFlow" -> Token
  this._nodeTokens = new Map();        // node -> Set<Token>
  this._nodeOverlays = new Map();      // node -> overlayId[]  (one per location cluster)
  this._activeAnimations = new Map();  // Token -> animation

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this.clear());
}

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
Tokens.prototype.createToken = function(node, label, color, state) {
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

  const token = { node, label, color, state: normalized };

  this._tokens.set(key, token);
  this._addToNode(token, node);
  this._renderNode(node);

  return token;
};

/**
 * Send tokens along sequence flows. Each transition is
 * `{ node, label, sequenceFlow, state? }`: take the token at `(node, label)`,
 * animate it along `sequenceFlow`, and land it in `state`.
 *
 * One shape covers every case:
 *  - **move** — one transition;
 *  - **split** — several transitions sharing the same `(node, label)` (the source is
 *    consumed once and forks, one copy per flow);
 *  - **join / rewind-of-split** — transitions from *different* sources whose flows land
 *    on the same node (resting on distinct incoming flows, they coexist; move them to
 *    a shared anchor to merge).
 *
 * `sequenceFlow` may be **outgoing** from the node (forward → its target) or
 * **incoming** (reverse → its source, e.g. rewinding). The source is addressed by
 * `(node, label)` and must be unambiguous — if several same-label tokens rest at the
 * node, settle/remove them first. An in-flight animation for a source is settled first.
 *
 * @param {Array<{ node: string, label: string, sequenceFlow: string, state?: Partial<TokenState> }>} transitions
 * @return {Promise<Token[]>} resolves with the resulting tokens once landed
 */
Tokens.prototype.sendToken = function(transitions) {
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
    this._removeFromNode(group.token, group.node);
    this._renderNode(group.node);

    for (const { connection, toNode, waypoints, state } of group.flows) {
      const branch = { node: toNode, label: group.label, color: group.color, state };

      // optimistic identity: addressable at the destination right away
      this._tokens.set(this._key(toNode, group.label, state.sequenceFlow), branch);

      branches.push(new Promise((resolve, reject) => {
        const animation = this._animation.animate(
          { waypoints },
          { color: group.color, element: connection },
          () => {
            this._activeAnimations.delete(branch);
            this._addToNode(branch, toNode);
            this._renderNode(toNode);
            resolve(branch);
          }
        );

        if (!animation) {
          reject(new Error('could not animate token (no canvas layer)'));
          return;
        }

        this._activeAnimations.set(branch, animation);
      }));
    }
  }

  return Promise.all(branches);
};

/**
 * Update a resting token's state in place (partial merge). Setting `position`
 * clears `sequenceFlow` and vice versa; `bounce` is independent.
 *
 * The trailing `sequenceFlow` selects *which* token when several same-label
 * tokens rest at the node (default: the anchor-positioned one). Changing the
 * rest flow/position rekeys the token, merging into any token already at the new
 * identity (this is how a join completes).
 *
 * @param {string} node
 * @param {string} label
 * @param {Partial<TokenState>} state
 * @param {string} [sequenceFlow] current rest flow identifying the token
 * @return {Token}
 */
Tokens.prototype.setState = function(node, label, state, sequenceFlow) {
  label = String(label);

  const oldKey = this._key(node, label, sequenceFlow);
  const token = this._tokens.get(oldKey);

  if (!token) {
    throw new Error(`no token <${label}> at <${node}>${sequenceFlow ? ` on <${sequenceFlow}>` : ''}`);
  }

  // drop from maps under the current identity, then re-key under the new one
  this._tokens.delete(oldKey);
  this._removeFromNode(token, node);

  token.state = mergeState(token.state, state || {});

  this._tokens.set(this._key(node, label, token.state.sequenceFlow), token);
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
Tokens.prototype.removeToken = function(node, label, sequenceFlow) {
  label = String(label);

  const key = this._key(node, label, sequenceFlow);
  const token = this._tokens.get(key);

  if (!token) {
    return;
  }

  const animation = this._activeAnimations.get(token);

  if (animation) {
    this._animation.stop(animation);
    this._activeAnimations.delete(token);
  }

  this._tokens.delete(key);
  this._removeFromNode(token, node);
  this._renderNode(node);
};

/**
 * @param {(token: Token) => boolean} [filter]
 * @return {Token[]} each `{ node, label, color, state }`
 */
Tokens.prototype.getTokens = function(filter) {
  const all = Array.from(this._tokens.values());

  return filter ? all.filter(filter) : all;
};

/**
 * Remove all tokens and animations.
 */
Tokens.prototype.clear = function() {
  for (const animation of this._activeAnimations.values()) {
    this._animation.stop(animation);
  }

  this._activeAnimations.clear();

  for (const overlayIds of this._nodeOverlays.values()) {
    overlayIds.forEach(id => this._overlays.remove(id));
  }

  this._nodeOverlays.clear();
  this._nodeTokens.clear();
  this._tokens.clear();
};

/**
 * Set the fixed transition duration (ms) for all subsequent sends.
 *
 * @param {number} duration
 */
Tokens.prototype.setDuration = function(duration) {
  this._animation.setDuration(duration);
};


// internals //////////////

Tokens.prototype._key = function(node, label, sequenceFlow) {
  return `${node}|${label}|${sequenceFlow || ''}`;
};

/** All tokens at `(node, label)` regardless of rest flow. */
Tokens.prototype._find = function(node, label) {
  const matches = [];

  for (const token of this._tokens.values()) {
    if (token.node === node && token.label === label) {
      matches.push(token);
    }
  }

  return matches;
};

Tokens.prototype._requireElement = function(node) {
  if (!this._elementRegistry.get(node)) {
    throw new Error(`unknown node <${node}>`);
  }
};

Tokens.prototype._resolveFlow = function(node, sequenceFlowId) {
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

Tokens.prototype._settle = function(token) {
  const animation = this._activeAnimations.get(token);

  // finish() synchronously runs the animation's done callback (lands the
  // token at its target, re-renders, clears the active-animation entry)
  if (animation) {
    animation.finish();
  }
};

Tokens.prototype._addToNode = function(token, node) {
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

Tokens.prototype._removeFromNode = function(token, node) {
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

Tokens.prototype._renderNode = function(node) {

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

  // group tokens that rest at the same location (anchor or flow)
  const clusters = new Map();

  for (const token of set) {
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
 * Element-local point (relative to the element's top-left) at which a cluster
 * of tokens with the given state should be anchored.
 */
Tokens.prototype._clusterPoint = function(element, state) {
  if (state.sequenceFlow) {
    const connection = this._elementRegistry.get(state.sequenceFlow);

    if (connection && connection.waypoints && connection.waypoints.length) {

      // use the waypoint at the node's end of the flow
      const atSource = connection.source && connection.source.id === element.id;
      const wp = atSource
        ? connection.waypoints[0]
        : connection.waypoints[connection.waypoints.length - 1];

      return { x: wp.x - element.x, y: wp.y - element.y };
    }
  }

  return anchorPoint(state.position || DEFAULT_POSITION, element);
};

Tokens.prototype._dotHTML = function(token) {
  const { position, sequenceFlow, bounce } = token.state;

  return `
    <div class="bts-token-count waiting${bounce ? ' bts-bounce' : ''}"
         data-node-id="${escape(token.node)}"
         data-label="${escape(token.label)}"
         data-position="${escape(position || '')}"
         data-sequence-flow="${escape(sequenceFlow || '')}"
         data-bounce="${bounce}"
         title="${escape(token.label)}"
         style="background: ${token.color};"></div>
  `;
};

Tokens.prototype._markerHTML = function(count) {
  return `
    <div class="bts-token-count bts-overflow" title="${count} more">+${count}</div>
  `;
};

Tokens.$inject = [
  'config.tokenAnimation',
  'eventBus',
  'canvas',
  'overlays',
  'elementRegistry',
  'animation'
];


// helpers //////////////

/** Identity within a node: label + rest flow (anchor tokens share an empty flow). */
function identityOf(token) {
  return `${token.label}|${token.state.sequenceFlow || ''}`;
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
