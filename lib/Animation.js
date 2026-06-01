/**
 * Token animation renderer.
 *
 * Vendored and adapted from bpmn-js-token-simulation (MIT, Camunda Services GmbH):
 * https://github.com/bpmn-io/bpmn-js-token-simulation/blob/main/lib/animation/Animation.js
 *
 * The simulation-engine coupling has been removed: there is no `scopeFilter`
 * dependency and no simulator/scope lifecycle event handling. This is a plain
 * animator that moves a token graphic along a connection's waypoints. Movement
 * is driven by the `tokens` service, not by a BPMN execution engine.
 */
import {
  query as domQuery
} from 'min-dom';

import {
  appendTo as svgAppendTo,
  create as svgCreate,
  attr as svgAttr,
  remove as svgRemove
} from 'tiny-svg';

const STYLE = typeof getComputedStyle !== 'undefined'
  ? getComputedStyle(document.documentElement)
  : null;

const DEFAULT_COLOR =
  (STYLE && STYLE.getPropertyValue('--token-simulation-green-base-44')) || '#10D070';

function noop() {}

function getSegmentEasing(index, waypoints) {

  // only a single segment
  if (waypoints.length === 2) {
    return EASE_IN_OUT;
  }

  // first segment
  if (index === 1) {
    return EASE_IN;
  }

  // last segment
  if (index === waypoints.length - 1) {
    return EASE_OUT;
  }

  return EASE_LINEAR;
}

const EASE_LINEAR = function(pos) {
  return pos;
};
const EASE_IN = function(pos) {
  return -Math.cos(pos * Math.PI / 2) + 1;
};
const EASE_OUT = function(pos) {
  return Math.sin(pos * Math.PI / 2);
};
const EASE_IN_OUT = function(pos) {
  return -Math.cos(pos * Math.PI) / 2 + 0.5;
};

const TOKEN_SIZE = 20;

// fixed transition time (ms), independent of flow length; overridable via
// `config.tokenAnimation.animationDuration` or `tokens.setAnimationDuration()`. A
// long flow and a short flow take the same time.
const DEFAULT_DURATION = 1000;


/**
 * @param { { animationDuration?: number } | null } [config]
 * @param { import('diagram-js/lib/core/Canvas').default } canvas
 * @param { import('diagram-js/lib/core/EventBus').default } eventBus
 */
export default function Animation(config, canvas, eventBus) {
  this._canvas = canvas;
  this._eventBus = eventBus;

  this._duration = config && config.animationDuration != null ? config.animationDuration : DEFAULT_DURATION;

  this._animations = new Set();

  eventBus.on('diagram.destroy', () => {
    this.clearAnimations();
  });
}

/**
 * Animate a token along a connection.
 *
 * @param {Object} connection diagram-js connection (must have `waypoints`)
 * @param {Object} token token-like object with `color` and `element`
 * @param {Function} [done] called when the animation finishes
 * @return {TokenAnimation}
 */
Animation.prototype.animate = function(connection, token, done) {
  return this.createAnimation(connection, token, done);
};

Animation.prototype.pause = function() {
  this.each(animation => animation.pause());
};

Animation.prototype.play = function() {
  this.each(animation => animation.play());
};

Animation.prototype.each = function(fn) {
  this._animations.forEach(fn);
};

Animation.prototype.createAnimation = function(connection, token, done = noop) {
  const group = this._getGroup(token);

  if (!group) {
    return;
  }

  const tokenGfx = this._createTokenGfx(group, token);

  const animation = new TokenAnimation(tokenGfx, connection.waypoints, this._duration, () => {
    this._clearAnimation(animation);

    done();
  });

  animation.token = token;
  animation.element = connection;

  this._animations.add(animation);

  animation.play();

  return animation;
};

/**
 * Set the fixed animation duration (ms) for subsequent animations.
 *
 * @param {number} duration
 */
Animation.prototype.setAnimationDuration = function(duration) {
  this._duration = duration;
};

Animation.prototype.getAnimationDuration = function() {
  return this._duration;
};

/**
 * Remove animations. Pass a token to only remove that token's animation(s).
 *
 * @param {Object} [token]
 */
Animation.prototype.clearAnimations = function(token) {
  this.each(animation => {
    if (!token || animation.token === token) {
      this._clearAnimation(animation);
    }
  });
};

/**
 * Stop and remove a single animation instance.
 *
 * @param {TokenAnimation} animation
 */
Animation.prototype.stop = function(animation) {
  this._clearAnimation(animation);
};

Animation.prototype._clearAnimation = function(animation) {
  animation.remove();

  this._animations.delete(animation);
};

Animation.prototype._createTokenGfx = function(group, token) {
  const parent = svgCreate(this._getTokenSVG(token).trim());

  return svgAppendTo(parent, group);
};

