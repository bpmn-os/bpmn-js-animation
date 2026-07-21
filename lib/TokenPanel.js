import { is, isAny } from 'bpmn-js/lib/util/ModelUtil';

import { createCollapsibleEntry } from 'bpmn-js-side-panel';

/**
 * TokenPanel — an opt-in UI that adds a "Tokens" tab to a `bpmn-js-side-panel`, if one is
 * present. It shows the selected token and all tokens at its node (clicking one brings its stack to
 * the front and selects it), plus playback controls (run/pause, speed) and execution-log save/load.
 *
 * Optional at two levels: add `TokenPanelModule` to get it at all, and it renders only when a
 * `sidePanel` service exists (otherwise it no-ops). The host feeds the log to replay via `setLog()`.
 */
export default function TokenPanel(injector, eventBus, primitives, animation, config) {
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
  this._clickTimer = null;     // defer a row's single-click action briefly, so a double-click
  this._clickToken = null;     // (advance) doesn't first run the single-click (which would sole-select)
  this._processContext = false; // true only after an explicit canvas (root) click → show the process
  this._processClickTimer = null; // defers the process toggle so a double-click (scroll) cancels it
  this._refreshSuggestion = () => {}; // no-op until the Instantiate group is rendered (overridden there)
  this._hintsHidden = false;          // once the token list overflows, info hints are removed until refresh
  this._nodeIds = [];           // the node ids currently inspected (selected nodes / process fallback)
  this._tokenFilter = 'all';    // view filter: 'all' lists every token / at-node tokens; 'selected' lists only the selected ones

  eventBus.on('diagram.init', () => this._init());
}

TokenPanel.$inject = [ 'injector', 'eventBus', 'primitives', 'animation', 'config.tokenPanel' ];

/** Provide the host's default execution log (e.g. an example's shipped log). */
TokenPanel.prototype.setLog = function(log) {
  this._hostLog = log && log.length ? log : null;
  this._updateRunButton();
};

/**
 * Mount a consumer-provided control element into the panel's controls region (below the built-in
 * auto-focus toggle), and return a handle to remove it. Lets a consumer extend the panel with its own
 * controls without reaching into the panel's DOM. No-op handle if there is no controls region (no side
 * panel).
 */
TokenPanel.prototype.addControl = function(element) {
  if (this._controlsEl && element) {
    this._controlsEl.appendChild(element);
  }
  return {
    remove() {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element);
      }
    }
  };
};

/** Host mode: 'play' shows the playback controls (run/pause, speed, load); 'simulate' shows save log.
 * A mode switch also clears the selection consistently — the process context here, tokens/nodes via
 * the host (animation.clear + selection.select(null)). */
TokenPanel.prototype.setMode = function(mode) {
  this._mode = mode;
  this._processContext = false;
  this._applyMode();
  this._onNodeSelectionChanged(); // re-evaluate node context (process cleared) + section visibility
};

TokenPanel.prototype._applyMode = function() {
  // model mode: hide all controls / lists / footer and show only the call-to-action note
  const model = this._mode === 'model';
  if (this._modelNote) {
    showEl(this._modelNote, model);
  }
  if (this._controlsEl) {
    showEl(this._controlsEl, !model);
  }
  if (this._inspector) {
    showEl(this._inspector, !model);
  }
  if (this._footerEl) {
    showEl(this._footerEl, !model);
  }
  if (model) {
    return;
  }

  const play = this._mode === 'play';
  if (this._playbackEl) {
    this._playbackEl.hidden = !play; // run/pause + speed: Playback only
  }
  if (this._loadEl) {
    this._loadEl.hidden = !play;     // load log: Playback only
  }
  if (this._saveEl) {
    this._saveEl.hidden = play;      // save log: Simulate only (no recording in Playback)
  }
  if (this._instantiateGroup) {
    showEl(this._instantiateGroup, !play); // Instantiate process: Simulate only (hidden in Playback)
  }

  this._autoExpandInstantiate(); // open the group as a call-to-action when there are no tokens yet
};

// Auto-expand the Instantiate group when there are no tokens — a clear call-to-action to start one.
// Never auto-collapses (the user keeps control once tokens exist).
TokenPanel.prototype._autoExpandInstantiate = function() {
  if (this._mode === 'simulate' && this._openInstantiate && this._primitives.getTokens().length === 0) {
    this._openInstantiate(true);
  }
};

// Info hints compete with the token list for space. When the list overflows, remove the hint rows once
// to give the list room — a ONE-WAY hide: they stay gone (even as the list shrinks) until a refresh
// (tokens.cleared) restores them, so there's no show/hide oscillation.
TokenPanel.prototype._fitHints = function() {
  if (this._hintsHidden || !this._inspector) {
    return;
  }
  if (this._inspector.scrollHeight > this._inspector.clientHeight + 1) {
    this._hintsHidden = true;
    this._setHintsHidden(true);
  }
};

