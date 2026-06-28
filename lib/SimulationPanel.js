import { is } from 'bpmn-js/lib/util/ModelUtil';

/**
 * SimulationPanel — an opt-in UI that adds a "Simulation" tab to a `bpmn-js-side-panel`, if one is
 * present. It shows the selected token and all tokens at its node (clicking one brings its stack to
 * the front and selects it), plus playback controls (run/pause, speed) and execution-log save/load.
 *
 * Optional at two levels: add `SimulationPanelModule` to get it at all, and it renders only when a
 * `sidePanel` service exists (otherwise it no-ops). The host feeds the log to replay via `setLog()`.
 */
export default function SimulationPanel(injector, eventBus, primitives, animation, config) {
  this._injector = injector;
  this._eventBus = eventBus;
  this._primitives = primitives;
  this._animation = animation;
  this._config = config || {};

  this._playback = injector.get('playback', false);
  this._simulator = injector.get('simulator', false);
  this._animator = injector.get('animator', false);

  this._hostLog = null;      // host-provided default log (e.g. an example's shipped log)
  this._loadedLog = null;    // a log loaded via the panel's "Load log" button
  this._mode = 'play';       // host mode: 'simulate' hides the (playback-only) run/pause control
  this._selection = injector.get('selection', false); // diagram-js selection (selected nodes)
  this._canvas = injector.get('canvas', false);
  this._elementRegistry = injector.get('elementRegistry', false);
  this._processContext = false; // true only after an explicit canvas (root) click → show the process

  eventBus.on('diagram.init', () => this._init());
}

SimulationPanel.$inject = [ 'injector', 'eventBus', 'primitives', 'animation', 'config.simulationPanel' ];

/** Provide the host's default execution log (e.g. an example's shipped log). */
SimulationPanel.prototype.setLog = function(log) {
  this._hostLog = log && log.length ? log : null;
  this._updateRunButton();
};

/** Host mode: 'simulate' hides the playback-only controls (run/pause + speed); 'play' shows them. */
SimulationPanel.prototype.setMode = function(mode) {
  this._mode = mode;
  this._applyMode();
};

SimulationPanel.prototype._applyMode = function() {
  if (this._playbackEl) {
    this._playbackEl.hidden = (this._mode === 'simulate');
  }
};

/** Resolve what Run replays: a panel-loaded log, else the current recording, else the host log. */
SimulationPanel.prototype._resolveLog = function() {
  if (this._loadedLog && this._loadedLog.length) {
    return this._loadedLog;
  }
  if (this._simulator) {
    const recording = this._simulator.getRecording();
    if (recording.length) {
      return recording;
    }
  }
  return this._hostLog || [];
};

SimulationPanel.prototype._init = function() {
  const sidePanel = this._injector.get('sidePanel', false);
  if (!sidePanel) {
    return; // no side panel → simulation panel not shown
  }

  const pane = sidePanel.addTab({ id: 'simulation', label: 'Simulation', priority: 0 });
  this._pane = pane;

  // render into a flex-column child so the footer pins to the bottom — the pane itself keeps the
  // side panel's display:block show/hide (which we must not override), so we don't fight it
  const root = el('div', 'bjs-sim');
  pane.appendChild(root);

  // The simulator hides the node-selection frame (clean look). With the panel we inspect the
  // selected node, so re-enable it — optional via config.simulationPanel.nodeSelection = false.
  if (this._config.nodeSelection !== false) {
    const canvas = this._injector.get('canvas', false);
    if (canvas) {
      canvas.getContainer().classList.add('bts-node-selection');
    }
  }

  this._renderControls(root);
  this._inspector = el('div', 'bjs-sim-inspector');
  root.appendChild(this._inspector);
  this._renderFooter(root);

  // selection is multi (tokens + nodes) — refresh on token selection or diagram-js node selection
  this._eventBus.on('token.selection.changed', () => this._renderInspector());
  this._eventBus.on('selection.changed', () => this._renderInspector());

  // an explicit canvas (root) click means "show the process"; clicking or deselecting a node does
  // not. Runs after the selection behavior (lower priority) so the selection is current, and covers
  // clicking the canvas when the selection was already empty (no selection.changed then).
  this._eventBus.on('element.click', 500, e => {
    const rootEl = this._canvas && this._canvas.getRootElement && this._canvas.getRootElement();
    // clicking the canvas (root) toggles the process context (click again to unselect it); clicking
    // a node clears it
    this._processContext = (rootEl && e.element === rootEl) ? !this._processContext : false;
    this._renderInspector();
  });
  if (this._playback) {
    this._eventBus.on('playback.changed', () => this._updateRunButton());
  }

  this._updateRunButton();
  this._applyMode();
  this._renderInspector();
};

// --- controls ---------------------------------------------------------------

