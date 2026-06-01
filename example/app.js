import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import TokenAnimationModule, { getRandomColor } from '../lib/index.js';
import '../assets/token-animation.css';

import diagramXML from './diagram.bpmn?raw';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ TokenAnimationModule ]
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

  const tokens = viewer.get('tokens');
  const elementRegistry = viewer.get('elementRegistry');
  const eventBus = viewer.get('eventBus');

  window.viewer = viewer;
  window.tokens = tokens;

  // populate the flow selectors from the diagram
  const flowIds = elementRegistry.filter(e => e.type === 'bpmn:SequenceFlow').map(e => e.id);
  const flowsSelect = document.querySelector('#sequenceFlow');
  flowIds.forEach(id => flowsSelect.add(new Option(id, id)));

  let currentNode = null;
  let currentToken = null; // { node, label, sequenceFlow }
  let counter = 0;

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

  // click an element -> current node (for createToken); click a token -> current token
  eventBus.on('element.click', e => {
    const el = e.element;
    if (el && !el.waypoints && el.businessObject && el.type !== 'bpmn:Process' && el.parent) {
      currentNode = el.id;
      renderReadouts();
      log('node: ' + el.id);
    }
  });

  eventBus.on('token.click', e => {
    currentToken = { node: e.node, label: e.label, sequenceFlow: e.sequenceFlow || null };
    renderReadouts();
    log(`token: ${e.label}@${e.node}${e.sequenceFlow ? ' on ' + e.sequenceFlow : ''}`);
  });

  on('createToken', () => {
    if (!currentNode) {
      return log('click a node first');
    }
    const label = 'T' + (++counter);
    const color = getRandomColor();
    const state = buildState();
    tokens.createToken(currentNode, label, color, state);
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
    tokens.sendToken(transitions).then(ts => {
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
    const t = tokens.setState(currentToken.node, currentToken.label, state, currentToken.sequenceFlow);
    currentToken = { node: t.node, label: t.label, sequenceFlow: t.state.sequenceFlow || null };
    renderReadouts();
    log(`setState(${t.node}, ${t.label}, ${JSON.stringify(state)})`);
  });

  on('removeToken', () => {
    if (!currentToken) {
      return log('click a token first');
    }
    tokens.removeToken(currentToken.node, currentToken.label, currentToken.sequenceFlow);
    log(`removeToken(${currentToken.node}, ${currentToken.label})`);
    currentToken = null;
    renderReadouts();
  });

  on('clear', () => {
    tokens.clear();
    currentToken = null;
    currentNode = null;
    counter = 0;
    renderReadouts();
    log('clear');
  });

  renderReadouts();
  log('click a node, then createToken; click a token to operate on it');
}
