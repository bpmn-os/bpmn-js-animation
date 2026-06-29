import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

// The opt-in tools — `simulator` (interactive driving, owns record) and `animator` (playback, owns
// replay) — plus `SidePanelModule` + `TokenPanelModule`: run/pause, speed, auto-focus, log
// save/load and the selected-token / tokens-at-node inspector all live in a "Simulation" tab of the
// side panel. The toolbar keeps only model loading and the Simulate/Playback mode toggle.
import { SimulatorModule, AnimatorModule, TokenPanelModule } from '../lib/index.js';
import SidePanelModule from 'bpmn-js-side-panel';
import 'bpmn-js-side-panel/assets/side-panel.css';
import '../assets/animation.css';
import '../assets/simulation-panel.css';

// bundled example models, and their recorded execution logs (loaded by basename: `<id>.bpmn` ↔ `<id>.json`)
import simpleProcessXML from '../examples/simple-process.bpmn?raw';
import gatewaysXML from '../examples/gateways.bpmn?raw';
import collapsedSubprocessXML from '../examples/collapsed-subprocess.bpmn?raw';
import linkEventsXML from '../examples/link-events.bpmn?raw';
import eventBasedXML from '../examples/event-based-gateway.bpmn?raw';
import multiInstanceXML from '../examples/multi-instance.bpmn?raw';
import collaborationXML from '../examples/collaboration.bpmn?raw';

const LOG_MODULES = import.meta.glob('../examples/*.json', { eager: true, import: 'default' });
const LOGS = {};
for (const [ path, log ] of Object.entries(LOG_MODULES)) {
  LOGS[path.slice(path.lastIndexOf('/') + 1, -'.json'.length)] = log; // basename → log
}

const EXAMPLES = [
  { id: 'simple-process', label: 'Simple process', xml: simpleProcessXML },
  { id: 'gateways', label: 'Gateways', xml: gatewaysXML },
  { id: 'event-based-gateway', label: 'Event-based gateway', xml: eventBasedXML },
  { id: 'link-events', label: 'Link events', xml: linkEventsXML },
  { id: 'collapsed-subprocess', label: 'Collapsed sub-process', xml: collapsedSubprocessXML },
  { id: 'multi-instance', label: 'Multi-instance activities', xml: multiInstanceXML },
  { id: 'collaboration', label: 'Collaboration', xml: collaborationXML }
].map(ex => ({ ...ex, log: LOGS[ex.id] || null }));

const $ = s => document.querySelector(s);

// --- state -------------------------------------------------------------------------------------

let viewer = null;
let animation = null; // the enabling vocabulary (drive tokens, lookups, clear)
let primitives = null;  // low-level (token polling for the console diff)
let simulator = null;  // interactive tool — owns record
let animator = null;   // playback tool — owns replay
let playback = null;   // run/pause controller around the animator
let tokenPanel = null; // the Simulation side-panel tab
let prev = new Map(); // token -> its `where(...)` description last frame (the diff baseline)

let mode = 'simulate';
let shippedLog = null; // the current example's shipped log (or null)

const styleEvent = 'color:#06c;font-weight:bold';
const styleAdd = 'color:#0a0';
const styleMove = 'color:#555';
const styleDrop = 'color:#c00';
const styleNoop = 'color:#999';

// --- console logging: observed events + the resulting token actions ----------------------------

function where(token) {
  if (token.state.sequenceFlow) {
    return `flow ${token.state.sequenceFlow}`;
  }
  const entry = animation.getEntry(token.node, token.label, token.state.sequenceFlow || undefined);
  const phase = entry && entry.position;
  return phase ? `${token.node} (${phase})` : token.node;
}

function logEvent(msg) {
  console.log(`%c▸ ${msg}`, styleEvent);
}

