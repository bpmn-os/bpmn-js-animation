import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import Primitives from './primitives';
import Animation from './animation';
import Simulator from './Simulator';
import Animator from './Animator';

/**
 * bpmn-js additionalModule — the **enabling API** and the **default export**: `primitives` +
 * `animation`, the bare vocabulary a host drives tokens with, **without either tool**. Add this when
 * you animate process execution programmatically (e.g. from your own engine); the two tools below are
 * **opt-in** (each pulls this module in via `__depends__`).
 *
 *  - `primitives` — the low-level visual layer (createToken / sendToken / setState / removeToken /
 *    setStacks / moveToFront / scrollStack / throwIcon / playTokenEffect / drillTo / …).
 *  - `animation`  — the high-level, BPMN-shaped **enabling API** composed over it (the supported
 *    surface for hosts driving tokens programmatically: createToken / advanceToken / forkToken /
 *    joinTokens / consumeToken / …). Pure vocabulary — record/replay live in the tools below.
 *
 * Integrated like `bpmn-js-token-simulation` (add to `additionalModules`, import
 * `assets/token-animation.css`). Depends on the documented diagram-js `selection` + `outline` features
 * so native selection (and our stack-aware OutlineProvider) work even in a bare viewer — keeping the
 * bpmn-js ecosystem compatible.
 */
export const AnimationModule = {
  __depends__: [ SelectionModule, OutlineModule ],
  __init__: [ 'primitives', 'animation' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ]
};

export default AnimationModule;

/**
 * Opt-in **interactive simulator** tool — adds the `simulator` service to the enabling API (pulled in
 * via `__depends__`): an opinionated, double-click-driven BPMN token simulator that needs no host code,
 * and **owns recording** (`startRecording` / `getRecording` — the log it produces replays through the
 * `animator`). Add alongside `AnimatorModule` for both tools.
 */
export const SimulatorModule = {
  __depends__: [ AnimationModule ],
  __init__: [ 'simulator' ],
  simulator: [ 'type', Simulator ]
};

/**
 * Opt-in **playback** tool — adds the `animator` service to the enabling API (pulled in via
 * `__depends__`): the mirror of the simulator, it **owns replay** (`animator.replay(log)`), turning a
 * recorded execution log back into animated token flow. This is the package's headline use case — animating
 * an execution log.
 */
export const AnimatorModule = {
  __depends__: [ AnimationModule ],
  __init__: [ 'animator' ],
  animator: [ 'type', Animator ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
