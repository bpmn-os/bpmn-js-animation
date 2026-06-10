import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import Primitives from './primitives';
import Animation from './animation';
import Simulator from './Simulator';
import Animator from './Animator';

const deps = [ SelectionModule, OutlineModule ];

/**
 * The **API-only** module — `primitives` + `animation`, the bare enabling API without either tool. Add
 * this when you drive tokens programmatically (e.g. from your own engine) and want neither the
 * interactive simulator nor the log player.
 *
 *  - `primitives` — the low-level visual layer (createToken / sendToken / setState / removeToken /
 *    setStacks / moveToFront / scrollStack / throwIcon / playTokenEffect / drillTo / …).
 *  - `animation`  — the high-level, BPMN-shaped **enabling API** composed over it (the supported
 *    surface for hosts driving tokens programmatically). Pure vocabulary — record/replay live in the
 *    tools below, not here.
 */
export const AnimationModule = {
  __depends__: deps,
  __init__: [ 'primitives', 'animation' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ]
};

/**
 * The **interactive simulator** module — the enabling API plus the `simulator` tool: an opinionated,
 * double-click-driven BPMN token simulator that needs no host code, and **owns recording**
 * (`startRecording` / `getRecording` — the log it produces replays through the `animator`). No player.
 */
export const SimulatorModule = {
  __depends__: deps,
  __init__: [ 'primitives', 'animation', 'simulator' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ],
  simulator: [ 'type', Simulator ]
};

/**
 * The **playback** module — the enabling API plus the `animator` tool: the mirror of the simulator,
 * it **owns replay** (`animator.replay(log)`), turning a recorded event log back into animated token
 * flow. No interactive simulator. This is the package's headline use case — animating an execution log.
 */
export const AnimatorModule = {
  __depends__: deps,
  __init__: [ 'primitives', 'animation', 'animator' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ],
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
  __init__: [ 'primitives', 'animation', 'simulator', 'animator' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ],
  simulator: [ 'type', Simulator ],
  animator: [ 'type', Animator ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
