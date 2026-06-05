import Animation from './Animation';

/**
 * bpmn-js additionalModule providing API-driven animation.
 *
 * One service, `animation`, owns it all — token animation (createToken /
 * sendToken / setState / removeToken / getTokens / setFilter) and node animation
 * (throwIcon / catchIcon), plus the global animation duration.
 */
export default {
  __init__: [ 'animation' ],
  animation: [ 'type', Animation ]
};

// color helpers — call to obtain a color, then pass it to createToken.
// getDistinctColor: maximally-distinct sequence; getRelatedColors: a family of shades.
export { getRandomColor, getDistinctColor, getRelatedColors } from './color';