Animation.prototype._getTokenSVG = function(token) {

  const color = token.color || DEFAULT_COLOR;

  return `
    <g class="bts-token">
      <circle
        class="bts-circle"
        r="${TOKEN_SIZE / 2}"
        cx="${TOKEN_SIZE / 2}"
        cy="${TOKEN_SIZE / 2}"
        fill="${ color }"
      />
    </g>
  `;
};

Animation.prototype._getGroup = function(token) {

  var canvas = this._canvas;

  var layer, root;

  // bpmn-js@9+ compatibility: show animation tokens on plane layers
  if ('findRoot' in canvas) {
    root = canvas.findRoot(token.element);
    layer = canvas._findPlaneForRoot(root).layer;
  } else {
    layer = domQuery('.viewport', canvas._svg);
  }

  var group = domQuery('.bts-animation-tokens', layer);

  if (!group) {
    group = svgCreate('<g class="bts-animation-tokens" />');

    svgAppendTo(
      group,
      layer
    );
  }

  return group;
};

Animation.$inject = [
  'config.tokenAnimation',
  'canvas',
  'eventBus'
];


/**
 * @param {SVGElement} gfx
 * @param {Array<{x:number,y:number}>} waypoints
 * @param {number} duration fixed total duration (ms); use 0 for an instant jump
 * @param {Function} done
 */
function TokenAnimation(gfx, waypoints, duration, done) {
  this.gfx = gfx;
  this.waypoints = waypoints;
  this.done = done;
  this._duration = duration;

  this._paused = true;
  this._t = 0;
  this._parts = [];

  this.create();
}

TokenAnimation.prototype.pause = function() {
  this._paused = true;
};

TokenAnimation.prototype.play = function() {

  if (this._paused) {
    this._paused = false;

    this.tick(0);
  }

  this.schedule();
};

TokenAnimation.prototype.schedule = function() {

  if (this._paused) {
    return;
  }

  if (this._scheduled) {
    return;
  }

  const last = Date.now();

  this._scheduled = true;

  requestAnimationFrame(() => {
    this._scheduled = false;

    if (this._paused) {
      return;
    }

    this.tick(Date.now() - last);
    this.schedule();
  });
};


TokenAnimation.prototype.tick = function(tElapsed) {

  const t = this._t = this._t + tElapsed;

  const part = this._parts.find(
    p => p.startTime <= t && p.endTime > t
  );

  // completed
  if (!part) {
    return this.completed();
  }

  const segmentTime = t - part.startTime;
  const segmentLength = part.length * part.easing(segmentTime / part.duration);

  const currentLength = part.startLength + segmentLength;

  const point = this._path.getPointAtLength(currentLength);

  this.move(point.x, point.y);
};

TokenAnimation.prototype.move = function(x, y) {
  svgAttr(this.gfx, 'transform', `translate(${x}, ${y})`);
};

TokenAnimation.prototype.create = function() {
  const waypoints = this.waypoints;

  const parts = waypoints.reduce((parts, point, index) => {

    const lastPoint = waypoints[index - 1];

    if (lastPoint) {
      const lastPart = parts[parts.length - 1];

      const startLength = lastPart && lastPart.endLength || 0;
      const length = distance(lastPoint, point);

      parts.push({
        startLength,
        endLength: startLength + length,
        length,
        easing: getSegmentEasing(index, waypoints)
      });
    }

    return parts;
  }, []);

  const totalLength = parts.reduce(function(length, part) {
    return length + part.length;
  }, 0);

  const d = waypoints.reduce((d, waypoint, index) => {

    const x = waypoint.x - TOKEN_SIZE / 2,
          y = waypoint.y - TOKEN_SIZE / 2;

    d.push([ index > 0 ? 'L' : 'M', x, y ]);

    return d;
  }, []).flat().join(' ');

  // fixed total time, independent of length; distributed across segments by
  // length so the token still moves at a steady speed along the path
  const totalDuration = this._duration;

  this._parts = parts.reduce((parts, part, index) => {
    const duration = totalDuration / totalLength * part.length;
    const startTime = index > 0 ? parts[index - 1].endTime : 0;
    const endTime = startTime + duration;

    return [
      ...parts,
      {
        ...part,
        startTime,
        endTime,
        duration
      }
    ];
  }, []);

  this._path = svgCreate(`<path d="${d}" />`);
  this._t = 0;
};

TokenAnimation.prototype.show = function() {
  svgAttr(this.gfx, 'display', '');
};

TokenAnimation.prototype.hide = function() {
  svgAttr(this.gfx, 'display', 'none');
};

TokenAnimation.prototype.completed = function() {
  if (this._done) {
    return;
  }

  this._done = true;

  this.done();
};

/**
 * Fast-forward to the end immediately, firing completion exactly once.
 */
TokenAnimation.prototype.finish = function() {
  this.pause();

  this.completed();
};

TokenAnimation.prototype.remove = function() {
  this.pause();

  svgRemove(this.gfx);
};

function distance(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}