TokenPanel.prototype._setHintsHidden = function(hidden) {
  if (!this._root) {
    return;
  }
  this._root.querySelectorAll('.bjs-token-hint').forEach(h => { h.style.display = hidden ? 'none' : ''; });
  if (this._stackHintSep) {
    this._stackHintSep.style.display = hidden ? 'none' : '';
  }
};

// restore the hints — called on a refresh / clear / mode switch (tokens.cleared)
TokenPanel.prototype._resetHints = function() {
  this._hintsHidden = false;
  this._setHintsHidden(false);
};

/** Resolve what Run replays: a panel-loaded log, else the current recording, else the host log. */
TokenPanel.prototype._resolveLog = function() {
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

TokenPanel.prototype._init = function() {
  const sidePanel = this._injector.get('sidePanel', false);
  if (!sidePanel) {
    return; // no side panel → simulation panel not shown
  }

  const pane = sidePanel.addTab({ id: 'tokens', label: this._config.label || 'Tokens', priority: 0 });
  this._pane = pane;

  // render into a flex-column child so the footer pins to the bottom — the pane itself keeps the
  // side panel's display:block show/hide (which we must not override), so we don't fight it
  const root = el('div', 'bjs-token');
  this._root = root;
  pane.appendChild(root);

  // The simulator hides the node-selection frame (clean look). With the panel we inspect the
  // selected node, so re-enable it — optional via config.tokenPanel.nodeSelection = false.
  if (this._config.nodeSelection !== false) {
    const canvas = this._injector.get('canvas', false);
    if (canvas) {
      canvas.getContainer().classList.add('bts-node-selection');
    }
  }

  this._renderControls(root);
  this._inspector = el('div', 'bjs-token-inspector');
  root.appendChild(this._inspector);
  this._renderFooter(root);

  // model-mode placeholder: in `model` mode the panel shows only this note (the rest is hidden). The host
  // supplies its content (e.g. the workbench's "click Simulation / Playback" note referencing its mode
  // buttons) via `config.tokenPanel.modelNote` — an HTML string or element; empty if not provided.
  this._modelNote = el('div', 'bjs-token-model-note');
  const modelNote = this._config.modelNote;
  if (typeof modelNote === 'string') {
    this._modelNote.innerHTML = modelNote;
  } else if (modelNote) {
    this._modelNote.appendChild(modelNote);
  }
  showEl(this._modelNote, false);
  root.appendChild(this._modelNote);

  // the host's note may offer clickable mode switches (e.g. the workbench's finger / play icons): an
  // element marked data-set-mode="model|simulate|playback" switches mode via the `mode` controller
  this._modelNote.addEventListener('click', e => {
    const target = e.target.closest && e.target.closest('[data-set-mode]');
    const modeService = target && this._injector.get('mode', false);
    if (modeService && modeService.setMode) {
      modeService.setMode(target.getAttribute('data-set-mode'));
    }
  });

  // Persistent inspector structure — built once and updated INCREMENTALLY (rows added/removed/retagged
  // one at a time, sections shown/hidden). The lists are never destroyed and rebuilt.
  // a single persistent heading: "Tokens" + an (all / selected) view filter (radio). The filter only
  // changes WHAT is listed — it never changes the selection itself.
  this._filterHeading = el('div', 'bjs-token-list-title bjs-token-filter');
  this._filterHeading.appendChild(text('span', null, 'Tokens'));
  const mkRadio = (value, label) => {
    const lbl = el('label', null);
    const r = el('input', null);
    r.type = 'radio';
    r.name = 'bjs-token-filter';
    r.checked = this._tokenFilter === value;
    r.addEventListener('change', () => {
      if (!r.checked) {
        return;
      }
      this._tokenFilter = value;
      this._syncNodeList(); // (re)build the at-node/all list when switching to 'all' (no-op for 'selected')
      this._updateVisibility();
    });
    lbl.appendChild(r);
    lbl.appendChild(document.createTextNode(' ' + label));
    return lbl;
  };
  this._filterHeading.appendChild(mkRadio('all', 'all'));
  this._filterHeading.appendChild(mkRadio('selected', 'selected'));

  const filterSeparator = el('div', 'bjs-token-separator'); // rule below the Tokens filter heading

  // 'all' → the node list holds **all** tokens (one untitled list). 'selected' → the selected tokens
  // (under "Selected tokens") **plus** the tokens at the selected node(s) (under "Tokens at …").
  this._selectedTitle = text('div', 'bjs-token-list-title', 'Selected tokens');
  this._selectedList = el('ul', 'bjs-token-list');
  this._separator = el('div', 'bjs-token-separator');
  this._nodeTitle = text('div', 'bjs-token-list-title', 'Tokens at selected node(s)');
  this._nodeList = el('ul', 'bjs-token-list');
  this._nodeEmpty = hint('No tokens at the selected node(s).');
  this._emptyHint = hint('Select a token or node to inspect.');
  [
    this._filterHeading, filterSeparator,
    this._selectedTitle, this._selectedList, this._separator,
    this._nodeTitle, this._nodeList, this._nodeEmpty, this._emptyHint
  ].forEach(node => this._inspector.appendChild(node));

  // Fully event-driven, incremental: each token mutation maps to ONE DOM operation — the lists are
  // never re-derived/rebuilt. Selection events fire in order, so the selected list grows in selection
  // order; a same-node state change updates that one row in place (future: status info).
  this._eventBus.on('token.added', e => { this._onTokenAdded(e.token); this._refreshSuggestion(); this._fitHints(); });
  this._eventBus.on('token.removed', e => { this._onTokenRemoved(e.token); this._autoExpandInstantiate(); this._refreshSuggestion(); });
  this._eventBus.on('token.updated', e => this._onTokenUpdated(e.token));
  this._eventBus.on('token.moved', e => this._onTokenMoved(e));
  this._eventBus.on('token.selection.changed', e => this._onSelectionToggled(e));
  this._eventBus.on('selection.changed', () => this._onNodeSelectionChanged());
  this._eventBus.on('stack.changed', () => this._refreshRows()); // front instance flipped → badges
  // a bulk clear (animation.clear / mode switch) drops the token model without per-token `token.removed`
  // events, so flush the lists explicitly
  this._eventBus.on('tokens.cleared', () => { this._clearLists(); this._autoExpandInstantiate(); this._refreshSuggestion(); this._resetHints(); });

  // re-evaluate the hint fit on panel/window resize — observe the ROOT (not the inspector), so hiding the
  // hints, which changes the inspector/footer split, never re-triggers this. One-way; see _fitHints.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => this._fitHints()).observe(root);
  }

  // the implicit process has no shape, so we track its selection ourselves (processContext) and merge
  // it with the native node selection — for parity with shift-multi-selecting a participant + a node.
  // Clicking the canvas (root) toggles the process; a plain click on a node selects only it (clears
  // the process); a SHIFT-click keeps the process, so process + node multi-select. Lower priority so
  // the native selection is already current.
  this._eventBus.on('element.click', 500, e => {
    const rootEl = this._canvas && this._canvas.getRootElement && this._canvas.getRootElement();
    const shift = !!(e.originalEvent && e.originalEvent.shiftKey);
    if (rootEl && e.element === rootEl) {
      // canvas/implicit-process click. Defer the process toggle so a DOUBLE-click does NOT
      // select+unselect (flash) — the double-click's stack scroll is handled by the animation's
      // element.dblclick (scrollStack), so here we just cancel the pending toggle.
      if (this._processClickTimer) {
        clearTimeout(this._processClickTimer);
        this._processClickTimer = null;
        return;
      }
      this._processClickTimer = setTimeout(() => {
        this._processClickTimer = null;
        this._processContext = !this._processContext;
        this._onNodeSelectionChanged();
      }, 280);
      return;
    }
    if (!shift) {
      this._processContext = false;
    }
    this._onNodeSelectionChanged();
  });
  if (this._playback) {
    this._eventBus.on('playback.changed', () => this._updateRunButton());
  }

  this._updateRunButton();
  this._applyMode();
  this._onNodeSelectionChanged(); // establish the initial node context + section visibility
};

