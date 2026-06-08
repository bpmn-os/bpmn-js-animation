import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

import { is } from 'bpmn-js/lib/util/ModelUtil';

// The headline drop-in module (same shape as adding bpmn-js-token-simulation): just load it
// and the simulation is driven entirely by double-clicking — no orchestration code here.
import SimulatorModule from '../lib/index.js';
import '../assets/token-animation.css';

import linearXML from '../test/diagrams/linear.bpmn?raw';
import boundaryXML from '../test/diagrams/boundary.bpmn?raw';
import inclusiveXML from '../test/diagrams/inclusive.bpmn?raw';
import loopXML from '../test/diagrams/loop.bpmn?raw';
import miXML from '../test/diagrams/mi.bpmn?raw';
import processXML from './process.bpmn?raw';

const DIAGRAMS = {
  linear: linearXML,       // start → task → end (the full lifecycle works end-to-end)
  boundary: boundaryXML,   // task + interrupting boundary → terminate, + a non-interrupting boundary
  inclusive: inclusiveXML, // inclusive split → 3 task branches → inclusive join
  loop: loopXML,           // standard-loop task — re-enter (plain dbl-click) or depart (pick the outflow)
  mi: miXML,               // multi-instance task — dbl-click the parent to spawn subs, run + consume each
  process: processXML      // parallel split + loop + MI; event-sub — partial (upcoming)
};

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ SimulatorModule ]
});

const $ = s => document.querySelector(s);

function log(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('#log').prepend(d);
}

async function load(name) {
  if (!DIAGRAMS[name]) {
    name = 'linear';
  }
  $('#diagram').value = name; // keep the dropdown in sync with what's actually on the canvas
  await viewer.importXML(DIAGRAMS[name]);
  viewer.get('canvas').zoom('fit-viewport', 'auto');
  log(`loaded "${name}" — double-click the start event to spawn an instance`);
}

// light activity log so you can see what each double-click triggered
const bus = viewer.get('eventBus');
bus.on('element.dblclick', e => {
  if (e.element && is(e.element, 'bpmn:StartEvent')) {
    log(`spawn @ ${e.element.id}`);
  }
});
// note: fires on every double-click; the simulator may no-op it (e.g. a (sub)process at busy,
// which completes via its children, not by a click), so this is "dbl-clicked", not "advanced"
bus.on('token.dblclick', e => log(`dbl-click ${e.label} @ ${e.node}`));

$('#diagram').addEventListener('change', e => load(e.target.value));
$('#clear').addEventListener('click', () => {
  viewer.get('simulation').clear();
  log('cleared tokens');
});

// load whatever the dropdown currently shows (browsers persist <select> state across reloads),
// so the canvas and the dropdown never disagree
load($('#diagram').value);
