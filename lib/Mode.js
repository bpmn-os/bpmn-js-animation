const MODES = [ 'model', 'simulate', 'playback' ];

/**
 * Mode — the single switch between **modelling** and **simulation**. One call,
 * `mode.setMode('model' | 'simulate' | 'playback')`, does everything:
 *
 *  - turns the **modeller's editing** off outside `model` (read-only canvas) and back on in `model`,
 *  - turns the **simulator** on only in `simulate` (and starts a fresh recording),
 *  - **clears** the tokens on every switch (the modes are separate sessions),
 *  - marks the canvas `.bts-simulation` and hides the palette outside `model`,
 *  - fires `mode.changed` (`{ mode }`).
 *
 * Opt-in (`ModeModule`) and **viewer-safe**: it only touches the modeller services (directEditing,
 * dragging, modeling, editorActions, palette) when they exist, so a plain viewer gets just the
 * simulation gating. The modelling read-only behaviour is a port of bpmn-js-token-simulation's
 * `DisableModeling`, folded into the one switch. Default mode is `model`; the host sets the initial mode.
 */
export default function Mode(injector, eventBus, canvas, animation) {
  this._injector = injector;
  this._eventBus = eventBus;
  this._canvas = canvas;
  this._animation = animation;

  this._mode = 'model';
  this._modelingDisabled = false; // true outside 'model' — drives the modelling intercepts below

  this._simulator = injector.get('simulator', false);
  this._playback = injector.get('playback', false);

  this._installModelingGuards(); // no-ops when modeller services are absent (viewer)

  // establish the initial mode's effects once the diagram is up. Lower priority than the simulator's
  // own diagram.init (which marks .bts-simulation) so this wins and reflects the actual mode.
  eventBus.on('diagram.init', 500, () => this._apply());
}

Mode.$inject = [ 'injector', 'eventBus', 'canvas', 'animation' ];

/** The current mode: 'model' | 'simulate' | 'playback'. */
Mode.prototype.getMode = function() {
  return this._mode;
};

/** Switch mode — turns modelling/simulation on/off in one call (see the class doc). */
Mode.prototype.setMode = function(mode) {
  if (MODES.indexOf(mode) === -1) {
    throw new Error(`unknown mode <${mode}> (expected ${MODES.join('|')})`);
  }
  if (mode === this._mode) {
    return;
  }
  this._mode = mode;
  this._apply();
  this._eventBus.fire('mode.changed', { mode });
};

Mode.prototype._apply = function() {
  const mode = this._mode;
  const simulating = mode !== 'model';

  this._modelingDisabled = simulating;

  // every switch starts a clean session: stop any running playback + clear the tokens
  if (this._playback) {
    this._playback.stop();
  }
  this._animation.clear();

  // the simulator reacts to gestures only in 'simulate'; start a fresh recording there
  if (this._simulator) {
    this._simulator.setActive(mode === 'simulate');
    if (mode === 'simulate') {
      this._simulator.startRecording();
    }
  }

  // sync the animation panel's footer to the mode: Save log in 'simulate'; run/pause + speed + load in
  // 'playback' (its setMode takes 'simulate' | 'play')
  const panel = this._injector.get('tokenPanel', false);
  if (panel && panel.setMode) {
    panel.setMode(mode === 'playback' ? 'play' : 'simulate');
  }

  // presentation: simulation view (hide native selection frame + edit handles) + hide the palette
  const container = this._canvas.getContainer && this._canvas.getContainer();
  if (container) {
    container.classList.toggle('bts-simulation', simulating);
  }
  this._togglePalette(!simulating);

  // leaving 'model' → make sure no edit gesture is mid-flight
  if (simulating) {
    const directEditing = this._injector.get('directEditing', false);
    const dragging = this._injector.get('dragging', false);
    if (directEditing) {
      directEditing.cancel();
    }
    if (dragging) {
      dragging.cancel();
    }
  }
};

Mode.prototype._togglePalette = function(show) {
  const container = this._canvas.getContainer && this._canvas.getContainer();
  const el = container && container.querySelector('.djs-palette');
  if (el) {
    el.style.display = show ? '' : 'none';
  }
};

// Port of token-simulation's DisableModeling, folded into the mode switch: intercept the modeller
// services so the canvas is read-only whenever modelling is disabled (mode !== 'model'). All no-ops in
// a viewer (the services are absent). Wrapped once; the `_modelingDisabled` flag gates them per mode.
Mode.prototype._installModelingGuards = function() {
  const injector = this._injector;
  const self = this;

  const directEditing = injector.get('directEditing', false);
  const dragging = injector.get('dragging', false);
  const modeling = injector.get('modeling', false);
  const editorActions = injector.get('editorActions', false);

  function intercept(obj, fnName, cb) {
    if (!obj || typeof obj[fnName] !== 'function') {
      return;
    }
    const fn = obj[fnName];
    obj[fnName] = function() {
      return cb.call(this, fn, arguments);
    };
  }

  function ignoreIfDisabled(obj, fnName) {
    intercept(obj, fnName, function(fn, args) {
      if (self._modelingDisabled) {
        return;
      }
      return fn.apply(this, args);
    });
  }

  ignoreIfDisabled(directEditing, 'activate'); // no label editing outside 'model'
  ignoreIfDisabled(dragging, 'init');          // no element dragging/creation outside 'model'

  [
    'moveShape', 'moveElements', 'moveConnection', 'layoutConnection', 'createConnection',
    'createShape', 'createLabel', 'appendShape', 'removeElements', 'distributeElements',
    'removeShape', 'removeConnection', 'replaceShape', 'pasteElements', 'alignElements',
    'resizeShape', 'createSpace', 'updateWaypoints', 'reconnectStart', 'reconnectEnd',
    'updateAttachment'
  ].forEach(fn => ignoreIfDisabled(modeling, fn));

  // editor actions: while modelling is disabled, allow only a safe (view) subset
  if (editorActions) {
    const allow = [ 'stepZoom', 'zoom', 'moveCanvas', 'scrollCanvas' ];
    intercept(editorActions, 'trigger', function(fn, args) {
      if (self._modelingDisabled && allow.indexOf(args[0]) === -1) {
        return;
      }
      return fn.apply(this, args);
    });
  }
};
