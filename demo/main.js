import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

// The headline drop-in module (same shape as adding bpmn-js-token-simulation): load it and the
// simulation is driven entirely by double-clicking — no orchestration code here. This demo only
// loads diagrams and **logs what the simulator does to the console**; it owns no token state.
import SimulatorModule from '../lib/index.js';
import '../assets/token-animation.css';

// bundled example models (a curated showcase of the elements the simulator supports)
import tasksXML from '../examples/tasks.bpmn?raw';
import gatewaysXML from '../examples/gateways.bpmn?raw';
import subprocessXML from '../examples/subprocess.bpmn?raw';
import linkEventsXML from '../examples/link-events.bpmn?raw';
import eventBasedXML from '../examples/event-based-gateway.bpmn?raw';
import processXML from '../examples/process.bpmn?raw';
import collaborationXML from '../examples/collaboration.bpmn?raw';

const EXAMPLES = [
  { id: 'tasks', label: 'Tasks (start → task → end)', xml: tasksXML },
  { id: 'gateways', label: 'Gateways (inclusive split / join + boundary)', xml: gatewaysXML },
  { id: 'event-based-gateway', label: 'Event-based gateway (race)', xml: eventBasedXML },
  { id: 'link-events', label: 'Link events (throw → catch)', xml: linkEventsXML },
  { id: 'subprocess', label: 'Sub-process (drill in/out, error/escalation, event-sub)', xml: subprocessXML },
  { id: 'process', label: 'Process (parallel + loop + multi-instance)', xml: processXML },
  { id: 'collaboration', label: 'Collaboration (two pools, message flows)', xml: collaborationXML }
];

const $ = s => document.querySelector(s);

// The viewer is rebuilt for **every** diagram load — a fresh NavigatedViewer guarantees a clean slate
// (no in-flight animations, overlays, ghost layers, or stack state from the previous run racing with
// the new import). The current services are read off whichever viewer is live.
let viewer = null;
let simulation = null;
let animation = null;
let prev = new Map(); // token -> its `where(...)` description last frame (the diff baseline)

// --- console logging: observed events + the resulting token actions ----------------------------

// A short, readable position for a token: its node + lifecycle phase, or the flow it rests on.
function where(token) {
  if (token.state.sequenceFlow) {
    return `flow ${token.state.sequenceFlow}`;
  }
  const entry = simulation.getEntry(token.node, token.label, token.state.sequenceFlow || undefined);
  const phase = entry && entry.position;
  return phase ? `${token.node} (${phase})` : token.node;
}

const styleEvent = 'color:#06c;font-weight:bold';
const styleAdd = 'color:#0a0';
const styleMove = 'color:#555';
const styleDrop = 'color:#c00';
const styleNoop = 'color:#999';

// Log an **observed input event** factually (never the intended outcome).
function logEvent(msg) {
  console.log(`%c▸ ${msg}`, styleEvent);
}

// Diff the live token set against the previous frame and log the **resulting actions** the simulator
// actually took — tokens created, advanced/moved, or consumed (read straight from the model, not
// guessed). Runs each frame so delayed arrivals (a token travelling a flow) are reported as they land.
// Tokens keep their identity across a move, so we diff by object reference. The simulator reports a
// **no-op** itself (the `simulator.noop` event) — no frame-counting heuristic needed.
function poll() {
  if (animation) {
    const cur = new Map();
    for (const token of animation.getTokens()) {
      cur.set(token, where(token));
    }
    for (const [ token, desc ] of cur) {
      const before = prev.get(token);
      if (before === undefined) {
        console.log(`%c    + ${token.label}: created at ${desc}`, styleAdd);
      } else if (before !== desc) {
        console.log(`%c    → ${token.label}: ${before}  ⟶  ${desc}`, styleMove);
      }
    }
    for (const [ token, desc ] of prev) {
      if (!cur.has(token)) {
        console.log(`%c    − ${token.label}: consumed at ${desc}`, styleDrop);
      }
    }
    prev = cur;
  }
  requestAnimationFrame(poll);
}
requestAnimationFrame(poll);

// Wire the observed-event logging to a viewer's eventBus (re-done per viewer). These log only the
// **raw event** that occurred — never the intended outcome; whether anything actually happened is
// reported by the token diff (the `+/→/−` lines). A double-click that the simulator no-ops (a pool
// start it can't spawn, a process at busy, …) shows the event with no diff lines after it.
function wireEvents(eventBus) {
  // Observed events log at a **higher priority** than the simulator's own listeners (default 1000), so
  // the event line is printed before the simulator reacts — and before any `simulator.noop` it fires.
  eventBus.on('element.dblclick', 2000, e => {
    if (e.element) {
      logEvent(`double-click ${e.element.id} (${e.element.type})`);
    }
  });
  eventBus.on('token.dblclick', 2000, e => logEvent(`double-click token ${e.label} @ ${e.node}`));
  eventBus.on('token.click', 2000, e => logEvent(`click token ${e.label} @ ${e.node}`));
  eventBus.on('element.click', 2000, e => {
    const el = e.element;
    if (el && (is(el, 'bpmn:SequenceFlow') || is(el, 'bpmn:IntermediateCatchEvent'))) {
      logEvent(`click ${el.id} (${el.type})`);
    }
  });
  // the simulator tells us, from its control flow, when a double-click did nothing
  eventBus.on('simulator.noop', () => console.log('%c    · no effect', styleNoop));
}

// --- diagram loading ---------------------------------------------------------------------------

async function load(xml, name) {
  if (viewer) {
    viewer.destroy(); // tear the old run down completely before the new one
    viewer = simulation = animation = null;
  }
  prev = new Map();

  const next = new NavigatedViewer({
    container: '#canvas',
    additionalModules: [ SimulatorModule ]
  });

  try {
    await next.importXML(xml);
  } catch (err) {
    next.destroy();
    console.error(`failed to load "${name}":`, err);
    return;
  }

  viewer = next;
  simulation = next.get('simulation');
  animation = next.get('animation');
  wireEvents(next.get('eventBus'));
  next.get('canvas').zoom('fit-viewport', 'auto');

  $('#placeholder').style.display = 'none';
  console.log(`%c● loaded "${name}" — double-click the start event to spawn an instance`, 'color:#000;font-weight:bold');
}

// toolbar wiring
const examplesEl = $('#examples');
for (const ex of EXAMPLES) {
  const opt = document.createElement('option');
  opt.value = ex.id;
  opt.textContent = ex.label;
  examplesEl.appendChild(opt);
}

$('#load').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) {
    return;
  }
  examplesEl.value = '';
  await load(await file.text(), file.name);
  e.target.value = ''; // allow re-loading the same file
});
examplesEl.addEventListener('change', e => {
  const ex = EXAMPLES.find(x => x.id === e.target.value);
  if (ex) {
    load(ex.xml, ex.label);
  }
});
$('#clear').addEventListener('click', () => {
  if (simulation) {
    simulation.clear();
    prev = new Map();
    console.log('%c● cleared tokens', 'color:#000;font-weight:bold');
  }
});

// start blank — the placeholder invites loading a diagram
console.log('bpmn-js-animation simulator — load a diagram to begin. Events and actions are logged here.');
