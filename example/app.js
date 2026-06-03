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

  window.viewer = viewer;
  window.animation = animation;

  // populate the flow selectors from the diagram
  const flowIds = elementRegistry.filter(e => e.type === 'bpmn:SequenceFlow').map(e => e.id);
  const flowsSelect = document.querySelector('#sequenceFlow');
  flowIds.forEach(id => flowsSelect.add(new Option(id, id)));

  // the stack caps its drawn shapes at maxVisible copies -> maxVisible + 1 shapes total
  document.querySelector('#stackSize').max = animation.getMaxVisible() + 1;

  let currentNode = null;
  let currentToken = null; // { node, label, sequenceFlow }
  let counter = 0;

  const selectedNodes = new Set(); // node ids currently selected (multi-select)

  function renderReadouts() {
    document.querySelector('#cur-node').textContent = currentNode || '—';
    document.querySelector('#cur-token').textContent = currentToken
      ? `${currentToken.label}@${currentToken.node}${currentToken.sequenceFlow ? ' on ' + currentToken.sequenceFlow : ''}`
      : '—';
  }

  function selectedFlows() {
    return Array.from(document.querySelector('#sequenceFlow').selectedOptions).map(o => o.value);
  }

  // state for createToken / setState: position wins; else rest on the first selected flow
  function buildState() {
    const position = document.querySelector('#position').value;
    const flows = selectedFlows();
    const state = { bounce: document.querySelector('#bounce').checked };

    if (position) {
      state.position = position;
    } else if (flows.length) {
      state.sequenceFlow = flows[0];
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

  const sameToken = (t, node, label, sf) =>
    t.node === node && t.label === label && (t.state.sequenceFlow || null) === (sf || null);

  function setTokenSelected(node, label, sequenceFlow, selected) {
    if (selected) {
      animation.selectToken(node, label, sequenceFlow || undefined);
    } else {
      animation.deselectToken(node, label, sequenceFlow || undefined);
    }
  }

  function clickToken(node, label, sequenceFlow, additive) {
    const t = animation.getTokens(x => sameToken(x, node, label, sequenceFlow))[0];
    if (!t) {
      return;
    }
    if (additive) {
      setTokenSelected(node, label, sequenceFlow, !t.selected);
    } else {
      const selected = animation.getTokens(x => x.selected);
      const wasSole = selected.length === 1 && t.selected;
      selected.forEach(x => {
        if (x !== t) {
          setTokenSelected(x.node, x.label, x.state.sequenceFlow, false);
        }
      });
      setTokenSelected(node, label, sequenceFlow, !wasSole);
    }
    log(`tokens: [${animation.getTokens(x => x.selected).map(x => `${x.label}@${x.node}`).join(', ') || '—'}]`);
  }

  // click an element/token -> set it current + select it. Plain click selects only
  // that one (clears the rest); Shift-click adds to / toggles within the selection.
  eventBus.on('element.click', e => {
    const el = e.element;
    if (!el || el.waypoints || !el.businessObject) {
      return;
    }
    // clicking the empty background fires element.click with the root; for a pool-less
    // diagram that root IS the bpmn:Process — select it so it can be stacked (T4)
    if (el.type === 'bpmn:Process' || el.parent) {
      currentNode = el.id;
      renderReadouts();
      clickNode(el.id, !!(e.originalEvent && e.originalEvent.shiftKey));
    }
  });

  eventBus.on('token.click', e => {
    currentToken = { node: e.node, label: e.label, sequenceFlow: e.sequenceFlow || null };
    renderReadouts();
    clickToken(e.node, e.label, e.sequenceFlow || null, !!(e.originalEvent && e.originalEvent.shiftKey));
  });

  // double-click a stacked node to scroll it: forward, or backward with Shift held
  eventBus.on('element.dblclick', e => {
    const el = e.element;
    // any stacked node/connection-free shape — including the implicit process root
    // (double-click the empty background) — scrolls; Shift reverses
    if (!el || el.waypoints || !el.businessObject) {
      return;
    }
    if (animation.getStackSize(el.id) <= 1) {
      return; // only stacked nodes scroll
    }
    const dir = e.originalEvent && e.originalEvent.shiftKey ? 'backward' : 'forward';
    log(`scrollStack(${el.id}, ${dir})`);
    animation.scrollStack(el.id, dir);
  });

  on('createToken', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    const label = 'T' + (++counter);
    const color = getRandomColor();
    const state = buildState();
    animation.createToken(currentNode, label, color, state);
    currentToken = { node: currentNode, label, sequenceFlow: state.sequenceFlow || null };
    renderReadouts();
    log(`createToken(${currentNode}, ${label}, ${color}, ${JSON.stringify(state)})`);
  });

  on('sendToken', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    const flows = selectedFlows();
    if (!flows.length) {
      return log('select sequenceFlow(s) to travel along');
    }
    const position = document.querySelector('#position').value;
    const bounce = document.querySelector('#bounce').checked;
    // land at the chosen position, or (no position) rest on each travel flow
    const transitions = flows.map(sequenceFlow => ({
      node: currentToken.node, label: currentToken.label, sequenceFlow,
      state: position ? { position, bounce } : { sequenceFlow, bounce }
    }));
    const label = currentToken.label;
    log(`sendToken(${JSON.stringify(transitions.map(t => ({ node: t.node, label, sequenceFlow: t.sequenceFlow })))})`);
    animation.sendToken(transitions).then(ts => {
      // single move -> follow it; split -> selection is ambiguous, drop it
      currentToken = ts.length === 1
        ? { node: ts[0].node, label, sequenceFlow: ts[0].state.sequenceFlow || null }
        : null;
      renderReadouts();
      log('landed → ' + ts.map(t => t.node).join(', '));
    }).catch(err => log('ERROR: ' + err.message));
  });

  on('setState', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    const state = buildState();
    const t = animation.setState(currentToken.node, currentToken.label, state, currentToken.sequenceFlow);
    currentToken = { node: t.node, label: t.label, sequenceFlow: t.state.sequenceFlow || null };
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

  const POSITIONS = [
    'top-left', 'top-middle', 'top-right',
    'center-left', 'center-middle', 'center-right',
    'bottom-left', 'bottom-middle', 'bottom-right'
  ];
  const rand = n => Math.floor(Math.random() * n);
  const pick = arr => arr[rand(arr.length)];

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
    return kids.filter(c => !c.waypoints && c.businessObject);
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
          animation.createToken(node, `t${++seq}`, getRandomColor(), { position: pick(POSITIONS) }, indices);
        }

        children.forEach(child => {
          if (isStackable(child)) {
            populate(child.id, indices); // nested stack within this instance
          } else {
            for (let j = 0, k = rand(3); j < k; j++) { // 0..2 scope tokens
              animation.createToken(child.id, `t${++seq}`, getRandomColor(), { position: pick(POSITIONS) }, indices);
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
    animation.removeToken(currentToken.node, currentToken.label, currentToken.sequenceFlow);
    log(`removeToken(${currentToken.node}, ${currentToken.label})`);
    currentToken = null;
    renderReadouts();
  });

  let filtering = false;

  on('filter', () => {
    const btn = document.querySelector('#filter');

    if (filtering) {
      animation.setFilter(null);
      filtering = false;
      btn.textContent = 'filter color';
      log('show all');
      return;
    }

    const t = currentToken && animation.getTokens(x =>
      x.node === currentToken.node &&
      x.label === currentToken.label &&
      (x.state.sequenceFlow || null) === (currentToken.sequenceFlow || null)
    )[0];

    if (!t) {
      return log('select a token first');
    }

    animation.setFilter(x => x.color === t.color);
    filtering = true;
    btn.textContent = 'show all';
    log('filter to color ' + t.color);
  });

  on('clear', () => {
    animation.clear();
    animation.setFilter(null);
    selectedNodes.clear();
    filtering = false;
    document.querySelector('#filter').textContent = 'filter color';
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