// --- controls ---------------------------------------------------------------

// A usage-hint row: a self-contained info icon (no FontAwesome dependency — the panel also ships in the
// standalone demo) + a sentence (built into one span so an inline illustrative glyph flows with the text).
TokenPanel.prototype._makeHint = function(build) {
  const t = el('div', 'bjs-token-hint');
  t.innerHTML = '<svg class="bjs-token-hint-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="8" cy="5" r="0.95" fill="currentColor"/>'
    + '<rect x="7.2" y="7" width="1.6" height="5" rx="0.5" fill="currentColor"/></svg>';
  const span = el('span', null);
  build(span);
  t.appendChild(span);
  return t;
};

TokenPanel.prototype._renderControls = function(pane) {
  const controls = el('div', 'bjs-token-controls');

  // auto-focus — a header bar with a sliding toggle (follows the active instance/plane during replay).
  // Same bar + switch as the host's properties-panel-style header (e.g. the workbench Issues "Show issues").
  if (this._animator) {
    const bar = el('label', 'bjs-token-header');
    const sw = el('span', 'bjs-token-toggle');
    const cb = el('input', null);
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => this._animator.autoFocus(cb.checked));
    this._animator.autoFocus(cb.checked);
    const slider = el('span', 'bjs-token-toggle-slider');
    sw.appendChild(cb);
    sw.appendChild(slider);
    bar.appendChild(sw);
    bar.appendChild(text('span', null, 'Auto-focus'));
    controls.appendChild(bar);
  }

  // "Instantiate process" — a collapsible group (properties-panel style) to spawn a new instance: pick a
  // process/pool, name the instance, hit Create. Simulate-mode only (hidden in Playback; _applyMode).
  if (this._simulator) {
    this._instantiateGroup = this._renderInstantiateGroup();
    controls.appendChild(this._instantiateGroup);
  }

  this._controlsEl = controls;
  pane.appendChild(controls);
};

