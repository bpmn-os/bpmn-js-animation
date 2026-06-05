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

const $ = s => document.querySelector(s);
const svc = n => viewer.get(n);

function log(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('#log').prepend(d);
}

let counter = 0;
let outlined = null;      // node currently showing our (stack-aware) selection outline

// The token advanceToken acts on is the lib's *selected* token (blue ring) — read live, not
// cached: `selected` is carried across a move (Animation.js sendToken), so the token object
// tracks the dot to its new node. No stale {node,label}; the ring IS the advance target.
const selectedToken = () => {
  const sel = svc('animation').getSelectedTokens();
  return sel.length === 1 ? sel[0] : null;
};

const label = () => $('#label').value.trim();
const setLabel = l => { $('#label').value = l; };

// --- selection: the documented diagram-js `selection` service drives everything;
//     real shapes get the native (stack-aware via our OutlineProvider) outline. The
//     implicit process box is the one exception — the root isn't a selectable shape, so
//     we select it on background click and draw our own outline via `setNodeSelected`. ---

const selected = () => svc('selection').get()[0] || null;

function applyOutline(el) {
  // only the implicit process box needs our own outline; real shapes use the native one
  const id = el && is(el, 'bpmn:Process') ? el.id : null;
  if (outlined && outlined !== id) {
    svc('animation').setNodeSelected(outlined, false);
  }
  outlined = id;
  if (id) {
    svc('animation').setNodeSelected(id, true);
  }
}

// A node where advanceToken anchors a token at center: an event, or a pass-through gateway
// (exclusive, or any gateway with a single incoming flow) — mirrors the lib's rule.
function isCenter(el) {
  return is(el, 'bpmn:Event') ||
    is(el, 'bpmn:ExclusiveGateway') ||
    (is(el, 'bpmn:Gateway') && (el.incoming || []).length <= 1);
}

// Rebuild the select-aware action bar for the current selection.
function render() {
  const el = selected();
  applyOutline(el);
  $('#sel').textContent = el ? `${el.id} (${el.type})` : '—';

  const actions = $('#actions');
  actions.innerHTML = '';

  const sim = svc('simulation');

  // advance — drives the SELECTED token (blue ring), independent of node selection: a center
  // node (event, or a pass-through gateway) anchors at center; an activity takes a sweep position
  const token = selectedToken();
  if (token) {
    const tEl = svc('elementRegistry').get(token.node);
    const tag = `${token.label}@${token.node}`;
    const advance = args => () =>
      sim.advanceToken({ node: token.node, label: token.label, ...args })
        .then(() => log(`advanceToken(${tag}${args.position ? ', ' + args.position : ' → center'})`))
        .then(render)
        .catch(err => log('ERROR: ' + err.message));

    if (isCenter(tEl)) {
      const bounce = checkbox(actions, 'bounce');
      button(actions, `advance ${tag} → center`, () => advance({ bounce: bounce.checked })());
    } else if (is(tEl, 'bpmn:Activity') || is(tEl, 'bpmn:Process') || is(tEl, 'bpmn:Participant')) {
      const pos = select(actions, [ 'ready', 'entry', 'busy', 'completed', 'exit' ], 'busy');
      const bounce = checkbox(actions, 'bounce');
      button(actions, `advance ${tag}`, () => advance({ position: pos.value, bounce: bounce.checked })());
    }
  }

  // node-driven actions (createToken, forward) need a selected node
  if (!el) {
    return;
  }

  // createToken — start a process/participant instance
  if (is(el, 'bpmn:Process') || is(el, 'bpmn:Participant')) {
    button(actions, 'createToken', () => {
      const l = 'I' + (++counter);
      setLabel(l);
      run(() => sim.createToken({ node: el.id, label: l }), `createToken(${el.id}, ${l})`);
    });
  }

  // createToken — child of the scope's token, at a start event
  if (is(el, 'bpmn:StartEvent')) {
    button(actions, 'createToken (at start)', () =>
      run(() => sim.createToken({ node: el.id, label: label() }), `createToken(${el.id}, ${label()})`));
  }

  // forward — when a sequence flow is selected and a token rests on its source
  if (is(el, 'bpmn:SequenceFlow') && el.source && sim.getEntry(el.source.id, label())) {
    button(actions, `forward → ${el.target ? el.target.id : '?'}`, () => {
      sim.forwardToken({ node: el.source.id, label: label(), sequenceFlow: el.id })
        .then(() => log(`forwardToken(${el.source.id}, ${label()}, ${el.id})`))
        .then(render) // the selected token moved → refresh the advance bar for its new node
        .catch(err => log('ERROR: ' + err.message));
    });
  }

  // (stacked nodes scroll via double-click — see the element.dblclick handler below)
}

function run(fn, msg) {
  try { fn(); log(msg); render(); } catch (err) { log('ERROR: ' + err.message); }
}

function button(parent, text, fn) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', fn);
  parent.appendChild(b);
  return b;
}

function select(parent, opts, sel) {
  const s = document.createElement('select');
  opts.forEach(o => {
    const op = document.createElement('option');
    op.value = op.textContent = o;
    if (o === sel) op.selected = true;
    s.appendChild(op);
  });
  parent.appendChild(s);
  return s;
}

function checkbox(parent, text) {
  const l = document.createElement('label');
  const c = document.createElement('input');
  c.type = 'checkbox';
  l.appendChild(c);
  l.append(' ' + text);
  parent.appendChild(l);
  return c;
}

async function load(name) {
  $('#diagram').value = name;            // keep the selector in sync with what's shown
  await viewer.importXML(DIAGRAMS[name]); // fires diagram.clear → simulation resets
  viewer.get('canvas').zoom('fit-viewport', 'auto');
  viewer.get('simulation').autoFocus($('#autoFocus').checked);
  counter = 0;
  outlined = null;
  setLabel('');
  render();
  log(`loaded "${name}"`);
}

// documented diagram-js / AnimationAPI events drive selection + the current instance
viewer.get('eventBus').on('selection.changed', () => render());
viewer.get('eventBus').on('token.click', e => {
  // clicking a token toggles its blue ring (the lib's built-in selectTokenOnClick); the
  // selected token is what advanceToken acts on. Adopt its instance label + refresh.
  setLabel(e.label);
  render();
});
// the implicit process box is the root — not natively selectable; select it on bg click
viewer.get('eventBus').on('element.click', e => {
  if (is(e.element, 'bpmn:Process')) {
    svc('selection').select(e.element);
  }
});

// (double-click a stacked node to scroll — built into the animation module now)

$('#autoFocus').addEventListener('change', e => {
  viewer.get('simulation').autoFocus(e.target.checked);
  log('auto-focus ' + (e.target.checked ? 'on' : 'off'));
});

$('#clear').addEventListener('click', () => {
  viewer.get('simulation').clear();
  counter = 0;
  outlined = null;
  render();
  log('clear');
});

$('#diagram').addEventListener('change', e => load(e.target.value));

load($('#diagram').value);
