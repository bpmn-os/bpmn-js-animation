import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import AnimationAPI from './AnimationAPI';
import SimulationAPI from './SimulationAPI';
import Simulator from './Simulator';

/**
 * bpmn-js additionalModule — the **headline interactive simulator**, integrated like
 * `bpmn-js-token-simulation` (add to `additionalModules`, import `assets/token-animation.css`)
 * so the two are swappable. Three layered services:
 *  - `animation` — the low-level visual primitive (createToken / sendToken / setState /
 *    removeToken / setStackSize / throwIcon / playTokenEffect / …).
 *  - `simulation` — the high-level, BPMN-shaped vocabulary composed over it (the supported
 *    surface for hosts driving tokens programmatically).
 *  - `simulator` — the opinionated, double-click-driven simulator over `simulation`; needs no
 *    host code. This is what makes the package a drop-in for `bpmn-js-token-simulation`.
 *
 * Depends on the documented diagram-js `selection` + `outline` features so the native
 * selection (and our stack-aware OutlineProvider) work even in a bare viewer — keeping
 * the bpmn-js ecosystem (property panel, …) compatible.
 */
export default {
  __depends__: [ SelectionModule, OutlineModule ],
  __init__: [ 'animation', 'simulation', 'simulator' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ],
  simulator: [ 'type', Simulator ]
};

/**
 * The **API-only** module — `animation` + `simulation`, *without* the interactive `simulator`. Add
 * this instead of the default export when you drive tokens programmatically (e.g. replaying an
 * execution log via `viewer.get('simulation')`) and don't want the double-click simulator wired in.
 */
export const AnimationModule = {
  __depends__: [ SelectionModule, OutlineModule ],
  __init__: [ 'animation', 'simulation' ],
  animation: [ 'type', AnimationAPI ],
  simulation: [ 'type', SimulationAPI ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
