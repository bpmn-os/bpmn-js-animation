import { createCollapsibleEntry, createSimpleEntry } from 'bpmn-js-side-panel';

/**
 * createTokenEntry — one animation token rendered as a side-panel entry.
 *
 * The summary row is the token's swatch (carrying the bounce/pulse animate cues), a middle-truncating
 * label (so the head and the "°k" counter tail both stay visible), a node tag, and a "hidden" badge
 * when the token's stack instance is not the front one. This is the same row the token panel drew as a
 * flat `<li>`, now a reusable entry.
 *
 * Which entry it is follows from whether a detail renderer is supplied, and the two are different
 * side-panel entries rather than one entry in two states:
 *  - no `renderDetail` → a {@link createSimpleEntry}, a row that discloses nothing, so the summary
 *    takes the full width (the animation demo's flat token list);
 *  - `renderDetail(token, contentEl)` given → a {@link createCollapsibleEntry} whose body the consumer
 *    fills (e.g. a BPMNOS status/data view). `toggleOn: 'caret'` keeps a summary click free to *select*
 *    the token; only the caret opens the detail. The detail is (re)rendered on every `update`, so a
 *    live-changing status stays current in place without the row being rebuilt.
 *
 * A list is therefore uniform: every row of one list is built from the same options, so all of them
 * disclose or none does, and the rows line up either way. A row that must reserve a caret it will
 * never show, because it stands among rows that do disclose, is the collapsible entry's
 * `expandable: false` and belongs to a caller composing such a list itself.
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
 * @param {Node|Node[]} [options.controls]   controls the row carries, held right of the label; a panel
 *        offering a decision about the token puts it here, and the entry's own slot keeps their clicks
 *        from selecting or advancing the token
 * @param {boolean}  [options.open=false]    initial detail open state (expandable entries only)
 * @return {{ element: HTMLElement, update: (function(Object): void), contentEl: (HTMLElement|null),
 *   controlsEl: HTMLElement, token: (function(): Object) }}
 */
export default function createTokenEntry(token, options = {}) {
  const {
    renderDetail,
    onClick,
    onDblClick,
    displayNode = (id) => id,
    isVisible = () => true,
    controls,
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

  // The summary is a collapsible entry's label and a simple entry's content, which is the same slot under
  // the two names each kind uses for what it shows: a collapsible entry's label is what stands for it while
  // it is shut, where a simple entry is what it holds and nothing besides.
  const entry = expandable
    ? createCollapsibleEntry({ label: summary, open: !!open, toggleOn: 'caret', controls })
    : createSimpleEntry({ content: summary, controls });
  entry.element.classList.add('bjs-token-entry');

  // Only a collapsible entry has a body. A simple entry has a content slot too, holding the summary
  // itself, and it is not that: a click on the summary is a click on the row.
  const detailEl = expandable ? entry.contentEl : null;

  // single click selects/reveals; double click advances. Defer the single so a double cancels it
  // (otherwise the first click of a double sole-selects and flashes). The caret's click is isolated
  // (toggleOn:'caret' stops its propagation), so expanding never selects or advances.
  //
  // The DOM event is handed on with the token, so that what the reader held down while clicking is known
  // to whoever answers: a click here is the same gesture as a click on the canvas, and the canvas reads
  // shift for an additive selection.
  //
  // What the body holds acts on itself and not on the token: a section opened there, a value read there or
  // a field filled in there is about what the token holds, and a reader doing any of it has not asked to
  // select or advance anything. So a click that starts inside the body is left to the body.
  const fromDetail = (event) => !!detailEl && detailEl.contains(event.target);

  let clickTimer = null;
  if (onClick || onDblClick) {
    entry.element.classList.add('bjs-token-clickable');
    entry.element.addEventListener('click', (event) => {
      if (clickTimer || fromDetail(event)) {
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (onClick) {
          onClick(token, event);
        }
      }, 250);
    });
    entry.element.addEventListener('dblclick', (event) => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      if (onDblClick && !fromDetail(event)) {
        onDblClick(token, event);
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

    if (detailEl && renderDetail) {
      detailEl.replaceChildren();
      renderDetail(t, detailEl);
    }
  };
  update(token);

  return {
    element: entry.element,
    update,
    contentEl: detailEl,
    controlsEl: entry.controlsEl,
    token: () => token
  };
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
