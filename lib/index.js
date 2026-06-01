import Animation from './Animation';
import Tokens from './Tokens';

/**
 * bpmn-js additionalModule providing API-driven token animation.
 *
 * Services:
 *  - `tokens`    — public API (createToken / sendToken / removeToken / …)
 *  - `animation` — low-level token-along-connection animator
 */
export default {
  __init__: [ 'tokens' ],
  animation: [ 'type', Animation ],
  tokens: [ 'type', Tokens ]
};

// color helper — call to obtain a color, then pass it to createToken
export { getRandomColor } from './color';
