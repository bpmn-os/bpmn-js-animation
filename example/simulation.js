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
let miSeq = 0;            // suffix for MI sub-instance labels (e.g. "I1#1")
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

// A multi-instance activity (its token fans out into stacked sub-instances).
function isMI(el) {
  const lc = el && el.businessObject && el.businessObject.loopCharacteristics;
  return !!(lc && lc.$type === 'bpmn:MultiInstanceLoopCharacteristics');
}

// An event sub-process (its start event fires lazy, stacked instances).
function isEvtSp(el) {
  const bo = el && el.businessObject;
  return !!(bo && bo.$type === 'bpmn:SubProcess' && bo.triggeredByEvent);
}

// the token motion cues (state.animate); 'none' → no animation
const ANIM_EFFECTS = [ 'none', 'bounce', 'bounce-pause', 'pulse', 'pulse-pause', 'flip', 'flip-pause' ];
const anim = sel => (sel.value === 'none' ? null : sel.value);

// forkToken is offered while the instance is forkable at a gateway: the original still rests
// there (first fork = a move), or a branch already sits on one of its outflows (later forks).
function canFork(gatewayId, lbl) {
  return !!svc('simulation').getEntry(gatewayId, lbl) ||
    svc('animation').getTokens(t => t.label === lbl && t.node === gatewayId && t.state.sequenceFlow).length > 0;
}

// a same-label branch already resting on this exact flow at its source (placed by forkToken,
// or just any in-transit token) — i.e. there's something here to travel along it
function branchOnFlow(flow, lbl) {
  return svc('animation').getTokens(
    t => t.label === lbl && t.node === flow.source.id && t.state.sequenceFlow === flow.id
  ).length > 0;
}