// Diff the live token set against the previous frame and log created / advanced / consumed tokens.
function poll() {
  if (primitives) {
    const cur = new Map();
    for (const token of primitives.getTokens()) {
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

function wireEvents(eventBus) {
  // higher priority than the simulator's own listeners (1000): in Playback the diagram is read-only,
  // so block double-clicks (return false stops propagation); in Simulator they drive + log.
  eventBus.on('element.dblclick', 2000, e => {
    // in Playback the diagram is read-only — block the spawn gesture (double-click a start event),
    // but let stack scrolling (double-click a stacked node / the process) through so instances can
    // still be browsed during replay
    if (mode === 'play') {
      return (e.element && is(e.element, 'bpmn:StartEvent')) ? false : undefined;
    }
    if (e.element) {
      logEvent(`double-click ${e.element.id} (${e.element.type})`);
    }
  });
  eventBus.on('token.dblclick', 2000, e => {
    if (mode === 'play') {
      return false;
    }
    logEvent(`double-click token ${e.label} @ ${e.node}`);
  });
  eventBus.on('token.click', 2000, e => logEvent(`click token ${e.label} @ ${e.node}`));
  eventBus.on('element.click', 2000, e => {
    const el = e.element;
    if (el && (is(el, 'bpmn:SequenceFlow') || is(el, 'bpmn:IntermediateCatchEvent'))) {
      logEvent(`click ${el.id} (${el.type})`);
    }
  });
  eventBus.on('simulator.noop', () => console.log('%c    · no effect', styleNoop));
}

// --- diagram loading (rebuilds the viewer; never on a mode toggle) ------------------------------

async function load(xml, name, log) {
  // stop any in-flight replay and let it unwind before tearing the old viewer down — otherwise the
  // replay keeps issuing calls against a destroyed viewer (switching examples mid-playback breaks the page).
  if (playback) {
    await playback.stop();
  }
  if (viewer) {
    viewer.destroy();
    viewer = animation = primitives = simulator = animator = playback = tokenPanel = null;
  }
  prev = new Map();

  const next = new NavigatedViewer({
    container: '#canvas',
    additionalModules: [ SimulatorModule, AnimatorModule, SidePanelModule, TokenPanelModule ],
    sidePanel: { parent: '#side-panel' }
  });

  try {
    await next.importXML(xml);
  } catch (err) {
    next.destroy();
    console.error(`failed to load "${name}":`, err);
    return;
  }

  viewer = next;
  animation = next.get('animation');
  primitives = next.get('primitives');
  simulator = next.get('simulator'); // owns record
  animator = next.get('animator');   // owns replay
  playback = next.get('playback');   // run/pause controller
  tokenPanel = next.get('tokenPanel');
  wireEvents(next.get('eventBus'));
  next.get('canvas').zoom('fit-viewport', 'auto');

  shippedLog = log || null;
  tokenPanel.setLog(shippedLog); // the panel's Run replays this when nothing is recorded/loaded
  tokenPanel.setMode(mode);      // hide the playback-only controls in Simulate mode

  // keep the current mode (loading a model in Playback stays in Playback): in Simulator we record the run
  if (mode === 'simulate') {
    simulator.startRecording();
  }
  $('#placeholder').style.display = 'none';
  console.log(`%c● loaded "${name}"`, 'color:#000;font-weight:bold');
}

// --- mode toggle — clears the diagram (the modes are separate: no take-over) --------------------

async function setMode(m) {
  if (playback) {
    await playback.stop(); // stop any in-flight replay at the next event boundary
  }
  mode = m;
  if (animation) {
    // entering Playback: keep the just-driven log as the replay source (so Playback replays what you
    // drove, and switching back doesn't wipe it), then stop recording so the replay isn't re-recorded
    if (m === 'play') {
      const recorded = simulator.getRecording();
      if (recorded.length) {
        tokenPanel.setLog(recorded);
      }
      simulator.stopRecording();
    }
    // switching clears the view consistently: tokens (and thus token selection) + node selection
    animation.clear();
    viewer.get('selection').select(null);
    prev = new Map();
    if (m === 'simulate') {
      simulator.startRecording(); // record the new interactive run
    }
  }
  if (tokenPanel) {
    tokenPanel.setMode(m); // also clears the process context + applies the per-mode controls
  }
  document.body.className = `mode-${m}`;
  $('#modeSimulate').classList.toggle('active', m === 'simulate');
  $('#modePlay').classList.toggle('active', m === 'play');
}

$('#modeSimulate').addEventListener('click', () => setMode('simulate'));
$('#modePlay').addEventListener('click', () => setMode('play'));

// --- toolbar wiring ----------------------------------------------------------------------------

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
  await load(await file.text(), file.name, null);
  e.target.value = '';
});
examplesEl.addEventListener('change', e => {
  const ex = EXAMPLES.find(x => x.id === e.target.value);
  if (ex) {
    load(ex.xml, ex.label, ex.log);
  }
});

// start blank in Simulate mode — the placeholder invites loading a diagram
setMode('simulate');
console.log('bpmn-js-animation — pick an example or load a diagram. Simulate to drive & record, Play to replay (Simulation tab).');
