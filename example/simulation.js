import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

import AnimationModule from '../lib/index.js';
import '../assets/token-animation.css';

import processXML from './process.bpmn?raw';
import collaborationXML from './collaboration.bpmn?raw';

const DIAGRAMS = { process: processXML, collaboration: collaborationXML };

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

const $ = sel => document.querySelector(sel);
function log(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  $('#log').prepend(el);
}

let counter = 0;
let last = null; // the most recently created/advanced token: { node, label }

function targets() {
  const elementRegistry = viewer.get('elementRegistry');
  const pools = elementRegistry.filter(e => is(e, 'bpmn:Participant')).map(e => e.id);
  if (pools.length) {
    return pools;
  }
  const root = viewer.get('canvas').getRootElement();
  return root && is(root, 'bpmn:Process') ? [ root.id ] : [];
}

function refreshTargets() {
  const sel = $('#target');
  sel.innerHTML = '';
  targets().forEach(id => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = id;
    sel.appendChild(opt);
  });
}

function target() {
  return $('#target').value;
}

async function load(name) {
  $('#diagram').value = name;                // keep the selector in sync with what's shown
  await viewer.importXML(DIAGRAMS[name]);     // fires diagram.clear → simulation resets
  viewer.get('canvas').zoom('fit-viewport', 'auto');
  viewer.get('simulation').autoFocus($('#autoFocus').checked);
  counter = 0;
  last = null;
  $('#count').textContent = '0';
  refreshTargets();
  log(`loaded "${name}" — target: ${target()}`);
}

function on(id, fn) {
  $('#' + id).addEventListener('click', fn);
}

on('createToken', () => {
  const node = target();
  if (!node) {
    return log('no process/participant target');
  }
  const label = 'I' + (++counter);
  try {
    viewer.get('simulation').createToken(node, label);
    last = { node, label };
    $('#count').textContent = String(counter);
    log(`createToken(${node}, ${label}) → ${viewer.get('animation').getStackSize(node)} instance(s)`);
  } catch (err) {
    counter--;
    log('ERROR: ' + err.message);
  }
});

on('advance', () => {
  if (!last) {
    return log('create a token first');
  }
  const position = $('#position').value;
  const bounce = $('#bounce').checked;
  viewer.get('simulation').advanceToken(last.node, last.label, position, bounce)
    .then(() => log(`advanceToken(${last.node}, ${last.label}, ${position}${bounce ? ', bounce' : ''})`))
    .catch(err => log('ERROR: ' + err.message));
});

on('scrollBack', () => viewer.get('animation').scrollStack(target(), 'backward'));
on('scrollFwd', () => viewer.get('animation').scrollStack(target(), 'forward'));

on('clear', () => {
  viewer.get('simulation').clear();
  counter = 0;
  last = null;
  $('#count').textContent = '0';
  log('clear');
});

$('#autoFocus').addEventListener('change', e => {
  viewer.get('simulation').autoFocus(e.target.checked);
  log('auto-focus ' + (e.target.checked ? 'on' : 'off'));
});

$('#diagram').addEventListener('change', e => load(e.target.value));

// load whatever the selector currently shows (browsers restore it across reloads)
load($('#diagram').value);
