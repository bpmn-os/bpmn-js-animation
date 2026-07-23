import { createCollapsibleEntry } from 'bpmn-js-side-panel';

/**
 * createTokenEntry — one animation token rendered as a side-panel {@link createCollapsibleEntry}.
 *
 * The summary row is the token's swatch (carrying the bounce/pulse animate cues), a middle-truncating
 * label (so the head and the "°k" counter tail both stay visible), a node tag, and a "hidden" badge
 * when the token's stack instance is not the front one. This is the same row the token panel drew as a
 * flat `<li>`, now a reusable entry.
 *
 * Expandability is driven by whether a detail renderer is supplied:
 *  - no `renderDetail` → a non-expandable row with no caret (the animation demo's flat token list,
 *    visually identical to before);
 *  - `renderDetail(token, contentEl)` given → a caret-scoped expandable entry whose body the consumer
 *    fills (e.g. a BPMNOS status/data view). `toggleOn: 'caret'` keeps a summary click free to *select*
 *    the token; only the caret opens the detail. The detail is (re)rendered on every `update`, so a
 *    live-changing status stays current in place without the row being rebuilt.
 *
 * Interaction: a single click runs `onClick` (select/reveal), a double click runs `onDblClick`
 * (advance). The single action is deferred so a double-click cancels it; the caret is isolated from
 * both (its click stops propagation).
 *
 * Kept generic with two injected helpers so the entry needs no diagram services of its own:
 * `displayNode(nodeId)` maps a node id to its shown text (a pool shows its process id), and
 * `isVisible(token)` decides the hidden badge.
 *
 * @param {Object} token
 * @param {Object} [options]
 * @param {Function} [options.renderDetail]  (token, contentEl) => void; its presence makes the entry expandable
 * @param {Function} [options.onClick]       (token) => void; single-click select/reveal
 * @param {Function} [options.onDblClick]    (token) => void; double-click advance
 * @param {Function} [options.displayNode]   (nodeId) => string; defaults to the id itself
 * @param {Function} [options.isVisible]     (token) => boolean; defaults to always visible
 * @param {boolean}  [options.open=false]    initial detail open state (expandable entries only)
 * @return {{ element: HTMLElement, update: (function(Object): void), contentEl: (HTMLElement|null), token: (function(): Object) }}
 */
export default function createTokenEntry(token, options = {}) {
  const {
    renderDetail,
    onClick,
    onDblClick,
    displayNode = (id) => id,
    isVisible = () => true,
    open = false
  } = options;

  const expandable = typeof renderDetail === 'function';

  // summary slot: [swatch][label + node tag], with a "hidden" badge appended on demand
  const summary = el('span', 'bjs-token-summary');
  const sw = swatch(token.color);
  const info = el('span', 'bjs-token-info');
  info.appendChild(labelEl(token.label));
  const nodeEl = el('span', 'bjs-token-node');
  info.appendChild(nodeEl);
  summary.appendChild(sw);
  summary.appendChild(info);

  const entry = createCollapsibleEntry({
    label: summary,
    expandable,
    open: expandable && !!open,
    toggleOn: 'caret'
  });
  entry.element.classList.add('bjs-token-entry');

  // single click selects/reveals; double click advances. Defer the single so a double cancels it
  // (otherwise the first click of a double sole-selects and flashes). The caret's click is isolated
  // (toggleOn:'caret' stops its propagation), so expanding never selects or advances.
  let clickTimer = null;
  if (onClick || onDblClick) {
    entry.element.classList.add('bjs-token-clickable');
    entry.element.addEventListener('click', () => {
      if (clickTimer) {
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (onClick) {
          onClick(token);
        }
      }, 250);
    });
    entry.element.addEventListener('dblclick', () => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      if (onDblClick) {
        onDblClick(token);
      }
    });
  }

  let badgeEl = null;

  const update = (t) => {
    token = t;
    sw.style.backgroundColor = t.color || '#888';
    // mirror the canvas cue: bounce = double-click to advance, pulse-pause = pick/spawn a decision
    const animate = t.state && t.state.animate;
    sw.classList.toggle('bts-anim-bounce', animate === 'bounce');
    sw.classList.toggle('bts-anim-pulse-pause', animate === 'pulse-pause');
    nodeEl.textContent = displayNode(t.node);
    entry.element.classList.toggle('bjs-token-selected', !!t.selected);

    const hidden = !isVisible(t);
    if (hidden && !badgeEl) {
      badgeEl = text('span', 'bjs-token-badge hidden', 'hidden');
      summary.appendChild(badgeEl);
    } else if (!hidden && badgeEl) {
      badgeEl.remove();
      badgeEl = null;
    }

    if (expandable && renderDetail) {
      entry.contentEl.replaceChildren();
      renderDetail(t, entry.contentEl);
    }
  };
  update(token);

  return { element: entry.element, update, contentEl: entry.contentEl, token: () => token };
}

// --- token summary DOM (matches the panel's former row visuals) -------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function text(tag, className, str) {
  const node = el(tag, className);
  node.textContent = str;
  return node;
}

function swatch(color) {
  const s = el('span', 'bjs-token-swatch');
  s.style.backgroundColor = color || '#888';
  return s;
}

// A token label that truncates in the MIDDLE when too narrow (so the start and the "°k" counter tail
// both stay visible): the head ellipsizes via CSS, a fixed-length tail always shows.
function labelEl(label) {
  const wrap = el('span', 'bjs-token-label');
  wrap.title = label;
  const tailLen = Math.min(6, Math.floor(label.length / 2));
  wrap.appendChild(text('span', 'bjs-token-label-head', label.slice(0, label.length - tailLen)));
  wrap.appendChild(text('span', 'bjs-token-label-tail', label.slice(label.length - tailLen)));
  return wrap;
}