// Build the collapsible "Instantiate process" group. Spawning here is identical to double-clicking a
// process start event (`simulator.spawnInstance`), but with a user-chosen process + instance name.
TokenPanel.prototype._renderInstantiateGroup = function() {
  const select = el('select', 'bjs-token-select');
  const input = el('input', 'bjs-token-input');
  input.type = 'text';
  const btn = el('button', 'bjs-token-btn bjs-token-confirm');
  btn.type = 'button';
  btn.title = 'Create process token';
  btn.textContent = '✓';
  btn.disabled = true;

  // suggest the next free auto-name "<process>°k" for the selected process — pre-filled so a single ✓
  // spawns immediately, and repeated ✓ clicks fire successive instances. `isAuto` tracks whether the
  // field still holds a suggestion (vs a name the user typed), so only the former is refreshed.
  let isAuto = false;
  const suggest = () => {
    input.value = (select.value && this._simulator.suggestInstanceLabel)
      ? this._simulator.suggestInstanceLabel(select.value)
      : '';
    isAuto = true;
    btn.disabled = !input.value.trim() || !select.value;
  };
  // keep the suggested name current when instances change elsewhere (e.g. a canvas double-click on a
  // start event spawns an instance via the simulator, which the panel otherwise wouldn't reflect)
  this._refreshSuggestion = () => {
    if (isAuto) {
      suggest();
    }
  };

  // The group is a reusable collapsible entry (bpmn-js-side-panel), so it matches the Issues panel and
  // the properties panel. Opening it repopulates the process list (the model may have changed since the
  // panel was built) and pre-fills a suggested instance name.
  const entry = createCollapsibleEntry({
    label: 'Instantiate process',
    open: false,
    onToggle: open => {
      if (open) {
        this._populateProcessSelect(select);
        if (!input.value) {
          suggest();
        }
        btn.disabled = !input.value.trim() || !select.value;
      }
    }
  });
  const entries = entry.contentEl;

  const procEntry = el('div', 'bjs-token-entry');
  procEntry.appendChild(text('label', 'bjs-token-entry-label', 'Process'));
  procEntry.appendChild(select);
  entries.appendChild(procEntry);

  // instance name + a compact confirm (checkmark) button on the same row
  const nameEntry = el('div', 'bjs-token-entry');
  nameEntry.appendChild(text('label', 'bjs-token-entry-label', 'Instance name'));
  const row = el('div', 'bjs-token-field-row');
  row.appendChild(input);
  row.appendChild(btn);
  nameEntry.appendChild(row);
  entries.appendChild(nameEntry);

  const error = el('div', 'bjs-token-create-error');
  showEl(error, false);
  entries.appendChild(error);

  // usage hints (each: an info icon + a sentence with a self-contained illustrative glyph) — see _makeHint
  entries.appendChild(this._makeHint(s => {
    s.appendChild(document.createTextNode('Double-clicking start events '));
    s.appendChild(el('span', 'bjs-token-hint-start')); // a plain circle, like a (none) start event
    s.appendChild(document.createTextNode(' instantiates processes.'));
  }));
  entries.appendChild(this._makeHint(s => {
    s.appendChild(document.createTextNode('Double-clicking bouncing tokens '));
    s.appendChild(el('span', 'bjs-token-hint-dot')); // a little bouncing dot, like a waiting token
    s.appendChild(document.createTextNode(' advances them.'));
  }));

  this._openInstantiate = entry.setOpen; // let the panel auto-expand the group (e.g. when there are no tokens)

  select.addEventListener('change', suggest); // a different process → its own next free name
  input.addEventListener('input', () => {
    isAuto = false; // the user is typing a custom name — don't overwrite it on the next refresh
    btn.disabled = !input.value.trim() || !select.value;
    showEl(error, false);
  });

  const create = () => {
    if (this._simulator.isActive && !this._simulator.isActive()) {
      return; // only spawn while the simulator is active (Simulate mode)
    }
    const processId = select.value;
    const label = input.value.trim();
    if (!processId || !label) {
      return;
    }
    showEl(error, false);
    // spawnInstance registers the instance synchronously (only the token-advance is async), so the next
    // suggestion already accounts for it — repeated ✓ clicks fire successive instances without colliding
    const spawned = this._simulator.spawnInstance(processId, undefined, label);
    if (spawned && spawned.catch) {
      spawned.catch(err => { error.textContent = err.message; showEl(error, true); });
    }
    suggest();      // refill with the next free name, ready for the next spawn
    input.focus();
  };
  btn.addEventListener('click', create);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) create(); });

  this._populateProcessSelect(select);
  return entry.element;
};

