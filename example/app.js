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

  // poke from the browser console: tokens.createToken('Task_1', 'X', 'tomato')
  window.viewer = viewer;
  window.tokens = tokens;

  viewer.get('eventBus').on('token.click', e => {
    log(`click: { node: ${e.node}, label: ${e.label} }`);
  });
  viewer.get('eventBus').on('token.overflow.click', e => {
    log(`overflow @ ${e.node}: ${e.hidden.map(h => h.label).join(', ')}`);
  });

  // track where token "A" currently is + the transitions it took, so the step buttons
  // can send it forward and the rewind button can send it back
  let aNode = null;
  const aHistory = []; // [{ flow, from }]

  // mint a color per instance once, then reuse it consistently
  const colorA = getRandomColor();
  const colorB = getRandomColor();

  on('create-a', () => {
    tokens.createToken('StartEvent_1', 'A', colorA);
    aNode = 'StartEvent_1';
    aHistory.length = 0;
    log(`createToken(StartEvent_1, A, ${colorA})`);
  });

  on('create-b', () => {
    tokens.createToken('StartEvent_1', 'B', colorB);
    log(`createToken(StartEvent_1, B, ${colorB})`);
  });

  on('a-1', () => sendA('Flow_1', 'Task_1', 'A → Task_1'));
  on('a-2', () => sendA('Flow_2', 'Gateway_1', 'A → Gateway'));

  on('rewind', () => {
    if (!aNode || !aHistory.length) {
      return log('nothing to rewind');
    }

    // re-send A along the flow it last arrived on; an incoming flow animates
    // in reverse back to its source
    const { flow, from } = aHistory.pop();
    log(`rewind A along ${flow} (incoming flow → reverse)`);
    tokens.sendToken([ { node: aNode, label: 'A', flow } ]).then(() => log('rewound to ' + from));
    aNode = from;
  });

  on('split', () => {
    if (!aNode) {
      return log('move A to the gateway first');
    }
    log('split A: [Gateway_1→Flow_3, Gateway_1→Flow_4]');
    tokens.sendToken([
      { node: 'Gateway_1', label: 'A', flow: 'Flow_3' },
      { node: 'Gateway_1', label: 'A', flow: 'Flow_4' }
    ]).then(ts => log('A split ✓ → ' + ts.map(t => t.node).join(' + ')));
    aNode = null; // A now lives at two nodes
    aHistory.length = 0;
  });

  on('join', () => {
    // inverse of the split: two sources, incoming flows → both reverse to
    // Gateway_1 and merge into one token
    log('join A: [Task_2←Flow_3, Task_3←Flow_4] → Gateway_1');
    tokens.sendToken([
      { node: 'Task_2', label: 'A', flow: 'Flow_3' },
      { node: 'Task_3', label: 'A', flow: 'Flow_4' }
    ]).then(ts => log('A joined ✓ → ' + [ ...new Set(ts.map(t => t.node)) ].join(', ')));
    aNode = 'Gateway_1'; // merged back to a single node
  });

  on('spawn', () => {
    // distinct CSS color formats to prove pass-through; 5 > maxVisible(3)+1 → 3 dots + "+2"
    const colors = [ 'tomato', '#756bb1', 'rgb(49,163,84)', 'hsl(45, 90%, 50%)', 'steelblue' ];
    colors.forEach((c, i) => tokens.createToken('Gateway_1', 'S' + (i + 1), c));
    log('spawned 5 @ Gateway_1 → expect 3 dots + "+2" marker');
  });

  on('remove-a', () => {
    // A may be at several nodes after a split — remove every one
    const as = tokens.getTokens(t => t.label === 'A');

    if (!as.length) {
      return log('no A tokens to remove');
    }

    as.forEach(t => tokens.removeToken(t.node, 'A'));
    aNode = null;
    aHistory.length = 0;
    log('removeToken A @ ' + as.map(t => t.node).join(', '));
  });

  on('clear', () => {
    tokens.clear();
    aNode = null;
    aHistory.length = 0;
    log('clear');
  });

  log('ready — Create A, then move it along the flows');

  function sendA(flow, target, label) {
    if (!aNode) {
      return log('create A first');
    }
    log('send A along ' + flow);
    aHistory.push({ flow, from: aNode });
    tokens.sendToken([ { node: aNode, label: 'A', flow } ]).then(() => log(label + ' ✓ arrived'));
    aNode = target; // optimistic: A is addressable at the target immediately
  }
}
