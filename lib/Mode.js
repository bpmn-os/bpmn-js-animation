const MODES = [ 'model', 'simulate', 'playback' ];

// the gestures a permitted element keeps: its resize handles and its selection outline are hidden by the
// simulation styling, which this marker takes back for the elements an exception covers
const EDITABLE = 'bts-editable';

// the modelling operations a gesture on a permitted element ends in, used to decide whether that element
// should keep the handles the gesture is started from
const GESTURES = [ 'moveShape', 'moveElements', 'resizeShape' ];

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
 *
 * **Exceptions.** Read-only is the default rather than the whole story: a host may keep a part of the
 * modeller alive while a run is on, because some elements are about the run rather than about the process —
 * a note a reader opens to see what a node holds, say. Such a host declares what stays permitted, as
 * `config.mode.exceptions` or through {@link Mode#setExceptions}, and each exception is an object of three
 * parts:
 *
 *   operations  the `modeling` methods it permits, by name, e.g. `[ 'appendShape', 'moveShape' ]`
 *   entries     the context pad entries it keeps, by id — every other entry is stripped
 *   applies     `(operation, element) => boolean`, deciding which elements it is about
 *
 * An operation runs while a run is on when some exception names it and applies to every element the call
 * names. A drag starts when some exception is about the element the gesture concerns, which is `applies`
 * answering to the operation `dragging`, and the operation the gesture ends in is judged on its own when it
 * is issued. The context pad opens only where an exception
 * keeps at least one entry, and shows those entries alone. An element some exception permits a move or a
 * resize on keeps its handles and its selection outline, which the simulation styling otherwise hides.
 *
 * The mode knows nothing of what an exception is for: it takes a predicate and a list of names, so what may
 * be edited during a run is entirely the host's to say.
 */
export default function Mode(config, injector, eventBus, canvas, animation) {
  this._injector = injector;
  this._eventBus = eventBus;
  this._canvas = canvas;
  this._animation = animation;

  this._mode = 'model';
  this._modelingDisabled = false; // true outside 'model' — drives the modelling intercepts below
  this._exceptions = (config && config.exceptions) || [];
  this._running = 0; // depth of the permitted operation being carried out, if any

  this._simulator = injector.get('simulator', false);
  this._playback = injector.get('playback', false);

  this._installModelingGuards(); // no-ops when modeller services are absent (viewer)
  this._installContextPadFilter(); // strips the entries no exception keeps

  // the elements an exception covers keep their handles, which follows the model and the exceptions alike
  eventBus.on([ 'elements.changed', 'canvas.resized', 'import.done' ], () => this._markEditable());

  // establish the initial mode's effects once the diagram is up. Lower priority than the simulator's
  // own diagram.init (which marks .bts-simulation) so this wins and reflects the actual mode.
  eventBus.on('diagram.init', 500, () => this._apply());
}

Mode.$inject = [ 'config.mode', 'injector', 'eventBus', 'canvas', 'animation' ];

/** The current mode: 'model' | 'simulate' | 'playback'. */
Mode.prototype.getMode = function() {
  return this._mode;
};

/** What stays permitted while a run is on (see the class doc). Replaces whatever was configured. */
Mode.prototype.setExceptions = function(exceptions) {
  this._exceptions = exceptions || [];
  this._markEditable();
};

Mode.prototype.getExceptions = function() {
  return this._exceptions;
};

/**
 * Whether an operation may run on an element while modelling is disabled. Public because a host that drives
 * the modeller itself needs the same answer the guards use.
 */
Mode.prototype.allows = function(operation, element) {
  return this._exceptions.some(exception =>
    (exception.operations || []).indexOf(operation) !== -1 && applies(exception, operation, element));
};

/**
 * Whether some exception is about an element at all, which is what a gesture on it needs: a drag is not an
 * operation, and what it issues is judged when it is issued.
 */
Mode.prototype.concerns = function(element) {
  return this._exceptions.some(exception => applies(exception, 'dragging', element));
};

/** The context pad entries kept for an element while modelling is disabled. */
Mode.prototype.entriesFor = function(element) {
  return this._exceptions.reduce((kept, exception) =>
    applies(exception, 'contextPad', element) ? kept.concat(exception.entries || []) : kept, []);
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

  // NOTE: the token panel is intentionally NOT touched here. Mode is a lifecycle controller and knows
  // nothing about any UI; a panel that wants to follow the mode subscribes to `mode.changed` and adapts
  // itself (so each consumer's panel owns its own controls, e.g. which log button it shows).

  // presentation: simulation view (hide native selection frame + edit handles) + hide the palette
  const container = this._canvas.getContainer && this._canvas.getContainer();
  if (container) {
    container.classList.toggle('bts-simulation', simulating);
  }
  this._togglePalette(!simulating);
  this._markEditable();

  // leaving 'model' → make sure no edit gesture / context pad is mid-flight
  if (simulating) {
    const directEditing = this._injector.get('directEditing', false);
    const dragging = this._injector.get('dragging', false);
    const contextPad = this._injector.get('contextPad', false);
    if (directEditing) {
      directEditing.cancel();
    }
    if (dragging) {
      dragging.cancel();
    }
    if (contextPad && contextPad.close) {
      contextPad.close(); // hide any open editing context pad
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

// Whether some exception is about every element a gesture names.
Mode.prototype._concerns = function(elements) {
  const named = [].concat(elements || []).filter(element => element && typeof element === 'object');

  return named.length > 0 && named.every(element => this.concerns(element));
};

// Whether every element a call names is permitted for that operation. A call naming none is refused: an
// exception is about elements, so an operation reaching none of them is not one it can speak for.
Mode.prototype._permits = function(operation, elements) {
  const named = [].concat(elements || []).filter(element => element && typeof element === 'object');

  return named.length > 0 && named.every(element => this.allows(operation, element));
};

/**
 * Keep only the entries an exception names, while modelling is disabled. Registered last, so it sees every
 * entry every other provider has contributed, its own included.
 */
Mode.prototype._installContextPadFilter = function() {
  const contextPad = this._injector.get('contextPad', false),
        self = this;

  if (!contextPad || !contextPad.registerProvider) {
    return;
  }

  contextPad.registerProvider(-10000, {
    getContextPadEntries(element) {
      return function(entries) {
        if (!self._modelingDisabled) {
          return entries;
        }

        const kept = self.entriesFor(element);

        return Object.keys(entries).reduce((filtered, id) => {
          if (kept.indexOf(id) !== -1) {
            filtered[id] = entries[id];
          }
          return filtered;
        }, {});
      };
    }
  });
};

/**
 * Mark the elements a gesture is permitted on, so that the simulation styling gives them their handles and
 * their outline back. Everything else keeps the read-only look.
 */
Mode.prototype._markEditable = function() {
  const elementRegistry = this._injector.get('elementRegistry', false),
        canvas = this._canvas;

  if (!elementRegistry || !canvas.addMarker) {
    return;
  }

  elementRegistry.forEach(element => {
    const editable = this._modelingDisabled &&
      GESTURES.some(operation => this.allows(operation, element));

    if (editable) {
      canvas.addMarker(element, EDITABLE);
    } else {
      canvas.removeMarker(element, EDITABLE);
    }
  });
};

// the element a drag gesture is about, as diagram-js's move and resize hand it over
function dragged(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const data = args[i] && args[i].data;

    if (data) {
      return data.shape || data.element || data.elements || (data.context && data.context.shape);
    }
  }

  return null;
}

// an exception's own test, an exception without one being about every element
function applies(exception, operation, element) {
  return typeof exception.applies === 'function' ? !!exception.applies(operation, element) : true;
}

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
  const contextPad = injector.get('contextPad', false);

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

  // Ignored while modelling is disabled, unless an exception permits it for every element the call names.
  //
  // Only the outermost call is judged. A modelling operation is implemented in terms of others — appending
  // a shape creates one and connects it — and how diagram-js decomposes an operation is no business of the
  // host permitting it, so a call made while a permitted one is running passes through.
  function ignoreUnlessPermitted(obj, fnName, elementsOf) {
    intercept(obj, fnName, function(fn, args) {
      if (self._modelingDisabled && !self._running && !self._permits(fnName, elementsOf(args))) {
        return;
      }

      self._running++;

      try {
        return fn.apply(this, args);
      } finally {
        self._running--;
      }
    });
  }

  ignoreIfDisabled(directEditing, 'activate'); // no label editing outside 'model'

  // A drag may start on an element some exception is about, whatever it ends in: a gesture is not an
  // operation, and the operation it issues is judged on its own when it is issued.
  intercept(dragging, 'init', function(fn, args) {
    if (self._modelingDisabled && !self._concerns(dragged(args))) {
      return;
    }
    return fn.apply(this, args);
  });

  // the pad opens where an exception keeps an entry; the filter below strips the rest
  intercept(contextPad, 'open', function(fn, args) {
    if (self._modelingDisabled && !self.entriesFor(args[0]).length) {
      return;
    }
    return fn.apply(this, args);
  });

  [
    'moveShape', 'moveElements', 'moveConnection', 'layoutConnection', 'createConnection',
    'createShape', 'createLabel', 'appendShape', 'removeElements', 'distributeElements',
    'removeShape', 'removeConnection', 'replaceShape', 'pasteElements', 'alignElements',
    'resizeShape', 'createSpace', 'updateWaypoints', 'reconnectStart', 'reconnectEnd',
    'updateAttachment'
  ].forEach(fn => ignoreUnlessPermitted(modeling, fn, args => args[0]));

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
