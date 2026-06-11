import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

// Both opt-in tools — the `simulator` (interactive driving, owns record) and the `animator` (playback,
// owns replay); each pulls in the enabling API (primitives + animation) via `__depends__`. One viewer
// serves both modes: in **Simulate** the simulator drives + records every BPMN event; in **Play** the
// animator replays a log. The two modes are separate — toggling clears the diagram (no take-over).
import { SimulatorModule, AnimatorModule } from '../lib/index.js';
import '../assets/token-animation.css';

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
let prev = new Map(); // token -> its `where(...)` description last frame (the diff baseline)

let mode = 'simulate';
let shippedLog = null; // the current example's shipped log (or null)
let loadedLog = null;  // a log loaded via "Load log…" (or null) — takes precedence on Play
let playSource = [];   // the log the current Play will replay (resolved when entering Playback)

let playing = false;   // a replay is actively running (double-clicks are blocked)
let paused = false;
let resumers = [];     // pause-gate resolvers
let aborted = false;   // set when toggling to Simulate mid-replay → stop at the next event

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
    if (mode === 'play') {
      return false;
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
  // stop any in-flight replay and tear the old viewer down for a clean slate
  aborted = true;     // stop any in-flight replay before tearing the viewer down
  setPaused(false);   // resolve a pending pause so the replay reaches the gate and aborts
  playing = false;
  if (viewer) {
    viewer.destroy();
    viewer = animation = primitives = simulator = animator = null;
  }
  prev = new Map();

  const next = new NavigatedViewer({
    container: '#canvas',
    additionalModules: [ SimulatorModule, AnimatorModule ]
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
  wireEvents(next.get('eventBus'));
  next.get('canvas').zoom('fit-viewport', 'auto');

  shippedLog = log || null;
  loadedLog = null;
  animator.autoFocus($('#autofocus').checked);

  // keep the current mode (loading a model in Playback stays in Playback): in Simulator we record the
  // run; in Playback we replay — the source defaults to the (new) example's shipped log
  if (mode === 'simulate') {
    simulator.startRecording();
  } else {
    playSource = resolvePlaySource();
  }
  $('#placeholder').style.display = 'none';
  console.log(`%c● loaded "${name}"`, 'color:#000;font-weight:bold');
}

// --- mode toggle — clears the diagram (the modes are separate: no take-over) --------------------

function setMode(m) {
  if (playing) {
    aborted = true;     // stop any in-flight replay at the next event boundary
    setPaused(false);   // resolve a pending pause so the gate runs and aborts
  }
  // entering Playback, capture the source to replay *before* clearing (the just-driven recording, a
  // loaded file, or the example's shipped log)
  if (m === 'play') {
    playSource = resolvePlaySource();
  }
  mode = m;
  if (animation) {
    animation.clear(); // toggling clears the diagram — each mode starts from a clean slate
    prev = new Map();
    if (m === 'simulate') {
      simulator.startRecording(); // record the interactive run
    } else {
      simulator.stopRecording();  // Playback is read-only — don't record the replay
    }
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

// Refresh — one button shared by both modes (same label + position): reset to an empty diagram.
//   Simulator → clear tokens + reset the recording;
//   Playback  → stop the replay (abort if running) + clear, leaving it idle (▶ Start replays anew).
$('#refresh').addEventListener('click', async () => {
  if (!animation) {
    return;
  }
  if (mode === 'play') {
    if (playing) {
      aborted = true;   // stop the in-flight replay…
      setPaused(false); // …resolve a pending pause so the gate runs and aborts
      await playRun;
    }
    animation.clear();
    prev = new Map();
    console.log('%c● playback stopped', 'color:#000;font-weight:bold');
    return;
  }
  animation.clear();
  simulator.startRecording();
  prev = new Map();
  console.log('%c● cleared tokens — recording reset', 'color:#000;font-weight:bold');
});

// Simulate: download the current recording (the events that produced the on-screen state)
$('#download').addEventListener('click', () => {
  if (!animation) {
    return;
  }
  const log = simulator.getRecording();
  if (!log.length) {
    console.warn('nothing recorded yet — drive the simulation first');
    return;
  }
  const blob = new Blob([ JSON.stringify(log, null, 2) ], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'execution-log.json';
  a.click();
  URL.revokeObjectURL(url);
});

// --- play (replay an execution log) ----------------------------------------------------------------

// the source log to replay: a loaded file ▸ the just-driven recording ▸ the example's shipped log.
// Resolved when entering Playback (before the recording is cleared) and stored in `playSource`.
function resolvePlaySource() {
  if (loadedLog) {
    return loadedLog;
  }
  const recorded = simulator ? simulator.getRecording() : [];
  return recorded.length ? recorded : (shippedLog || []);
}

// the pause/abort gate the replay awaits before each event
function gate() {
  if (aborted) {
    const err = new Error('playback aborted');
    err.aborted = true;
    throw err;
  }
  return paused ? new Promise(resolve => resumers.push(resolve)) : undefined;
}

function setPaused(p) {
  paused = p;
  $('#pause').textContent = p ? '▶ Resume' : '⏸ Pause';
  if (!p) {
    const rs = resumers;
    resumers = [];
    rs.forEach(r => r());
  }
}

$('#pause').addEventListener('click', () => setPaused(!paused));

let playRun = Promise.resolve(); // resolves when the current replay has fully unwound

// (Re)start the replay from the top — shared by ▶ Start and ↻ Restart. Restart works mid-replay
// (the button stays enabled): it aborts the in-flight run, waits for it to unwind, then replays anew.
async function startPlayback() {
  if (!animation) {
    return;
  }
  if (!playSource.length) {
    console.warn('no execution log to play — record a run in Simulator, pick an example, or Load log…');
    return;
  }
  if (playing) {            // restart: stop the in-flight replay and wait for it to settle first
    aborted = true;
    setPaused(false);       // resolve a pending pause so the gate runs and aborts
    await playRun;
  }
  playing = true;
  aborted = false;
  setPaused(false);
  $('#play').disabled = true;
  $('#pause').hidden = false;
  animator.autoFocus($('#autofocus').checked);
  animation.clear(); // replay from a clean diagram
  prev = new Map();
  console.log(`%c● replaying ${playSource.length} events…`, styleEvent);
  playRun = (async () => {
    try {
      await animator.replay(playSource, { gate });
      console.log('%c● playback finished', styleEvent);
    } catch (err) {
      if (err && err.aborted) {
        console.log('%c● playback stopped', 'color:#000;font-weight:bold');
      } else {
        console.error('playback failed:', err);
      }
    } finally {
      playing = false;
      setPaused(false);
      $('#play').disabled = false;
      $('#pause').hidden = true;
    }
  })();
}

$('#play').addEventListener('click', startPlayback);

// toggling auto-focus applies immediately (and to the next run)
$('#autofocus').addEventListener('change', e => {
  if (animator) {
    animator.autoFocus(e.target.checked);
  }
});

// Play: load an execution-log file → use it on the next Play
$('#loadLog').addEventListener('click', () => $('#logFile').click());
$('#logFile').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) {
    return;
  }
  e.target.value = '';
  try {
    loadedLog = JSON.parse(await file.text());
    playSource = loadedLog; // replay this on the next Play
    console.log(`%c● loaded log "${file.name}" (${loadedLog.length} events) — press Play`, 'color:#000;font-weight:bold');
  } catch (err) {
    console.error(`invalid log JSON in "${file.name}":`, err);
  }
});

// start blank in Simulate mode — the placeholder invites loading a diagram
setMode('simulate');
console.log('bpmn-js-animation — pick an example or load a diagram. Simulate to drive & record, Play to replay.');
