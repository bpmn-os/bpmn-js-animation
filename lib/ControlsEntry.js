import createPlaybackControlsEntry from './PlaybackControlsEntry';

/**
 * The controls a run is driven by: run and pause with the speed beside them, and, apart from them, the
 * three that act on the run as a whole — begin again, load a log to replay, save the log a run produced.
 *
 * It is one entry rather than a part of the Tokens tab because it governs the run and not the list of
 * tokens. The tab is where it stands when nothing says otherwise, at the foot of the tab; a host with a
 * place of its own for what governs the whole panel — the panel's footer — takes it there instead, and the
 * tab is told to draw none. Either way it is the same element with the same state, so a run has one set of
 * controls wherever they are put.
 *
 * The transport is `createPlaybackControlsEntry`, which owns the run button's state machine and keeps
 * itself in step with `playback.changed`. What is added here is the row beside it.
 *
 * @param {Object} options
 * @param {Object} options.playback  the playback service, which the transport drives
 * @param {Object} options.primitives
 * @param {Object} options.eventBus  `tokenPanel.refresh` is announced on it when a run is begun again
 * @param {Object} [options.animation]  cleared when a run is begun again
 * @param {Object} [options.simulator]  where there is one, what it recorded is what a save saves
 * @param {Function} options.resolveLog  () => the log to replay
 * @param {Function} [options.canStart]  () => whether an idle start is offered
 * @param {Function} [options.onLoad]  (log) => void — a log read from a file, for the host to hold
 * @param {string} [options.filename='execution-log.json']  what a save writes to
 * @return {{ element: Element, transport: Object, update: Function, setMode: Function,
 *          setLogButton: Function, destroy: Function }}
 */
export default function createControlsEntry(options) {
  const {
    playback,
    primitives,
    eventBus,
    animation,
    simulator,
    resolveLog,
    canStart,
    onLoad,
    filename = 'execution-log.json'
  } = options;

  const element = el('div', 'bjs-token-controls-entry');

  const transport = createPlaybackControlsEntry({
    playback, primitives, eventBus, resolveLog, canStart
  });

  element.appendChild(transport.element);

  // The three that act on the run as a whole. They carry no words, a row of icons under a run being read
  // by their shapes; each says what it is when it is pointed at.
  const row = el('div', 'bjs-token-controls-row');

  const refresh = button(REFRESH_ICON, 'Start again', async () => {
    if (playback) {
      await playback.stop();
    }

    if (animation) {
      animation.clear();
    }

    if (simulator) {
      simulator.startRecording();
    }

    // What beginning again means to a host is the host's: a log source may re-roll its seed so that the
    // next start is a fresh run. The entry knows nothing of any of that.
    eventBus.fire('tokenPanel.refresh', {});
  });

  const file = el('input', 'bjs-token-file');

  file.type = 'file';
  file.accept = 'application/json,.json';
  file.style.display = 'none';
  file.addEventListener('change', async (event) => {
    const chosen = event.target.files && event.target.files[0];

    event.target.value = '';   // so that the same file may be loaded twice

    if (!chosen) {
      return;
    }

    try {
      const log = JSON.parse(await chosen.text());

      if (typeof onLoad === 'function') {
        onLoad(log && log.length ? log : null);
      }

      transport.update();
    } catch (err) {
      console.error('invalid log JSON in "' + chosen.name + '":', err);
    }
  });

  const load = button(LOAD_ICON, 'Load log', () => file.click());

  const save = button(SAVE_ICON, 'Save log', () => {
    const log = simulator
      ? simulator.getRecording()
      : (playback && playback.getLog ? (playback.getLog() || []) : []);

    if (!log.length) {
      return;
    }

    const link = document.createElement('a');

    link.href = URL.createObjectURL(new Blob([ JSON.stringify(log, null, 2) ], { type: 'application/json' }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  row.append(refresh, load, file, save);
  element.appendChild(row);

  /**
   * What the log controls may do: 'load' where a log is read to be replayed, 'save' where the run produces
   * one worth keeping. Both stay where they are and the one that cannot act is greyed, so that the row
   * neither changes shape as a host turns over nor offers a control that would do nothing: a log cannot be
   * loaded into a run that is producing its own.
   */
  function setLogButton(kind) {
    load.disabled = kind === 'save';
  }

  /**
   * What the entry is for: a run that is played, or one the reader drives.
   *
   * A driven run has nothing to play: it is made by the reader, gesture by gesture, so the transport and its
   * speed are not there at all. What acts on the run as a whole stays where it is and keeps the right edge,
   * so that the controls a reader reaches for do not move as a host turns over; whether a log may be read
   * into the run is `setLogButton`, which greys the control rather than taking it away.
   */
  function setMode(mode) {
    transport.element.hidden = mode === 'simulate';
  }

  setMode('play');
  setLogButton('load');

  return {
    element,
    transport,
    update: () => transport.update(),
    setMode,
    setLogButton,
    destroy() {
      transport.destroy && transport.destroy();
      element.remove();
    }
  };
}

function button(icon, title, onClick) {
  const node = el('button', 'bjs-token-btn');

  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.innerHTML = icon;
  node.addEventListener('click', onClick);

  return node;
}

function el(tag, className) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  return node;
}

// Feather's, inlined so that the package needs no icon font, and drawn at fifteen with the stroke thickened
// to keep the weight the grid was drawn for.
const FEATHER = (paths) =>
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" '
  + 'style="vertical-align:-3px">' + paths + '</svg>';

const REFRESH_ICON = FEATHER(
  '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>');

const SAVE_ICON = FEATHER(
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>'
  + '<line x1="12" y1="15" x2="12" y2="3"/>');

const LOAD_ICON = FEATHER(
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/>'
  + '<line x1="12" y1="3" x2="12" y2="15"/>');
