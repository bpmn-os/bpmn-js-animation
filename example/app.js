import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

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
    if (el && !el.waypoints && el.businessObject && el.type !== 'bpmn:Process' && el.parent) {
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
    currentToken = null;
    currentNode = null;
    counter = 0;
    renderReadouts();
    log('clear');
  });

  renderReadouts();
  log('click a node/token to select it (Shift-click for multi-select); createToken/sendToken operate on the current one');
}
