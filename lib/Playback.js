/**
 * Playback — a small, reusable controller around the `animator`'s `replay`, owning the
 * play / pause / resume / stop state machine and a pause/abort gate (previously hand-rolled in
 * the demo). Fires `playback.changed` ({ state }) on every transition so UI (e.g. a run/pause
 * button) can stay in sync. State is one of 'idle' | 'playing' | 'paused'.
 *
 * It does not own the log to replay — the host passes it to `play(log)` (a recording, a loaded
 * file, …). Speed is the animation duration and is set separately (primitives.setAnimationDuration).
 */
export default function Playback(eventBus, animator, animation) {
  this._eventBus = eventBus;
  this._animator = animator;
  this._animation = animation;

  this._state = 'idle';
  this._paused = false;
  this._aborted = false;
  this._resumers = [];
  this._run = Promise.resolve();
  this._logSource = null; // optional consumer hook: yields a log on demand (see setLogSource)
  this._log = null;       // the log most recently handed to play() (see getLog)
}

Playback.$inject = [ 'eventBus', 'animator', 'animation' ];

Playback.prototype.getState = function() {
  return this._state;
};

/**
 * The execution log currently loaded for playback — whatever was last passed to `play(log)` (directly
 * or resolved from a log source). Retained after the run ends, so a consumer's "Save log" can serialize
 * exactly what is/was playing. `null` until something has been played.
 */
Playback.prototype.getLog = function() {
  return this._log;
};

/**
 * Register (or clear, with `null`) a **log source** — a function returning `log | Promise<log>`. It lets a
 * consumer supply the execution log lazily, at the moment playback starts, instead of loading one up front
 * (e.g. running an engine on demand). The transport consults it only on an idle→start; pause/resume act on
 * the already-running animation and never re-invoke it. Firing `playback.changed` lets the panel re-enable
 * its run button when a source appears/disappears.
 */
Playback.prototype.setLogSource = function(source) {
  this._logSource = source || null;
  this._eventBus.fire('playback.changed', { state: this._state });
};

Playback.prototype.getLogSource = function() {
  return this._logSource;
};

Playback.prototype._setState = function(state) {
  if (state === this._state) {
    return;
  }
  this._state = state;
  this._eventBus.fire('playback.changed', { state });
};

// the gate the replay awaits before each event: holds while paused, throws to abort
Playback.prototype._gate = function() {
  if (this._aborted) {
    const err = new Error('playback aborted');
    err.aborted = true;
    throw err;
  }
  return this._paused ? new Promise(resolve => this._resumers.push(resolve)) : undefined;
};

Playback.prototype._drainResumers = function() {
  const rs = this._resumers;
  this._resumers = [];
  rs.forEach(r => r());
};

/**
 * (Re)start replay of `log` from a clean diagram. If already running it is stopped first.
 * @param {Array<object>} log
 * @return {Promise<void>}
 */
Playback.prototype.play = async function(log) {
  if (!log || !log.length) {
    return;
  }
  this._log = log;   // remember what is playing, so getLog() can serialize it (e.g. a "Save log" button)
  if (this._state !== 'idle') {
    await this.stop();
  }
  this._aborted = false;
  this._paused = false;
  this._animation.clear();
  this._setState('playing');

  this._run = (async () => {
    try {
      await this._animator.replay(log, { gate: () => this._gate() });
    } catch (err) {
      if (!(err && err.aborted)) {
        throw err;
      }
    } finally {
      this._paused = false;
      this._resumers = [];
      this._setState('idle');
    }
  })();

  return this._run;
};

Playback.prototype.pause = function() {
  if (this._state === 'playing') {
    this._paused = true;
    this._setState('paused');
  }
};

Playback.prototype.resume = function() {
  if (this._state === 'paused') {
    this._paused = false;
    this._drainResumers();
    this._setState('playing');
  }
};

/** Stop a running/paused replay and wait for it to unwind. */
Playback.prototype.stop = async function() {
  if (this._state === 'idle') {
    return;
  }
  this._aborted = true;
  this._paused = false;
  this._drainResumers(); // let a pending pause reach the gate and abort
  try {
    await this._run;
  } catch (err) {
    // swallow — abort surfaces as a rejected run in some paths
  }
};

/** Convenience for a single run/pause button: idle→play(log), playing→pause, paused→resume. */
Playback.prototype.toggle = function(log) {
  if (this._state === 'playing') {
    this.pause();
  } else if (this._state === 'paused') {
    this.resume();
  } else {
    this.play(log);
  }
};
