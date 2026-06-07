import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';

import Animation from './Animation';
import SimulationAPI from './SimulationAPI';

/**
 * bpmn-js additionalModule providing API-driven animation.
 *
 * Two services:
 *  - `animation` — the low-level visual primitive (createToken / sendToken / setState /
 *    removeToken / setStackSize / throwIcon / …).
 *  - `simulation` — the high-level, engine-log-driven BPMN surface composed over it.
 *
 * Depends on the documented diagram-js `selection` + `outline` features so the native
 * selection (and our stack-aware OutlineProvider) work even in a bare viewer — keeping
 * the bpmn-js ecosystem (property panel, …) compatible.
 */
export default {
  __depends__: [ SelectionModule, OutlineModule ],
  __init__: [ 'animation', 'simulation' ],
  animation: [ 'type', Animation ],
  simulation: [ 'type', SimulationAPI ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';
