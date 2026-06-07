import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

import AnimationModule, { getRandomColor } from '../lib/index.js';
import '../assets/token-animation.css';

import diagramXML from './diagram.bpmn?raw';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

const logEl = document.querySelector('#log');

function log(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  logEl.prepend(el);
}

function on(id, fn) {
  document.querySelector('#' + id).addEventListener('click', () => {
    try {
      fn();
    } catch (err) {
      log('ERROR: ' + err.message);
      console.error(err);
    }
  });
}

main();

async function main() {
  await viewer.importXML(diagramXML);
  viewer.get('canvas').zoom('fit-viewport');

  const animation = viewer.get('animation');
  const elementRegistry = viewer.get('elementRegistry');
  const eventBus = viewer.get('eventBus');

  // count-based convenience for this playground — the service itself is key-based
  // (setStacks/getStacks); here we just want "N copies" keyed 0..n-1.
  animation.setStackSize = (node, n, ctx) => {
    const keys = Array.from({ length: Math.floor(n) || 0 }, (_, i) => i);
    animation.setStacks(node, keys, ctx);
  };

  window.viewer = viewer;
  window.animation = animation;

  // the stack caps its drawn shapes at maxVisible copies -> maxVisible + 1 shapes total
  document.querySelector('#stackSize').max = animation.getMaxVisible() + 1;

  // the single "location" dropdown = the 9 anchor positions + the current node's connected
  // sequence flows (added dynamically). Picking a flow puts the token *on* that flow.
  // the 9 named presets map to { left, top } fractions (0 = left/top edge, 1 = right/bottom)
  // left/top are fractions of the shape; voffset is a constant px nudge. above-* sit 20px
  // above the top edge, below-* sit 20px below the bottom edge.
  const POSITIONS = [
    { label: 'above-left', left: 0, top: 0, voffset: -20 }, { label: 'above-middle', left: 0.5, top: 0, voffset: -20 }, { label: 'above-right', left: 1, top: 0, voffset: -20 },
    { label: 'top-left', left: 0, top: 0 }, { label: 'top-middle', left: 0.5, top: 0 }, { label: 'top-right', left: 1, top: 0 },
    { label: 'center-left', left: 0, top: 0.5 }, { label: 'center-middle', left: 0.5, top: 0.5 }, { label: 'center-right', left: 1, top: 0.5 },
    { label: 'bottom-left', left: 0, top: 1 }, { label: 'bottom-middle', left: 0.5, top: 1 }, { label: 'bottom-right', left: 1, top: 1 },
    { label: 'below-left', left: 0, top: 1, voffset: 20 }, { label: 'below-middle', left: 0.5, top: 1, voffset: 20 }, { label: 'below-right', left: 1, top: 1, voffset: 20 }
  ];
  const POSITION_BY_LABEL = new Map(POSITIONS.map(p => [ p.label, p ]));

  function refreshLocations(node) {
    const sel = document.querySelector('#location');
    const prev = sel.value;
    sel.innerHTML = '';
    POSITIONS.forEach(p => sel.add(new Option(p.label, p.label)));

    const el = node && elementRegistry.get(node);
    const flows = el ? [ ...(el.incoming || []), ...(el.outgoing || []) ].filter(c => is(c, 'bpmn:SequenceFlow')) : [];
    if (flows.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'on sequence flow';
      flows.forEach(f => grp.appendChild(new Option(f.id, f.id)));
      sel.appendChild(grp);
    }

    if (Array.from(sel.options).some(o => o.value === prev)) {
      sel.value = prev;
    }
  }
  refreshLocations(null);

  let currentNode = null;
  let currentToken = null; // { node, label, sequenceFlow }
  let counter = 0;

  const selectedNodes = new Set(); // node ids currently selected (multi-select)

  function renderReadouts() {
    document.querySelector('#cur-node').textContent = currentNode || '—';
    document.querySelector('#cur-token').textContent = currentToken
      ? `${currentToken.label}@${currentToken.node}${currentToken.sequenceFlow ? ' on ' + currentToken.sequenceFlow : ''}`
      : '—';
    // offer the flows of whatever node is in focus (token's node, else the selected node)
    refreshLocations(currentToken ? currentToken.node : currentNode);
  }

  // state for createToken / setState from the location dropdown: an anchor position, or
  // (when a connected flow is picked) resting on that sequence flow
  function buildState() {
    const value = document.querySelector('#location').value;
    const state = { bounce: document.querySelector('#bounce').checked };
    const preset = POSITION_BY_LABEL.get(value);

    if (preset) {
      state.position = { left: preset.left, top: preset.top, hoffset: preset.hoffset, voffset: preset.voffset };
    } else if (value) {
      state.sequenceFlow = value;
    }

    return state;
  }

  // --- node selection (multi-select tracked in `selectedNodes`) ---

  function setNodeSelected(node, selected) {
    animation.setNodeSelected(node, selected);
    if (selected) {
      selectedNodes.add(node);
    } else {
      selectedNodes.delete(node);
    }
  }

  function clickNode(node, additive) {
    if (additive) {
      // Shift-click: toggle this one, leave the rest of the selection alone
      setNodeSelected(node, !selectedNodes.has(node));
    } else {
      const wasSole = selectedNodes.size === 1 && selectedNodes.has(node);
      Array.from(selectedNodes).forEach(n => n !== node && setNodeSelected(n, false));
      // plain click makes this the only selection; clicking the sole selection clears it
      setNodeSelected(node, !wasSole);
    }
    log(`nodes: [${Array.from(selectedNodes).join(', ') || '—'}]`);
  }

  // --- token selection (state lives on the token; read back via getTokens) ---

  // normalize an instance map the way the library keys it (non-zero entries, sorted) so
  // tokens are matched by the same identity regardless of how the map was spelled
  const ctxKey = indices =>
    !indices ? '' : Object.keys(indices).filter(id => indices[id]).sort().map(id => `${id}:${indices[id]}`).join(',');

  const sameToken = (t, node, label, sf, stackIndices) =>
    t.node === node && t.label === label &&
    (t.state.sequenceFlow || null) === (sf || null) &&
    ctxKey(t.stackIndices) === ctxKey(stackIndices);

  // (clicking a token to select it — the blue ring — is built into the animation module)

  // reflect the current token's state in the bounce + location controls (so editing
  // continues from where the token is). Run after refreshLocations so the flow option exists.
  function syncControlsToToken() {
    if (!currentToken) {
      return;
    }
    const t = animation.getTokens(x => sameToken(x, currentToken.node, currentToken.label, currentToken.sequenceFlow, currentToken.stackIndices))[0];
    if (!t) {
      return;
    }
    document.querySelector('#bounce').checked = !!t.state.bounce;
    const sel = document.querySelector('#location');
    if (t.state.sequenceFlow) {
      sel.value = t.state.sequenceFlow;
    } else if (t.state.position) {
      const ps = t.state.position;
      const p = POSITIONS.find(o =>
        o.left === ps.left && o.top === ps.top && (o.hoffset || 0) === ps.hoffset && (o.voffset || 0) === ps.voffset);
      if (p) {
        sel.value = p.label;
      }
    }
  }

  // click an element/token -> set it current + select it. Plain click selects only
  // that one (clears the rest); Shift-click adds to / toggles within the selection.
  eventBus.on('element.click', e => {
    let el = e.element;
    if (!el || el.waypoints || !el.businessObject) {
      return;
    }
    // clicking the empty background fires element.click with the root: a pool-less
    // diagram's root IS the bpmn:Process, and a drilled-into sub-process plane's root maps
    // to its sub-process shape (shapeOf) — select either so it can be stacked/scrolled
    el = shapeOf(el);
    if (el.type === 'bpmn:Process' || el.parent) {
      currentNode = el.id;
      renderReadouts();
      clickNode(el.id, !!(e.originalEvent && e.originalEvent.shiftKey));
    }
  });

  eventBus.on('token.click', e => {
    currentToken = { node: e.node, label: e.label, sequenceFlow: e.sequenceFlow || null, stackIndices: e.stackIndices };
    renderReadouts();
    syncControlsToToken(); // show the token's current bounce + location in the controls
    // (selecting the clicked token — the blue ring — is built into the animation module now)
  });

  // (double-click a stacked node to scroll it — now built into the animation module)

  on('createToken', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    const label = 'T' + (++counter);
    const color = getRandomColor();
    const state = buildState();
    // tag the token with the instance currently on screen, so it shows on a stacked node
    // that's scrolled past instance 0 (otherwise it'd land on the hidden base instance)
    const stackIndices = animation.getCurrentStacks(currentNode);
    animation.createToken(currentNode, label, color, state, stackIndices);
    currentToken = { node: currentNode, label, sequenceFlow: state.sequenceFlow || null, stackIndices };
    renderReadouts();
    log(`createToken(${currentNode}, ${label}, ${color}, ${JSON.stringify(state)}, ${JSON.stringify(stackIndices)})`);
  });

  on('sendToken', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    // the token must already rest on a flow — put it there with setState (select a flow,
    // then setState); sendToken just travels along that flow to the far node
    if (!currentToken.sequenceFlow) {
      return log('put the token on a sequenceFlow first (select a flow, then setState)');
    }
    const { node, label, sequenceFlow, stackIndices } = currentToken;
    log(`sendToken(${node}, ${label}, on ${sequenceFlow})`);
    animation.sendToken([ { node, label, sequenceFlow, stackIndices } ]).then(ts => {
      const t = ts[0];
      currentToken = { node: t.node, label, sequenceFlow: t.state.sequenceFlow || null, stackIndices: t.stackIndices };
      renderReadouts();
      log(`traveled → ${t.node} (still on ${sequenceFlow}; setState to anchor it)`);
    }).catch(err => log('ERROR: ' + err.message));
  });

  on('setState', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    const state = buildState();
    const selector = { sequenceFlow: currentToken.sequenceFlow || undefined, stackIndices: currentToken.stackIndices };
    const t = animation.setState(currentToken.node, currentToken.label, state, selector);
    currentToken = { node: t.node, label: t.label, sequenceFlow: t.state.sequenceFlow || null, stackIndices: t.stackIndices };
    renderReadouts();
    log(`setState(${t.node}, ${t.label}, ${JSON.stringify(state)})`);
  });

  on('setStackSize', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    const size = +document.querySelector('#stackSize').value;
    animation.setStackSize(currentNode, size);
    log(`setStackSize(${currentNode}, ${size})`);
  });

  // --- instance-stack demo -----------------------------------------------------------
  // Stack a legitimately-stackable element (process / multi-instance activity /
  // non-interrupting event sub-process) into N instances and give each instance its own
  // tokens (tagged with `stackIndices`). Scrolling resolves which instance shows — no
  // callback; the tokens carry their membership.

  const rand = n => Math.floor(Math.random() * n);
  const pick = arr => arr[rand(arr.length)];

  // where a random token sits: a corner for a process/activity, centered for events/gateways
  const CORNERS = [ { left: 0, top: 1 }, { left: 1, top: 0 }, { left: 0, top: 0 }, { left: 1, top: 1 } ];
  function randomPosition(elId) {
    const el = elementRegistry.get(elId);
    const corner = el && (is(el, 'bpmn:Activity') || is(el, 'bpmn:Process'));
    return corner ? pick(CORNERS) : { left: 0.5, top: 0.5 };
  }

  // a collapsed sub-process's children hang off a separate drill-plane root (id
  // `<id>_plane`, businessObject = the sub-process). Map that root to the shape element
  // on the parent plane so ancestor walks cross the boundary.
  function shapeOf(el) {
    const bo = el.businessObject;
    if (bo && el.id !== bo.id) {
      const shape = elementRegistry.get(bo.id);
      if (shape) {
        return shape;
      }
    }
    return el;
  }

  function isDescendant(childId, ancestorId) {
    let el = elementRegistry.get(childId);
    el = el && el.parent;
    while (el) {
      el = shapeOf(el);
      if (el.id === ancestorId) {
        return true;
      }
      el = el.parent;
    }
    return false;
  }

  // flow-node children of a node — bridging a collapsed sub-process (whose shape has no
  // children) to its drill-plane root, where the real children live. This lets the demo
  // drive stacks/tokens on drilled-in children through the ordinary API.
  function childrenOf(nodeId) {
    const el = elementRegistry.get(nodeId);
    let kids = (el && el.children) || [];
    if (!kids.length) {
      const planeRoot = elementRegistry.get(nodeId + '_plane');
      if (planeRoot) {
        kids = planeRoot.children || [];
      }
    }
    // flow nodes only (excludes connections + data objects); also drop external labels,
    // which share their target's businessObject so `is(label, 'bpmn:FlowNode')` is true
    return kids.filter(c => is(c, 'bpmn:FlowNode') && !c.labelTarget);
  }

  // a node you may stack: the process, a multi-instance activity, or a non-interrupting
  // event sub-process
  function isStackable(el) {
    if (!el || !el.businessObject) {
      return false;
    }
    const bo = el.businessObject;
    if (is(el, 'bpmn:Process')) {
      return true;
    }
    if (bo.loopCharacteristics && bo.loopCharacteristics.$type === 'bpmn:MultiInstanceLoopCharacteristics') {
      return true;
    }
    if (is(el, 'bpmn:SubProcess') && bo.triggeredByEvent) {
      const start = (bo.flowElements || []).find(fe => fe.$type === 'bpmn:StartEvent');
      return !!(start && start.isInterrupting === false);
    }
    return false;
  }

  on('randomInstances', () => {
    // default to the (implicit) process when nothing is selected
    const root = viewer.get('canvas').getRootElement();
    const target = currentNode || (root && is(root, 'bpmn:Process') ? root.id : null);
    const el = target && elementRegistry.get(target);

    if (!isStackable(el)) {
      return log('select a stackable node first: process / MI activity / non-interrupting event sub-process');
    }

    currentNode = target; // so the scroll buttons + readouts act on it
    renderReadouts();

    // drop any existing tokens + stacks at / under the target, then rebuild
    animation.getTokens(t => t.node === target || isDescendant(t.node, target))
      .forEach(t => animation.removeToken(t.node, t.label, { sequenceFlow: t.state.sequenceFlow, stackIndices: t.stackIndices }));
    elementRegistry.filter(e => isDescendant(e.id, target)).forEach(e => animation.setStackSize(e.id, 0));

    let seq = 0;

    // recursively stack `node` (a stackable element) in the given ancestor `ctx`, giving
    // each of its instances its own tokens and — for any stackable child — its own nested
    // stack (a different size per outer instance, declared via the ctx)
    const populate = (node, ctx) => {
      const count = 2 + rand(3); // 2..4 instances
      animation.setStackSize(node, count, ctx);

      const children = childrenOf(node);

      for (let i = 0; i < count; i++) {
        const indices = Object.assign({}, ctx, { [node]: i });

        // a token on the element itself (at-node / process-box / MI-activity token)
        if (Math.random() < 0.6) {
          animation.createToken(node, `t${++seq}`, getRandomColor(), { position: randomPosition(node) }, indices);
        }

        children.forEach(child => {
          if (isStackable(child)) {
            populate(child.id, indices); // nested stack within this instance
          } else {
            for (let j = 0, k = rand(3); j < k; j++) { // 0..2 scope tokens
              animation.createToken(child.id, `t${++seq}`, getRandomColor(), { position: randomPosition(child.id) }, indices);
            }
          }
        });
      }
    };

    populate(target, {});
    log(`randomInstances(${target})`);
  });

  on('scrollBack', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    log(`scrollStack(${currentNode}, backward)`);
    animation.scrollStack(currentNode, 'backward');
  });

  on('scrollFwd', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    log(`scrollStack(${currentNode}, forward)`);
    animation.scrollStack(currentNode, 'forward');
  });

  on('throwIcon', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    log('throwIcon(' + currentNode + ')');
    animation.throwIcon(currentNode);
  });

  on('catchIcon', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    log('catchIcon(' + currentNode + ')');
    animation.catchIcon(currentNode);
  });

  on('removeToken', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    animation.removeToken(currentToken.node, currentToken.label,
      { sequenceFlow: currentToken.sequenceFlow || undefined, stackIndices: currentToken.stackIndices });
    log(`removeToken(${currentToken.node}, ${currentToken.label})`);
    currentToken = null;
    renderReadouts();
  });

  on('clear', () => {
    animation.clear();
    selectedNodes.clear();
    document.querySelector('#stackSize').value = 1;
    currentToken = null;
    currentNode = null;
    counter = 0;
    renderReadouts();
    log('clear');
  });

  renderReadouts();
  log('click a node/token to select it (Shift-click for multi-select); createToken/sendToken operate on the current one');
}