// Fill the process dropdown with the spawnable scopes — every process / pool that has a top-level
// (untyped) start event. The option value is the scope's element id (what `spawnInstance` expects).
TokenPanel.prototype._populateProcessSelect = function(select) {
  const reg = this._elementRegistry;
  const prev = select.value;
  while (select.firstChild) {
    select.removeChild(select.firstChild);
  }
  if (!reg) {
    return;
  }
  reg.forEach(el => {
    if (!isAny(el, [ 'bpmn:Process', 'bpmn:Participant' ])) {
      return;
    }
    const start = (el.children || []).find(c =>
      is(c, 'bpmn:StartEvent') && !(c.businessObject.eventDefinitions || []).length
    );
    if (!start) {
      return; // not spawnable (no plain start event of its own)
    }
    const bo = el.businessObject;
    const name = bo.name || (bo.processRef && bo.processRef.name) || el.id;
    const opt = document.createElement('option');
    opt.value = el.id;
    opt.textContent = name;
    select.appendChild(opt);
  });
  if (prev) {
    select.value = prev; // keep the prior choice if it still exists
  }
};

// Footer pinned to the bottom. Playback adds run/pause + speed on top; both modes end with a row of
// [Refresh][log], where the log button is Load (Playback) or Save (Simulate). Visibility: _applyMode.
TokenPanel.prototype._renderFooter = function(pane) {
  const footer = el('div', 'bjs-token-footer');

  // instance-stack scrolling works in both Simulate and Playback — its hint sits at the TOP of the footer
  // (above the play button in Playback, above the action buttons in Simulate), set off by a separator. It
  // is one of the info blocks auto-hidden when the token list overflows (see _fitHints).
  footer.appendChild(this._makeHint(s => {
    s.appendChild(document.createTextNode('(Shift-)Double-clicking instance stacks '));
    const stack = el('span', 'bjs-token-hint-stack'); // two offset squares — the hidden instance peeks out below-right
    stack.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">'
      + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<rect x="2.5" y="2.5" width="8" height="8" rx="1.5" fill="#fff" stroke="currentColor" stroke-width="1.3"/></svg>';
    s.appendChild(stack);
    s.appendChild(document.createTextNode(' shows hidden instances.'));
  }));
  this._stackHintSep = el('div', 'bjs-token-separator');
  footer.appendChild(this._stackHintSep);

  // playback-only controls (run/pause + speed) — shown in Playback mode
  this._playbackEl = el('div', 'bjs-token-playback');

  this._runBtn = el('button', 'bjs-token-btn bjs-token-run');
  this._runBtn.type = 'button';
  this._runBtn.addEventListener('click', async () => {
    if (!this._playback) {
      return;
    }
    const state = this._playback.getState();
    if (state === 'playing') {
      this._playback.pause();  // pause the running animation
      return;
    }
    if (state === 'paused') {
      this._playback.resume(); // continue the animation — never re-derives the log
      return;
    }
    // idle → start: play a resolvable static log, else pull one from a registered log source (a consumer
    // that yields a log on demand, e.g. by running an engine). The source is consulted ONLY here, so the
    // pause/resume above operate purely on the already-running animation.
    let log = this._resolveLog();
    if (!log.length && this._playback.getLogSource && this._playback.getLogSource()) {
      log = await this._playback.getLogSource()();
    }
    if (!log || !log.length) {
      console.warn('no execution log to play — record a run, pick an example, load a log, or register a log source');
      return;
    }
    this._playback.play(log);
  });
  this._playbackEl.appendChild(this._runBtn);

  // speed (animation step duration; lower = faster)
  const speedRow = el('label', 'bjs-token-speed');
  speedRow.textContent = 'Speed';
  const slider = el('input', 'bjs-token-slider');
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

  footer.appendChild(this._playbackEl);

  // bottom row, same shape in both modes: [Refresh] [log] (Load in Playback, Save in Simulate)
  const row = el('div', 'bjs-token-footer-row');

  const refresh = el('button', 'bjs-token-btn');
  refresh.type = 'button';
  refresh.textContent = '↻ Refresh';
  refresh.addEventListener('click', () => this._refresh());
  row.appendChild(refresh);

  // load an execution log to replay (Playback)
  this._loadEl = el('button', 'bjs-token-btn');
  this._loadEl.type = 'button';
  this._loadEl.textContent = 'Load log';
  const file = el('input', 'bjs-token-file');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.style.display = 'none';
  this._loadEl.addEventListener('click', () => file.click());
  file.addEventListener('change', e => this._loadLog(e));
  row.appendChild(this._loadEl);
  row.appendChild(file);

  // save the recorded log (Simulate)
  if (this._simulator) {
    this._saveEl = el('button', 'bjs-token-btn');
    this._saveEl.type = 'button';
    this._saveEl.textContent = 'Save log';
    this._saveEl.addEventListener('click', () => this._saveLog());
    row.appendChild(this._saveEl);
  }

  footer.appendChild(row);
  this._footerEl = footer;
  pane.appendChild(footer);
};

