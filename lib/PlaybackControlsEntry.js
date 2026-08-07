/**
 * createPlaybackControlsEntry — the reusable run/pause + speed control for a token panel, lifted out of
 * the panel's footer so every consumer (the animation demo, each workbench) composes the identical
 * transport instead of re-implementing the run button's state logic.
 *
 * The run button is the stateful part worth sharing: it reflects the `playback` state machine
 * (idle → play, playing → pause, paused → resume), swaps its play/pause glyph and title, disables
 * itself when idle with nothing to start, and re-syncs on `playback.changed`. The speed slider maps a
 * right-is-faster range onto `primitives.setAnimationDuration`.
 *
 * Starting from idle needs a log. By convention everything is a *log source*: the control pulls one
 * from `playback.getLogSource()` unless the consumer passes a `resolveLog` that yields a log its own
 * way (a loaded file, a recording, an engine run). Whether the idle button is enabled comes from
 * `canStart` (default: a log source is registered).
 *
 * A log may also be one that grows. A player that produces a run as it plays it says so through
 * `isStreaming()`, and while it does an empty log is a run that has produced no record yet rather than
 * nothing to play — a manual run standing at its first decision, say. The method is optional: a player
 * without it is asked for a log that is complete when it arrives.
 *
 * @param {Object} options
 * @param {Object} options.playback              the playback controller service (required)
 * @param {Object} options.primitives            the primitives service, for speed (required)
 * @param {Object} [options.eventBus]            when given, the control self-syncs on `playback.changed`
 * @param {Function} [options.resolveLog]        async () => log; what to play on an idle start
 * @param {Function} [options.canStart]          () => boolean; is the idle run button enabled
 * @param {number} [options.minDuration=100]     fastest step duration (ms)
 * @param {number} [options.maxDuration=2000]    slowest step duration (ms)
 * @return {{ element: HTMLElement, update: (function(): void), runButton: HTMLButtonElement }}
 */
export default function createPlaybackControlsEntry(options = {}) {
  const {
    playback,
    primitives,
    eventBus,
    resolveLog,
    canStart,
    minDuration = 100,
    maxDuration = 2000
  } = options;

  const element = el('div', 'bjs-token-playback');

  const runButton = el('button', 'bjs-token-btn bjs-token-run');
  runButton.type = 'button';
  runButton.addEventListener('click', async () => {
    if (!playback) {
      return;
    }
    const state = playback.getState();
    if (state === 'playing') {
      playback.pause();
      return;
    }
    if (state === 'paused') {
      playback.resume();
      return;
    }
    // idle → start: resolve a log (consumer's resolver, else the registered log source) and play it.
    // Consulted only here; pause/resume above act purely on the already-running animation.
    let log = resolveLog ? await resolveLog() : null;
    if ((!log || !log.length) && playback.getLogSource && playback.getLogSource()) {
      log = await playback.getLogSource()();
    }
    // A run produced as it is played begins with nothing and grows, which is what a player declares by
    // opening a stream, so an empty log is playable while its stream is open: a run whose first step
    // produced no record has begun all the same, and refusing it throws away a run that is already under
    // way. Only a log that is empty and closed has nothing to play. A player that does not stream answers
    // nothing here and is unaffected.
    if (!log || (!log.length && !(playback.isStreaming && playback.isStreaming()))) {
      console.warn('no execution log to play — record a run, load a log, or register a log source');
      return;
    }
    playback.play(log);
  });
  element.appendChild(runButton);

  // speed = animation step duration; the slider runs right-is-faster, so map both ways through the sum
  const speedRow = el('label', 'bjs-token-speed');
  speedRow.textContent = 'Speed';
  const slider = el('input', 'bjs-token-slider');
  slider.type = 'range';
  slider.min = String(minDuration);
  slider.max = String(maxDuration);
  slider.step = '100';
  const span = minDuration + maxDuration;
  const toDuration = (v) => span - Number(v);
  if (primitives) {
    slider.value = String(span - primitives.getAnimationDuration());
    slider.addEventListener('input', () => primitives.setAnimationDuration(toDuration(slider.value)));
  }
  speedRow.appendChild(slider);
  element.appendChild(speedRow);

  const update = () => {
    const state = playback ? playback.getState() : 'idle';
    runButton.innerHTML = state === 'playing' ? PAUSE_SVG : PLAY_SVG;
    runButton.title = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Run';
    // enabled while playing/paused (to pause/resume); when idle, only if there is something to start
    const startable = canStart
      ? canStart()
      : !!(playback && playback.getLogSource && playback.getLogSource());
    runButton.disabled = !playback || (state === 'idle' && !startable);
  };

  if (eventBus) {
    eventBus.on('playback.changed', update);
  }
  update();

  return { element, update, runButton };
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

const PLAY_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 2l7 4-7 4z"/></svg>';
const PAUSE_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 2h2v8H3zm4 0h2v8H7z"/></svg>';
