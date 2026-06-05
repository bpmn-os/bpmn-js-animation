import Animation from './Animation';
import SimulationAPI from './SimulationAPI';

/**
 * bpmn-js additionalModule providing API-driven animation.
 *
 * Two services:
 *  - `animation` — the low-level visual primitive (createToken / sendToken / setState /
 *    removeToken / setStackSize / throwIcon / …).
 *  - `simulation` — the high-level, engine-log-driven BPMN surface composed over it.
 */
export default {
  __init__: [ 'animation', 'simulation' ],
  animation: [ 'type', Animation ],
  simulation: [ 'type', SimulationAPI ]
};

// color helpers — call to obtain a color, then pass it to createToken.
// getDistinctColor: maximally-distinct sequence; getRelatedColors: a family of shades.
export { getRandomColor, getDistinctColor, getRelatedColors } from './color';