SimulationPanel.prototype._renderControls = function(pane) {
  const controls = el('div', 'bjs-sim-controls');

  // auto-focus toggle — kept at the top (follows the active instance/plane during replay)
  if (this._animator) {
    const af = el('label', 'bjs-sim-autofocus');
    const cb = el('input', null);
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => this._animator.autoFocus(cb.checked));
    this._animator.autoFocus(cb.checked);
    af.appendChild(cb);
    af.appendChild(document.createTextNode(' Auto-focus'));
    controls.appendChild(af);
  }

  // playback-only controls (run/pause + speed + load log): hidden in Simulate mode, where the user
  // advances tokens by clicking — there is nothing to run, and no replay to time
  this._playbackEl = el('div', 'bjs-sim-playback');

  this._runBtn = el('button', 'bjs-sim-btn bjs-sim-run');
  this._runBtn.type = 'button';
  this._runBtn.addEventListener('click', () => {
    if (!this._playback) {
      return;
    }
    const state = this._playback.getState();
    if (state === 'playing') {
      this._playback.pause();
    } else if (state === 'paused') {
      this._playback.resume();
    } else {
      const log = this._resolveLog();
      if (!log.length) {
        console.warn('no execution log to play — record a run, pick an example, or load a log');
        return;
      }
      this._playback.play(log);
    }
  });
  this._playbackEl.appendChild(this._runBtn);

  // speed (animation step duration; lower = faster)
  const speedRow = el('label', 'bjs-sim-speed');
  speedRow.textContent = 'Speed';
  const slider = el('input', 'bjs-sim-slider');
  slider.type = 'range';
  slider.min = '100';
  slider.max = '2000';
  slider.step = '100';
  // right = faster: the slider runs opposite to the duration (so map both ways through 2100 - v)
  const toDuration = v => 2100 - Number(v);
  slider.value = String(2100 - this._primitives.getAnimationDuration());
  slider.addEventListener('input', () => this._primitives.setAnimationDuration(toDuration(slider.value)));
  speedRow.appendChild(slider);
  this._playbackEl.appendChild(speedRow);

  // load an execution log to replay (playback-only)
  const load = el('button', 'bjs-sim-btn');
  load.type = 'button';
  load.textContent = 'Load log';
  const file = el('input', 'bjs-sim-file');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.style.display = 'none';
  load.addEventListener('click', () => file.click());
  file.addEventListener('change', e => this._loadLog(e));
  this._playbackEl.appendChild(load);
  this._playbackEl.appendChild(file);

  controls.appendChild(this._playbackEl);

  pane.appendChild(controls);
};

// Footer pinned to the bottom: refresh (both modes) + save log (when recording is available).
SimulationPanel.prototype._renderFooter = function(pane) {
  const footer = el('div', 'bjs-sim-footer');

  const refresh = el('button', 'bjs-sim-btn');
  refresh.type = 'button';
  refresh.textContent = '↻ Refresh';
  refresh.addEventListener('click', () => this._refresh());
  footer.appendChild(refresh);

  if (this._simulator) {
    const save = el('button', 'bjs-sim-btn');
    save.type = 'button';
    save.textContent = 'Save log';
    save.addEventListener('click', () => this._saveLog());
    footer.appendChild(save);
  }

  pane.appendChild(footer);
};

SimulationPanel.prototype._updateRunButton = function() {
  if (!this._runBtn) {
    return;
  }
  const state = this._playback ? this._playback.getState() : 'idle';
  this._runBtn.textContent = state === 'playing' ? '⏸ Pause' : state === 'paused' ? '▶ Resume' : '▶ Run';
  this._runBtn.disabled = !this._playback;
};

SimulationPanel.prototype._refresh = async function() {
  if (this._playback) {
    await this._playback.stop();
  }
  this._animation.clear();
  if (this._mode === 'simulate' && this._simulator) {
    this._simulator.startRecording();
  }
};

SimulationPanel.prototype._saveLog = function() {
  const log = this._simulator ? this._simulator.getRecording() : [];
  if (!log.length) {
    return;
  }
  const blob = new Blob([ JSON.stringify(log, null, 2) ], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'execution-log.json';
  a.click();
  URL.revokeObjectURL(url);
};

SimulationPanel.prototype._loadLog = async function(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) {
    return;
  }
  try {
    const log = JSON.parse(await file.text());
    this._loadedLog = log && log.length ? log : null;
    this._updateRunButton();
  } catch (err) {
    console.error(`invalid log JSON in "${file.name}":`, err);
  }
};

// --- inspector --------------------------------------------------------------