TokenPanel.prototype._updateRunButton = function() {
  if (!this._runBtn) {
    return;
  }
  const state = this._playback ? this._playback.getState() : 'idle';
  this._runBtn.innerHTML = state === 'playing'
    ? '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 2h2v8H3zm4 0h2v8H7z"/></svg>'
    : '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 2l7 4-7 4z"/></svg>';
  this._runBtn.title = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Run';
  // enabled while playing/paused (to pause/resume); when idle, only if there is something to start —
  // a resolvable static log or a registered log source (see setLogSource)
  const hasSource = !!(this._playback && this._playback.getLogSource && this._playback.getLogSource());
  const canStart = this._resolveLog().length > 0 || hasSource;
  this._runBtn.disabled = !this._playback || (state === 'idle' && !canStart);
};

TokenPanel.prototype._refresh = async function() {
  if (this._playback) {
    await this._playback.stop();
  }
  this._animation.clear();
  if (this._mode === 'simulate' && this._simulator) {
    this._simulator.startRecording();
  }
  // let consumers adapt what "refresh" means for them (e.g. re-roll a log source's seed so the next
  // start produces a fresh run); generic — the panel knows nothing of any consumer's notion of a run
  this._eventBus.fire('tokenPanel.refresh', {});
};

TokenPanel.prototype._saveLog = function() {
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

TokenPanel.prototype._loadLog = async function(event) {
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

// Whether a token belongs in the node list right now: in 'all' it holds **every** token; in 'selected'
// it holds the tokens at the inspected node(s).
TokenPanel.prototype._listsNode = function(node) {
  if (this._tokenFilter === 'all') {
    return true;
  }
  return this._nodeIds.indexOf(node) !== -1;
};

// Reconcile the node list to its desired contents by diff — drop rows no longer wanted, append missing
// ones. 'all' → every token; 'selected' → tokens at the inspected node(s) (empty when none inspected).
TokenPanel.prototype._syncNodeList = function() {
  const desired = this._tokenFilter === 'all'
    ? this._primitives.getTokens()
    : (this._nodeIds.length ? this._primitives.getTokens(t => this._nodeIds.indexOf(t.node) !== -1) : []);
  const wanted = new Set(desired);
  for (const row of Array.from(this._nodeList.children)) {
    if (!row._token || !wanted.has(row._token)) {
      this._nodeList.removeChild(row);
    }
  }
  desired.forEach(t => {
    if (!findByToken(this._nodeList, t)) {
      this._nodeList.appendChild(this._makeRow(t));
    }
  });
};

// A token was created → add a row to the node list if it belongs there (at an inspected node, or any
// node in all-mode).
TokenPanel.prototype._onTokenAdded = function(token) {
  if (this._listsNode(token.node) && !findByToken(this._nodeList, token)) {
    this._nodeList.appendChild(this._makeRow(token));
    this._updateVisibility();
  }
};

// A token was removed (consumed/merged) → drop its row from both lists.
TokenPanel.prototype._onTokenRemoved = function(token) {
  let changed = false;
  for (const ul of [ this._selectedList, this._nodeList ]) {
    const row = findByToken(ul, token);
    if (row) {
      ul.removeChild(row);
      changed = true;
    }
  }
  if (changed) {
    this._updateVisibility();
  }
};

// A token's data changed in place at the same node (phase/status/…) → refresh its row(s) in place.
// Currently retags node/colour/visibility; the hook is here for future per-token data (e.g. status).
TokenPanel.prototype._onTokenUpdated = function(token) {
  for (const ul of [ this._selectedList, this._nodeList ]) {
    const row = findByToken(ul, token);
    if (row) {
      this._updateRow(row, token);
    }
  }
};

// A token changed node → retag its row in place (found by label + OLD node), and update node-list
// membership (it may have left or entered an inspected node). No re-derivation.
TokenPanel.prototype._onTokenMoved = function(e) {
  const selRow = findByLabelNode(this._selectedList, e.label, e.from);
  if (selRow) {
    this._updateRow(selRow, e.token);
  }

  const toInspected = this._listsNode(e.to);
  const nodeRow = findByLabelNode(this._nodeList, e.label, e.from);
  if (nodeRow) {
    if (toInspected) {
      this._updateRow(nodeRow, e.token); // moved within inspected nodes
    } else {
      this._nodeList.removeChild(nodeRow); // left the inspected node
    }
  } else if (toInspected && !findByToken(this._nodeList, e.token)) {
    this._nodeList.appendChild(this._makeRow(e.token)); // entered an inspected node
  }
  this._updateVisibility();
};

// Per-event selection toggle for the selected list — rows grow in SELECTION order; deselect hides the
// row (keeps its slot), re-select shows it in place; the row is removed only when the token is gone.
TokenPanel.prototype._onSelectionToggled = function(e) {
  const token = e.token;
  if (token) {
    const row = findByToken(this._selectedList, token);
    if (e.selected) {
      if (row) {
        showEl(row, true);
      } else {
        this._selectedList.appendChild(this._makeRow(token));
      }
    } else if (row) {
      showEl(row, false);
    }
  }
  this._syncNodeList(); // selecting/deselecting a token enters/leaves all-mode → node list contents
  this._refreshRows();  // reflect the selection highlight on the all / at-node rows too (not just the selected list)
  this._updateVisibility();
};

// Node selection (or the process-context toggle) changed → recompute the inspected nodes and
// reconcile the node list (which also covers the all-mode ↔ node-mode transition).
TokenPanel.prototype._onNodeSelectionChanged = function() {
  const selectedIds = this._selection
    ? this._selection.get().filter(el => el && el.id).map(el => el.id)
    : [];
  let nodes = unique(selectedIds);
  const rootEl = this._canvas && this._canvas.getRootElement && this._canvas.getRootElement();
  // the implicit process joins the selection alongside any selected nodes (multi-select), not only
  // when nothing else is selected
  if (this._processContext && rootEl && is(rootEl, 'bpmn:Process')) {
    nodes = unique(nodes.concat(rootEl.id));
  }
  this._frameProcessBox(rootEl, nodes);

  this._nodeIds = nodes;
  this._syncNodeList();
  this._updateVisibility();
};

// Refresh every existing row in place (e.g. when the stack front flips, the hidden/front badge
// changes). No add/remove/reorder — just _updateRow on the rows already present.
TokenPanel.prototype._refreshRows = function() {
  for (const ul of [ this._selectedList, this._nodeList ]) {
    for (const row of Array.from(ul.children)) {
      if (row._token) {
        this._updateRow(row, row._token);
      }
    }
  }
};

// Flush both lists after a bulk token clear (no per-token events fired), then re-sync against the now
// empty token model so the sections hide.
TokenPanel.prototype._clearLists = function() {
  for (const ul of [ this._selectedList, this._nodeList ]) {
    while (ul.firstChild) {
      ul.removeChild(ul.firstChild);
    }
  }
  this._onNodeSelectionChanged();
};

// Toggle section visibility from the current view filter + row counts — display flips only, never a
// rebuild. The "Tokens" heading (with its all/selected radios) is always shown.
TokenPanel.prototype._updateVisibility = function() {
  const selectedRows = Array.from(this._selectedList.children).filter(r => r.style.display !== 'none');
  const hasSelected = selectedRows.length > 0;
  const hasNodes = this._nodeIds.length > 0;
  const hasNodeRows = this._nodeList.children.length > 0;

  if (this._tokenFilter === 'all') {
    // one untitled list of every token (the radio heading is title enough)
    showEl(this._selectedTitle, false);
    showEl(this._selectedList, false);
    showEl(this._separator, false);
    showEl(this._nodeTitle, false);
    showEl(this._nodeList, hasNodeRows);
    showEl(this._nodeEmpty, false);
    this._emptyHint.textContent = 'No tokens.';
    showEl(this._emptyHint, !hasNodeRows);
    return;
  }

  // 'selected': the selected tokens, plus the tokens at the selected node(s)
  this._selectedTitle.textContent = `Selected token${selectedRows.length > 1 ? 's' : ''}`;
  showEl(this._selectedTitle, hasSelected);
  showEl(this._selectedList, hasSelected);
  showEl(this._separator, hasSelected && hasNodes);
  showEl(this._nodeTitle, hasNodes);
  showEl(this._nodeList, hasNodes && hasNodeRows);
  showEl(this._nodeEmpty, hasNodes && !hasNodeRows);
  this._emptyHint.textContent = 'Nothing selected.';
  showEl(this._emptyHint, !hasSelected && !hasNodes);
};

// Special-case the select box: an implicit process has no native shape/outline, so frame our drawn
// process box (via setNodeSelected) when the process is the inspected node. No-op when node selection is
// disabled, for a real pool/collaboration (native outline), or — crucially — when **no process box is
// currently drawn** (e.g. a modeller in `model` mode): without that guard a canvas click would draw a
// stray outline at the root's (bounds-less/stale) coordinates.
TokenPanel.prototype._frameProcessBox = function(rootEl, nodes) {
  if (this._config.nodeSelection === false || !rootEl || !is(rootEl, 'bpmn:Process') ||
      rootEl.width == null || !this._primitives.getProcessBox()) {
    return;
  }
  this._primitives.setNodeSelected(rootEl.id, nodes.indexOf(rootEl.id) !== -1);
};

// A node id for display: a participant (pool) shows its PROCESS id, never the participant id.
TokenPanel.prototype._displayNode = function(nodeId) {
  const el = this._elementRegistry && this._elementRegistry.get(nodeId);
  const bo = el && el.businessObject;
  return (bo && bo.processRef) ? bo.processRef.id : nodeId;
};

// Build a row for a token. The label never changes for a given row (rows are keyed by label), so the
// swatch/label are built once; the node tag, selected state and hidden badge are set by _updateRow.
TokenPanel.prototype._makeRow = function(token) {
  const row = el('li', 'bjs-token-row');
  row.appendChild(swatch(token.color));

  // a token is identified by (label, node) — show the node id below the label
  const info = el('div', 'bjs-token-token');
  info.appendChild(labelEl(token.label));
  info.appendChild(text('div', 'bjs-token-token-node', ''));
  row.appendChild(info);

  row.addEventListener('click', () => this._onRowClick(row._token));
  row.addEventListener('dblclick', () => this._onRowDblClick(row._token));
  this._updateRow(row, token);
  return row;
};

// Update a row to reflect `token` — the node tag (so an advanced token shows its new node), the
// selected state and the hidden badge. `dataset.label`/`dataset.node` drive reconciliation.
TokenPanel.prototype._updateRow = function(row, token) {
  row._token = token;
  row.dataset.label = token.label;
  row.dataset.node = token.node;
  row.classList.toggle('selected', !!token.selected);

  const sw = row.querySelector('.bjs-token-swatch');
  if (sw) {
    sw.style.backgroundColor = token.color || '#888';
    // mirror the canvas cue on the dot for tokens that need the user: bounce = double-click to
    // advance, pulse-pause = pick / spawn a decision first. Other animate states stay still here.
    const animate = token.state && token.state.animate;
    sw.classList.toggle('bts-anim-bounce', animate === 'bounce');
    sw.classList.toggle('bts-anim-pulse-pause', animate === 'pulse-pause');
  }

  const nodeEl = row.querySelector('.bjs-token-token-node');
  if (nodeEl) {
    nodeEl.textContent = this._displayNode(token.node);
  }

  const badge = row.querySelector('.bjs-token-badge');
  const hidden = !this._primitives._isVisible(token);
  if (hidden && !badge) {
    row.appendChild(text('span', 'bjs-token-badge hidden', 'hidden'));
  } else if (!hidden && badge) {
    badge.remove();
  }
};

// Single click reveals + selects; double click advances. Rows are never recreated, so the native
// dblclick is reliable; the single-click action is deferred so a dblclick cancels it — otherwise the
// first click of a double would sole-select and hide other rows (a flash).
TokenPanel.prototype._onRowClick = function(token) {
  if (this._clickTimer) {
    return; // the second click of a double-click — _onRowDblClick handles it
  }
  this._clickTimer = setTimeout(() => {
    this._clickTimer = null;
    this._revealAndSelect(token);
  }, 250);
};

TokenPanel.prototype._onRowDblClick = function(token) {
  clearTimeout(this._clickTimer);
  this._clickTimer = null;
  this._advanceToken(token);
};

// Advance a token from the panel by firing the canvas's token.dblclick — the simulator (if present)
// runs the step; in a read-only/playback host the event is simply ignored.
TokenPanel.prototype._advanceToken = function(token) {
  this._eventBus.fire('token.dblclick', {
    node: token.node,
    label: token.label,
    sequenceFlow: token.state.sequenceFlow || null,
    stackIndices: token.stackIndices || {},
    originalEvent: {}
  });
};

TokenPanel.prototype._revealAndSelect = function(token) {
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
  return text('div', 'bjs-token-empty', str);
}

function swatch(color) {
  const s = el('span', 'bjs-token-swatch');
  s.style.backgroundColor = color || '#888';
  return s;
}

// A token label that truncates in the MIDDLE when too narrow (so the start and the end — e.g. the
// "#k" counter — stay visible): the head ellipsizes via CSS, a fixed-length tail always shows.
function labelEl(label) {
  const wrap = el('span', 'bjs-token-token-label');
  wrap.title = label; // full label on hover
  const tailLen = Math.min(6, Math.floor(label.length / 2));
  wrap.appendChild(text('span', 'bjs-token-label-head', label.slice(0, label.length - tailLen)));
  wrap.appendChild(text('span', 'bjs-token-label-tail', label.slice(label.length - tailLen)));
  return wrap;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function showEl(node, visible) {
  node.style.display = visible ? '' : 'none';
}

// a row carries its token on `_token` (kept current across moves/updates) and `data-label`/`data-node`
function findByToken(ul, token) {
  return Array.from(ul.children).find(r => r._token === token) || null;
}

function findByLabelNode(ul, label, node) {
  return Array.from(ul.children).find(r => r.dataset.label === label && r.dataset.node === node) || null;
}
