/**
 * Execution-log playback — collaboration.bpmn
 * ===========================================
 *
 * Replays a recorded **execution log** with the high-level `simulation` service alone (no
 * interactive `simulator`). The log is plain **data** — a flat, ordered list of token steps kept in
 * the sibling `playback.json` — and `playCollaboration` is a tiny interpreter that runs each step
 * in turn. Swap in your own engine's log and it plays that instead.
 *
 * Each step is `{ node, label, pos }` (+ optional `animate`), where `pos` says what to do:
 *   - `'entry'` | `'busy'` | `'completion'` — advance the token to that position on an activity / box
 *   - `'center'` — anchor it at an event / gateway centre
 *   - `'<Flow_id>'` — travel that sequence flow to the far node
 *   - `'create'` — place the token (its kind is inferred from the node)
 *   - `'consume'` — remove the token (and its subtree)
 *   - `'front'` — bring this instance to the front of its stacked pool / MI activity
 *   - `'throw'` | `'catch'` — fly the node's own icon out of / into the token (a message hand-off)
 *   - `'cue'` — set a motion cue (`animate`) without moving the token
 * `animate` (`'pulse'` / `'bounce'` / `'bounce-pause'`) is the cue applied at that step.
 *
 * The model (examples/collaboration.bpmn): an **Order** pool whose `JobActivity` is a sequential
 * multi-instance "Job" sub-process (send a request, await its completion), and a **Machine** pool that
 * waits at a conditional event while a non-interrupting, message-triggered event sub-process conducts
 * each request. Scenario: 2 machines, 3 orders, 2 jobs each; every order's two jobs go to different
 * machines, all orders dispatch their first request back to back, and the conditional fires once all
 * 3×2 = 6 requests have been delivered.
 */

import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

// This page drives the **API** directly — the `AnimationModule` wires the `animation` + `simulation`
// services without the interactive (double-click) `simulator`.
import { AnimationModule } from '../lib/index.js';
import '../assets/token-animation.css';

import collaborationXML from '../examples/collaboration.bpmn?raw';

// the recording — a flat list of token steps, kept as plain data in a sibling JSON file
import executionLog from './playback.json';
export { executionLog };


// --- the player: a dumb interpreter over the step list -----------------------

const SWEEP = new Set([ 'entry', 'busy', 'completion' ]);

/**
 * Replay `steps` against `viewer`'s `simulation` service, in order. Each step maps to one
 * simulation-API call; awaiting them in sequence plays the log back step by step.
 *
 * @param {import('bpmn-js/lib/NavigatedViewer').default} viewer a viewer holding collaboration.bpmn
 * @param {Array<{node:string,label:string,pos:string,animate?:string}>} [steps] defaults to {@link executionLog}
 * @param {{ gate?: () => (void | Promise<void>) }} [options] `gate` is awaited before each step —
 *   return a pending promise to pause the playback (see the Pause button below)
 * @return {Promise<void>}
 */
export async function playCollaboration(viewer, steps = executionLog, { gate = () => {} } = {}) {
  const sim = viewer.get('simulation');

  // the log drives the front instance of each pool explicitly (via `front` steps), so turn off
  // auto-focus — otherwise every touched token would also pull its own instance to the front.
  sim.autoFocus(false);

  for (const { node, label, pos, animate } of steps) {
    await gate();
    if (pos === 'create') {
      sim.createToken({ node, label, animate });
    } else if (pos === 'cue') {
      sim.setCue(node, label, animate);
    } else if (pos === 'consume') {
      await sim.consumeToken({ node, label });
    } else if (pos === 'front') {
      await sim.moveToFront(node, label);
    } else if (pos === 'throw') {
      await sim.throwIcon(node, label);
    } else if (pos === 'catch') {
      await sim.catchIcon(node, label);
    } else if (pos === 'center') {
      await sim.advanceToken({ node, label }); // anchor at an event / gateway centre
    } else if (SWEEP.has(pos)) {
      await sim.advanceToken({ node, label, position: pos, animate });
    } else {
      await sim.advanceToken({ node, label, sequenceFlow: pos }); // pos is a flow id
    }
  }
}

// --- page wiring (only runs on the playback page, not when imported by a test) ----------------

const $ = s => document.querySelector(s);

if ($('#play')) {
  let viewer = null;
  let running = false;

  // pause gate: the player awaits gate() before each step; a pending promise pauses it
  let paused = false;
  let resumers = [];
  const gate = () => (paused ? new Promise(resolve => resumers.push(resolve)) : undefined);
  const setPaused = p => {
    paused = p;
    $('#pause').textContent = p ? '▶ Resume' : '⏸ Pause';
    if (!p) {
      const rs = resumers;
      resumers = [];
      rs.forEach(r => r());
    }
  };

  // (re)build a fresh viewer with the collaboration model — a clean slate for each run
  async function build() {
    if (viewer) {
      viewer.destroy();
    }
    viewer = new NavigatedViewer({
      container: '#canvas',
      additionalModules: [ AnimationModule ],
      animation: { animationDuration: 500 } // > 0 so the motion is visible
    });
    await viewer.importXML(collaborationXML);
    viewer.get('canvas').zoom('fit-viewport', 'auto');
  }

  async function run() {
    if (running) {
      return;
    }
    running = true;
    setPaused(false);
    $('#play').disabled = true;
    $('#pause').hidden = false;
    await build(); // restart from a clean diagram each time
    console.log('%c● playing the execution log…', 'color:#06c;font-weight:bold');
    try {
      await playCollaboration(viewer, undefined, { gate });
      console.log('%c● playback finished', 'color:#06c;font-weight:bold');
    } catch (err) {
      console.error('playback failed:', err);
    } finally {
      running = false;
      $('#play').disabled = false;
      $('#pause').hidden = true;
      setPaused(false);
    }
  }

  $('#play').addEventListener('click', run);
  $('#pause').addEventListener('click', () => setPaused(!paused));

  build(); // show the model on load (idle, no tokens) so the page isn't blank
}