SimulationPanel.prototype._renderInspector = function() {
  const root = this._inspector;
  if (!root) {
    return;
  }
  root.innerHTML = '';

  // selection is multi: several tokens and/or nodes may be selected at once
  const selectedTokens = this._primitives.getTokens(t => t.selected);
  const selectedIds = this._selection
    ? this._selection.get().filter(el => el && el.id).map(el => el.id)
    : [];

  if (selectedTokens.length) {
    root.appendChild(text('div', 'bjs-sim-list-title', `Selected token${selectedTokens.length > 1 ? 's' : ''} (${selectedTokens.length})`));
    const list = el('ul', 'bjs-sim-list');
    selectedTokens.forEach(token => list.appendChild(this._tokenRow(token)));
    root.appendChild(list);
  }

  // node context: explicitly selected nodes — or, when nothing is selected, fall back to the root
  // like the properties panel does, but only for an implicit process (the root *is* the process).
  // Clicking the canvas clears the diagram-js selection, so this is how "click canvas → process".
  let nodes = unique(selectedIds);
  const rootEl = this._canvas && this._canvas.getRootElement && this._canvas.getRootElement();
  if (!nodes.length && this._processContext && rootEl && is(rootEl, 'bpmn:Process')) {
    nodes = [ rootEl.id ];
  }

  // special-case the select box: frame the process box when the process is the inspected node
  this._frameProcessBox(rootEl, nodes);

  if (selectedTokens.length && nodes.length) {
    root.appendChild(el('div', 'bjs-sim-separator'));
  }

  nodes.forEach(node => {
    const tokens = this._primitives.getTokens(t => t.node === node);
    root.appendChild(text('div', 'bjs-sim-list-title', `Tokens at ${this._displayNode(node)} (${tokens.length})`));
    if (!tokens.length) {
      root.appendChild(hint('No tokens at this node.'));
      return;
    }
    const list = el('ul', 'bjs-sim-list');
    tokens.forEach(token => list.appendChild(this._tokenRow(token)));
    root.appendChild(list);
  });

  if (!selectedTokens.length && !nodes.length) {
    root.appendChild(hint('Select a token or node to inspect.'));
  }
};

// Special-case the select box: an implicit process has no native shape/outline, so frame our drawn
// process box (via setNodeSelected) when the process is the inspected node. No-op without the box,
// when node selection is disabled, or for a real pool/collaboration (those use the native outline).
SimulationPanel.prototype._frameProcessBox = function(rootEl, nodes) {
  if (this._config.nodeSelection === false || !rootEl || !is(rootEl, 'bpmn:Process') || rootEl.width == null) {
    return;
  }
  this._primitives.setNodeSelected(rootEl.id, nodes.indexOf(rootEl.id) !== -1);
};

// A node id for display: a participant (pool) shows its PROCESS id, never the participant id.
SimulationPanel.prototype._displayNode = function(nodeId) {
  const el = this._elementRegistry && this._elementRegistry.get(nodeId);
  const bo = el && el.businessObject;
  return (bo && bo.processRef) ? bo.processRef.id : nodeId;
};

SimulationPanel.prototype._tokenRow = function(token) {
  const row = el('li', 'bjs-sim-row');
  if (token.selected) {
    row.classList.add('selected');
  }
  row.appendChild(swatch(token.color));

  // a token is identified by (label, node) — show the node id below the label
  const info = el('div', 'bjs-sim-token');
  info.appendChild(labelEl(token.label));
  info.appendChild(text('div', 'bjs-sim-token-node', this._displayNode(token.node)));
  row.appendChild(info);

  if (!this._primitives._isVisible(token)) {
    row.appendChild(text('span', 'bjs-sim-badge hidden', 'hidden'));
  }
  row.addEventListener('click', () => this._revealAndSelect(token));
  return row;
};

SimulationPanel.prototype._revealAndSelect = function(token) {
  // bring the token's stack(s) to the front, then select it (reuses the click-selection path)
  Promise.resolve(this._animation.reveal(token)).then(() => {
    this._eventBus.fire('token.click', {
      node: token.node,
      label: token.label,
      sequenceFlow: token.state.sequenceFlow || null,
      stackIndices: token.stackIndices || {},
      originalEvent: {}
    });
  });
};

// --- tiny DOM helpers -------------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function text(tag, className, str) {
  const node = el(tag, className);
  node.textContent = str;
  return node;
}

function hint(str) {
  return text('div', 'bjs-sim-empty', str);
}

function swatch(color) {
  const s = el('span', 'bjs-sim-swatch');
  s.style.backgroundColor = color || '#888';
  return s;
}

// A token label that truncates in the MIDDLE when too narrow (so the start and the end — e.g. the
// "#k" counter — stay visible): the head ellipsizes via CSS, a fixed-length tail always shows.
function labelEl(label) {
  const wrap = el('span', 'bjs-sim-token-label');
  wrap.title = label; // full label on hover
  const tailLen = Math.min(6, Math.floor(label.length / 2));
  wrap.appendChild(text('span', 'bjs-sim-label-head', label.slice(0, label.length - tailLen)));
  wrap.appendChild(text('span', 'bjs-sim-label-tail', label.slice(label.length - tailLen)));
  return wrap;
}

function unique(arr) {
  return Array.from(new Set(arr));
}
