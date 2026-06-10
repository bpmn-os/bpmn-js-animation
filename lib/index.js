import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import AnimationAPI from './AnimationAPI';
import SimulationAPI from './SimulationAPI';
import Simulator from './Simulator';
import Animator from './Animator';

const deps = [ SelectionModule, OutlineModule ];

/**
 * The **API-only** module — `animation` + `simulation`, the bare enabling API without either tool. Add
 * this when you drive tokens programmatically (e.g. from your own engine) and want neither the
 * interactive simulator nor the log player.
 *
 *  - `animation`  — the low-level visual primitive (createToken / sendToken / setState / removeToken /
 *    setStacks / moveToFront / scrollStack / throwIcon / playTokenEffect / drillTo / …).
 *  - `simulation` — the high-level, BPMN-shaped **enabling API** composed over it (the supported
 *    surface for hosts driving tokens programmatically). Pure vocabulary — record/replay live in the
 *    tools below, not here.
 */
export const AnimationModule = {
  __depends__: deps,
  __init__: [ 'animation', 'simulation' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ]
};

/**
 * The **interactive simulator** module — the enabling API plus the `simulator` tool: an opinionated,
 * double-click-driven BPMN token simulator that needs no host code, and **owns recording**
 * (`startRecording` / `getRecording` — the log it produces replays through the `animator`). No player.
 */
export const SimulatorModule = {
  __depends__: deps,
  __init__: [ 'animation', 'simulation', 'simulator' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ],
  simulator: [ 'type', Simulator ]
};

/**
 * The **playback** module — the enabling API plus the `animator` tool: the mirror of the simulator,
 * it **owns replay** (`animator.replay(log)`), turning a recorded event log back into animated token
 * flow. No interactive simulator. This is the package's headline use case — animating an execution log.
 */
export const AnimatorModule = {
  __depends__: deps,
  __init__: [ 'animation', 'simulation', 'animator' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ],
  animator: [ 'type', Animator ]
};

/**
 * bpmn-js additionalModule — the **full drop-in**: the enabling API plus **both** tools (`simulator`
 * for interactive driving + record, `animator` for playback). Integrated like
 * `bpmn-js-token-simulation` (add to `additionalModules`, import `assets/token-animation.css`). This is
 * the default export; the named modules above let you take just the API, just the simulator, or just
 * the animator.
 *
 * Depends on the documented diagram-js `selection` + `outline` features so native selection (and our
 * stack-aware OutlineProvider) work even in a bare viewer — keeping the bpmn-js ecosystem compatible.
 */
export default {
  __depends__: deps,
  __init__: [ 'animation', 'simulation', 'simulator', 'animator' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ],
  simulator: [ 'type', Simulator ],
  animator: [ 'type', Animator ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