// same-label branches that have arrived at a gateway on its incoming flows (joinable)
function arrivedBranches(gateway, lbl) {
  const incoming = new Set((gateway.incoming || []).map(f => f.id));
  return svc('animation').getTokens(
    t => t.label === lbl && t.node === gateway.id && incoming.has(t.state.sequenceFlow)
  );
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
  // when a sequence flow is selected the only advance offered is *along that flow* (below);
  // suppress the at-node center/sweep advance so the two forms don't both appear
  if (token && !(el && is(el, 'bpmn:SequenceFlow'))) {
    const tEl = svc('elementRegistry').get(token.node);
    const tag = `${token.label}@${token.node}`;
    const advance = args => () =>
      sim.advanceToken({ node: token.node, label: token.label, ...args })
        .then(() => log(`advanceToken(${tag}${args.position ? ', ' + args.position : ' → center'})`))
        .then(render)
        .catch(err => log('ERROR: ' + err.message));

    if (isCenter(tEl)) {
      const fx = select(actions, ANIM_EFFECTS, 'none');
      button(actions, `advance ${tag} → center`, () => advance({ animate: anim(fx) })());
    } else if (is(tEl, 'bpmn:Activity') || is(tEl, 'bpmn:Process') || is(tEl, 'bpmn:Participant')) {
      const pos = select(actions, [ 'entry', 'busy', 'completion' ], 'busy');
      const fx = select(actions, ANIM_EFFECTS, 'none');
      button(actions, `advance ${tag}`, () => advance({ position: pos.value, animate: anim(fx) })());
    }

    // consume — only an anchored token (one in transit on a flow can't be consumed directly,
    // but is torn down as part of an ancestor's subtree cascade)
    if (token.state.sequenceFlow == null) {
      button(actions, `consume ${tag}`, () =>
        sim.consumeToken({ node: token.node, label: token.label })
          .then(() => log(`consumeToken(${tag})`))
          .then(render)
          .catch(err => log('ERROR: ' + err.message)));
    }
  }

  // spawn MI sub-instances — when the selected token rests on an MI activity's incoming flow it
  // never enters; each click adds a stacked instance (until the first one runs and parks the
  // parent). Then select a sub (scroll the stack) and advance it (entry…exit) / consume it; the
  // last consume releases the parent onto the outgoing flow.
  if (token && token.state.sequenceFlow && isMI(svc('elementRegistry').get(token.node))) {
    button(actions, `spawn instance @ ${token.node}`, () => {
      const sub = `${token.label}#${++miSeq}`;
      run(() => sim.createToken({ node: token.node, label: sub }), `createToken(${token.node}, ${sub})`);
    });
  }

  // node-driven actions (createToken, advance-along-flow) need a selected node
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

  // createToken — a child at a (plain) start event, for the enclosing scope's ON-SCREEN instance.
  // The label follows the front instance of the pool/process (scroll to pick it), NOT a stale
  // input — so after scrolling, the child lands on the displayed instance.
  if (is(el, 'bpmn:StartEvent') && !isEvtSp(el.parent)) {
    const inst = el.parent && svc('animation').getCurrentStack(el.parent.id);
    if (inst) {
      button(actions, `createToken (at start, ${inst})`, () => {
        setLabel(inst);
        run(() => sim.createToken({ node: el.id, label: inst }), `createToken(${el.id}, ${inst})`);
      });
    }
  }

  // fire an event sub-process — each click is a new (non-interrupting) firing: a stacked child
  // of the enclosing-scope's on-screen instance. Scroll the box to see firings; select + consume.
  if (is(el, 'bpmn:StartEvent') && isEvtSp(el.parent)) {
    button(actions, `fire ${el.id}`, () => {
      const f = `${label() || 'I'}.e${++miSeq}`;
      run(() => sim.createToken({ node: el.id, label: f }), `createToken(${el.id}, ${f})`);
    });
  }

  // boundary event — arm a listener (a child of the host activity's token), then fire it
  // (interrupting): travel onto its outflow (auto-reparents to the scope) + consume the host.
  if (is(el, 'bpmn:BoundaryEvent') && el.host) {
    const host = el.host;
    const listener = sim.getToken(el.id, label());
    const out = (el.outgoing || [])[0];

    if (!listener && sim.getToken(host.id, label())) {
      button(actions, `arm listener @ ${el.id}`, () =>
        run(() => sim.createToken({ node: el.id, label: label() }), `createToken(${el.id}, ${label()})`));
    }
    if (listener && out) {
      button(actions, `fire → interrupt ${host.id}`, () => {
        sim.advanceToken({ node: el.id, label: label(), sequenceFlow: out.id })
          .then(() => sim.consumeToken({ node: host.id, label: label() }))
          .then(() => log(`fire boundary ${el.id} → consume ${host.id}`))
          .then(render)
          .catch(err => log('ERROR: ' + err.message));
      });
    }
  }

  // join — a (converging) gateway with ≥2 branches resting on its incoming flows
  if (is(el, 'bpmn:Gateway') && arrivedBranches(el, label()).length >= 2) {
    button(actions, 'join', () => {
      sim.joinTokens({ node: el.id, label: label() })
        .then(() => log(`joinTokens(${el.id}, ${label()})`))
        .then(render)
        .catch(err => log('ERROR: ' + err.message));
    });
  }

  // along a flow — when a sequence flow is selected. At a (diverging) gateway, `fork` places a
  // branch on the outflow (no travel) so the other outflows can be forked too; then `advance`
  // travels a placed branch (or just moves a token resting at the source) along the flow.
  if (is(el, 'bpmn:SequenceFlow') && el.source) {
    const src = el.source, tgt = el.target ? el.target.id : '?';
    const onFlow = branchOnFlow(el, label());

    if (is(src, 'bpmn:Gateway') && !onFlow && canFork(src.id, label())) {
      button(actions, `fork → ${tgt}`, () => {
        sim.forkToken({ node: src.id, label: label(), sequenceFlow: el.id })
          .then(() => log(`forkToken(${src.id}, ${label()}, ${el.id})`))
          .then(render)
          .catch(err => log('ERROR: ' + err.message));
      });
    } else if (onFlow || sim.getEntry(src.id, label())) {
      button(actions, `advance → ${tgt}`, () => {
        sim.advanceToken({ node: src.id, label: label(), sequenceFlow: el.id })
          .then(() => log(`advanceToken(${src.id}, ${label()}, ${el.id})`))
          .then(render) // the token moved → refresh the action bar for its new node
          .catch(err => log('ERROR: ' + err.message));
      });
    }
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

async function load(name) {
  $('#diagram').value = name;            // keep the selector in sync with what's shown
  await viewer.importXML(DIAGRAMS[name]); // fires diagram.clear → simulation resets
  viewer.get('canvas').zoom('fit-viewport', 'auto');
  viewer.get('simulation').autoFocus($('#autoFocus').checked);
  counter = 0;
  miSeq = 0;
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
  miSeq = 0;
  outlined = null;
  render();
  log('clear');
});

$('#diagram').addEventListener('change', e => load(e.target.value));

load($('#diagram').value);
