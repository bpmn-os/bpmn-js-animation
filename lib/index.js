import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import Primitives from './primitives';
import Animation from './animation';
import Simulator from './Simulator';
import Animator from './Animator';
import Playback from './Playback';
import SimulationPanel from './SimulationPanel';

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
 * `assets/animation.css`). Depends on the documented diagram-js `selection` + `outline` features
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

/**
 * Opt-in **playback controller** — adds the `playback` service: a small run/pause/resume/stop state
 * machine around `animator.replay`, firing `playback.changed` so UI can stay in sync. Pulls in the
 * `animator` via `__depends__`.
 */
export const PlaybackModule = {
  __depends__: [ AnimatorModule ],
  __init__: [ 'playback' ],
  playback: [ 'type', Playback ]
};

/**
 * Opt-in **Simulation panel** — adds a "Simulation" tab to a `bpmn-js-side-panel` (if one is
 * present): selected-token / tokens-at-node inspector (click a token to bring its stack to the
 * front), plus run/pause, auto-focus, speed and execution-log save/load. No-ops without a side
 * panel, so it stays optional for the host. Pulls in the `playback` controller via `__depends__`.
 */
export const SimulationPanelModule = {
  __depends__: [ PlaybackModule ],
  __init__: [ 'simulationPanel' ],
  simulationPanel: [ 'type', SimulationPanel ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
