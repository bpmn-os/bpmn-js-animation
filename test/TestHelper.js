import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import BpmnModeler from 'bpmn-js/lib/Modeler';

import SidePanelModule from 'bpmn-js-side-panel';

// Boot with both opt-in tools (each pulls in the enabling API via `__depends__`) so specs can reach
// `simulator` (record) and `animator` (replay) alongside `primitives` + `animation`.
import { SimulatorModule, AnimatorModule, TokenPanelModule, AnimationModule, ModeModule } from '../lib/index.js';

let viewer;
let container;

/**
 * Returns a beforeEach-friendly function that boots a NavigatedViewer with the
 * token-animation module and imports the given diagram. Resolves when ready.
 *
 * @param {string} xml
 * @param {object} [config] extra viewer config (e.g. { animation: { maxVisible } })
 */
export function bootstrap(xml, config = {}) {
  return function() {
    container = document.createElement('div');
    container.style.width = '900px';
    container.style.height = '600px';
    document.body.appendChild(container);

    viewer = new BpmnViewer({
      container,
      additionalModules: [ SimulatorModule, AnimatorModule ],
      ...config
    });

    installStackShims(viewer.get('primitives'));

    // the bundled `simulator` turns on `animation.autoFocus` (the interactive default); the
    // API-level specs assert the autofocus-OFF default (front = first instance), so reset it —
    // the simulator's own focus behaviour is exercised in SimulatorSpec where it matters.
    viewer.get('animation').autoFocus(false);

    return viewer.importXML(xml);
  };
}

/**
 * The same, with a side panel and the Tokens tab. The side panel needs the canvas and its own slot to
 * be siblings under one wrapper, so the container built here holds both, and the viewer renders into
 * the canvas child rather than into the container itself.
 *
 * @param {string} xml
 * @param {object} [config] extra viewer config (e.g. { tokenPanel: { renderTokenDetail } })
 */
export function bootstrapPanel(xml, config = {}) {
  return function() {
    container = document.createElement('div');
    container.style.width = '900px';
    container.style.height = '600px';
    document.body.appendChild(container);

    const canvas = document.createElement('div');
    const slot = document.createElement('div');
    container.appendChild(canvas);
    container.appendChild(slot);

    viewer = new BpmnViewer({
      container: canvas,
      additionalModules: [ SimulatorModule, AnimatorModule, SidePanelModule, TokenPanelModule ],
      sidePanel: { parent: slot },
      ...config
    });

    installStackShims(viewer.get('primitives'));
    viewer.get('animation').autoFocus(false);

    return viewer.importXML(xml);
  };
}

/**
 * The same as {@link bootstrap}, on a full **Modeler**, for the specs that are about what modelling a mode
 * permits: only a modeller has the `modeling`, `dragging` and `contextPad` services there is anything to
 * permit of.
 *
 * @param {string} xml
 * @param {object} [config] extra modeller config, e.g. `{ mode: { exceptions } }`
 */
export function bootstrapModeler(xml, config = {}) {
  return function() {
    container = document.createElement('div');
    container.style.width = '900px';
    container.style.height = '600px';
    document.body.appendChild(container);

    viewer = new BpmnModeler({
      container,
      additionalModules: [ AnimationModule, ModeModule ],
      ...config
    });

    return viewer.importXML(xml);
  };
}

// The token rows of the Tokens tab, in display order. Scoped to the inspector's lists, since the
// panel's own form rows (the Instantiate group's fields) carry the same class for their styling.
export function rows() {
  return Array.from(document.querySelectorAll('.bjs-token-inspector .bjs-list > .bjs-token-entry'));
}

/** The node tag shown on a token row. */
export function rowNode(row) {
  return row.querySelector('.bjs-token-node').textContent;
}

// Count/index conveniences the specs use, kept out of the production service (it's key-based:
// setStacks/getStacks/getCurrentStack/moveTo*). Attached per-instance here so existing call-sites
// — get('primitives').setStackSize(node, n), getStackSize(node), setStackIndex(node, i) — still work.
function installStackShims(animation) {
  animation.getStackSize = node => animation.getStacks(node).length;

  animation.setStackSize = (node, n, ctx) => {
    n = Math.floor(n) || 0;
    // numeric keys 0..n-1, preserving the current order's arrangement where it still fits
    const current = ctx === undefined ? animation.getStacks(node) : [];
    const keys = current.filter(k => k < n);
    for (let i = 0; i < n; i++) {
      if (!keys.includes(i)) keys.push(i);
    }
    animation.setStacks(node, keys, ctx);
  };

  animation.setStackIndex = (node, index) => {
    const size = animation.getStacks(node).length;
    if (size <= 1) {
      return;
    }
    animation.moveToFront(node, ((Math.floor(index) || 0) % size + size) % size);
  };
}

export function cleanup() {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }

  if (container) {
    container.remove();
    container = null;
  }
}

export function get(name) {
  return viewer.get(name);
}

export function getViewer() {
  return viewer;
}

/** All rendered token dots (excludes the overflow marker). */
export function dots() {
  return Array.from(document.querySelectorAll('.bts-token-count:not(.bts-overflow)'));
}

/** The overflow "+N" marker element, or null. */
export function marker() {
  return document.querySelector('.bts-token-count.bts-overflow');
}
