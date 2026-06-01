import {
  domify,
  event as domEvent,
  classes as domClasses,
  closest as domClosest
} from 'min-dom';

const OFFSET_BOTTOM = 10;
const OFFSET_LEFT = -15;

const DEFAULT_MAX_VISIBLE = 3;

/**
 * @typedef { { node: string, label: string, color: string } } Token
 */

/**
 * API-driven token controller.
 *
 * A token rests at a node (rendered as a clickable colored dot) until it is
 * sent along one or more sequence flows or removed. A token is identified by
 * the unique `(node, label)` pair; placing a token where that pair already
 * rests replaces it. Color is an arbitrary CSS color string supplied by the
 * caller and carried by the token (split copies inherit it).
 *
 * Fires on the eventBus:
 *  - `token.click`          `{ node, label }`
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

  this._tokens = new Map();            // "node|label" -> Token
  this._nodeTokens = new Map();        // node -> Set<Token>
  this._nodeOverlays = new Map();      // node -> overlayId
  this._activeAnimations = new Map();  // Token -> animation

  eventBus.on([ 'diagram.clear', 'diagram.destroy' ], () => this.clear());
}

/**
 * Place a token at a node. Replaces any token already at `(node, label)`.
 *
 * @param {string} node element id
 * @param {string} label identifies the token at the node (and shown on hover)
 * @param {string} color any CSS color (name, hex, rgb(), hsl(), …)
 * @return {Token}
 */
Tokens.prototype.createToken = function(node, label, color) {
  this._requireElement(node);

  if (label === undefined || label === null || label === '') {
    throw new Error('label is required');
  }

  if (!color) {
    throw new Error('color is required');
  }

  label = String(label);

  const key = this._key(node, label);
  const existing = this._tokens.get(key);

  if (existing) {
    existing.color = color;
    this._renderNode(node);

    return existing;
  }

  const token = { node, label, color };

  this._tokens.set(key, token);
  this._addToNode(token, node);
  this._renderNode(node);

  return token;
};

/**
 * Send tokens along sequence flows. Each transition is a `{ node, label, flow }`:
 * take the token at `(node, label)` and animate it along `flow`.
 *
 * This single shape covers every case:
 *  - **move** — one transition;
 *  - **split** — several transitions sharing the same `(node, label)` (the source token
 *    is consumed once and forks, one copy per flow);
 *  - **join / rewind-of-split** — several transitions from *different* sources whose
 *    flows land on the same node (the arrivals merge into one token).
 *
 * A flow may be **outgoing** from its transition's node (forward → its target) or
 * **incoming** to it (reverse → its source, e.g. rewinding). Each result is
 * optimistically addressable at its destination immediately, and any in-flight
 * animation for a source token is settled before it departs again.
 *
 * @param {Array<{ node: string, label: string, flow: string }>} transitions
 * @return {Promise<Token[]>} resolves with the resulting tokens once landed
 */
Tokens.prototype.sendToken = function(transitions) {
  if (!Array.isArray(transitions) || !transitions.length) {
    return Promise.reject(new Error('sendToken requires a non-empty array of { node, label, flow }'));
  }

  // resolve everything first (so an invalid transition rejects without side effects),
  // grouping transitions by their source token so a shared source is consumed once
  const groups = new Map();

  try {
    for (const transition of transitions) {
      const node = transition.node;
      const label = String(transition.label);
      const key = this._key(node, label);

      const token = this._tokens.get(key);

      if (!token) {
        throw new Error(`no token <${label}> at <${node}>`);
      }

      let group = groups.get(key);

      if (!group) {
        group = { node, label, color: token.color, token, flows: [] };
        groups.set(key, group);
      }

      group.flows.push(this._resolveFlow(node, transition.flow));
    }
  } catch (err) {
    return Promise.reject(err);
  }

  const branches = [];

  for (const group of groups.values()) {

    // settle any in-flight transition, then consume the source token once
    this._settle(group.token);
    this._tokens.delete(this._key(group.node, group.label));
    this._removeFromNode(group.token, group.node);
    this._renderNode(group.node);

    for (const { connection, toNode, waypoints } of group.flows) {
      const branch = { node: toNode, label: group.label, color: group.color };

      // optimistic identity: addressable at the destination right away
      this._tokens.set(this._key(toNode, group.label), branch);

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
 * Remove the token at `(node, label)`, cancelling any in-flight animation.
 *
 * @param {string} node
 * @param {string} label
 */
Tokens.prototype.removeToken = function(node, label) {
  label = String(label);

  const key = this._key(node, label);
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
 * @return {Token[]} each `{ node, label, color }`
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

  for (const overlayId of this._nodeOverlays.values()) {
    this._overlays.remove(overlayId);
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

Tokens.prototype._key = function(node, label) {
  return `${node}|${label}`;
};

Tokens.prototype._requireElement = function(node) {
  if (!this._elementRegistry.get(node)) {
    throw new Error(`unknown node <${node}>`);
  }
};

Tokens.prototype._resolveFlow = function(node, flowId) {
  const connection = this._elementRegistry.get(flowId);

  if (!connection) {
    throw new Error(`unknown sequence flow <${flowId}>`);
  }

  if (!connection.waypoints || !connection.source || !connection.target) {
    throw new Error(`<${flowId}> is not a routable connection`);
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

  throw new Error(`<${flowId}> is not connected to <${node}>`);
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

  // one token per label at a node (enforces the replace/join invariant)
  for (const t of set) {
    if (t.label === token.label) {
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

  for (const t of set) {
    if (t.label === token.label) {
      set.delete(t);
    }
  }

  if (!set.size) {
    this._nodeTokens.delete(node);
  }
};

Tokens.prototype._renderNode = function(node) {

  // badges are re-rendered wholesale
  const overlayId = this._nodeOverlays.get(node);

  if (overlayId) {
    this._overlays.remove(overlayId);
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

  const all = Array.from(set);
  const max = this._maxVisible;

  // show all up to max; a single overflow is shown rather than a "+1" marker
  let visible = all;
  let hidden = [];

  if (all.length > max + 1) {
    visible = all.slice(0, max);
    hidden = all.slice(max);
  }

  const dots = visible.map(t => this._dotHTML(t)).join('');
  const marker = hidden.length ? this._markerHTML(hidden.length) : '';

  const html = domify(`<div class="bts-token-count-parent">${dots}${marker}</div>`);

  domEvent.bind(html, 'click', event => {
    const el = domClosest(event.target, '.bts-token-count', true);

    if (!el) {
      return;
    }

    if (domClasses(el).has('bts-overflow')) {
      this._eventBus.fire('token.overflow.click', {
        node,
        hidden: hidden.map(t => ({ node: t.node, label: t.label })),
        originalEvent: event
      });
    } else {
      this._eventBus.fire('token.click', {
        node,
        label: el.dataset.label,
        originalEvent: event
      });
    }

    if ('focus' in this._canvas) {
      this._canvas.focus();
    }
  });

  const id = this._overlays.add(element, 'bts-token-count', {
    position: { bottom: OFFSET_BOTTOM, left: OFFSET_LEFT },
    html,
    show: { minZoom: 0.5 }
  });

  this._nodeOverlays.set(node, id);
};

Tokens.prototype._dotHTML = function(token) {
  return `
    <div class="bts-token-count waiting"
         data-node-id="${escape(token.node)}"
         data-label="${escape(token.label)}"
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

function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
