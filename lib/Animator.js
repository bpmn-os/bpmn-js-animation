import { eventCall, startsImmediately } from './executionLog';

/**
 * Animator — an opinionated **playback** tool over the `animation` service, the mirror of the
 * `Simulator`: where the simulator turns **user gestures → token-flow functions**, the animator turns a
 * recorded **execution log → functions**. It owns **replay**; it does not record (that's the simulator's job)
 * and does not depend on it — the two are independent and share only the {@link executionLog} format.
 *
 * Add the `animator` service to a viewer (e.g. via `AnimatorModule`) to play back an execution log — the
 * package's stated purpose, animating logs produced by an external execution engine. The log is plain,
 * serialisable data (see {@link executionLog}); replay re-issues each entry against `animation` at the
 * animation speed, following the active instance and plane when `autoFocus` is on.
 */
export default function Animator(animation, primitives) {
  this._animation = animation;
  this._primitives = primitives;
  this._autoFocus = false; // follow the active instance/plane while replaying (a setting)
}

Animator.$inject = [ 'animation', 'primitives' ];

/**
 * Toggle "auto-focus" for replay: when on, each event reveals its instance (and drills to its plane)
 * before animating, so the motion plays where it belongs. Forwards to `animation.autoFocus` so the
 * functions' own post-op reveal fires too. Off by default.
 */
Animator.prototype.autoFocus = function(on = true) {
  this._autoFocus = !!on;
  this._animation.autoFocus(this._autoFocus);
};

/**
 * Replay an event `log` (an array of flat `{ action, ...fields }` events — see {@link executionLog})
 * against the `animation` service, in order. Most events are an **arrival/settle** and play
 * **serially** — each waits for every previously-started animation to complete, then plays at the
 * animation speed (so the run paces itself, exactly like driving it live). The **departures** — a
 * token travelling out along a flow (see {@link startsImmediately}) — start **immediately** instead,
 * so the branches of a diverging gateway leave **together** rather than one-after-another. The next
 * arrival/settle event drains them, so concurrency only appears where those immediate events are
 * adjacent. With `autoFocus` on, each serial event reveals its instance and drills the canvas in/out
 * of a collapsed sub-process before animating. Pass `gate` (awaited before each event) to **pause**;
 * throw from it to **abort** (stops at the next event).
 *
 * @param {Array<object>} log
 * @param {{ gate?: () => (void | Promise<void>) }} [options]
 * @return {Promise<void>}
 */
Animator.prototype.replay = async function(log, { gate } = {}) {
  const animation = this._animation;
  let outstanding = []; // animations started but not yet awaited (the immediate departures)

  for (const event of log) {
    if (gate) {
      await gate();
    }

    // Departure: normally start now, concurrently with whatever is still animating, so a gateway's
    // same-instance branches (already on the front) leave together. But a departure whose token is on a
    // **different, hidden** instance — e.g. an event-sub firing in a back instance — would travel
    // off-screen, and the next event would show it already arrived. So when following, if its token is
    // not the visible front instance, drain the burst and reveal it before starting (it is a separate
    // instance's action, so it shouldn't ride the previous burst anyway).
    if (startsImmediately(event)) {
      if (this._autoFocus && event.node != null) {
        const token = animation.getToken(event.node, event.label);
        if (token && !this._primitives._isVisible(token)) {
          await Promise.all(outstanding);
          outstanding = [];
          this._primitives.drillTo(event.node);
          animation.focusToken(token);
          await animation.whenFocused();
        }
      }
      outstanding.push(Promise.resolve(eventCall(animation, event)));
      continue;
    }

    // Arrival/settle (a wait event): let every previously-started animation finish first, so this plays
    // against a fully-settled diagram (and the immediate burst before it has landed).
    const pending = outstanding;
    outstanding = [];
    await Promise.all(pending);

    // When following (auto-focus on), follow the action across **planes** and **instances** before
    // animating it — so the motion / icon plays where it belongs, not on whatever was last shown.
    if (this._autoFocus) {
      const node = event.node != null ? event.node : event.fromNode;

      // (a) Drill the canvas to the event's plane — a token inside a **collapsed sub-process** lives
      // on a separate plane, so without this its body motion would play off-screen. Drills in when the
      // node is on an inner plane, back out when it's on the active root's. Cheap no-op otherwise.
      if (node != null) {
        this._primitives.drillTo(node);
      }

      // (b) Scroll to the event's **instance**. (Auto-focus normally reveals *after* an op, which is
      // fine interactively but wrong for replaying events that jump between instances;
      // `throwIcon`/`catchIcon` don't reveal at all.)
      const token = node != null && animation.getToken(node, event.label);
      if (token) {
        animation.focusToken(token);
        await animation.whenFocused();
      }
    }

    await eventCall(animation, event);

    // let a reveal arc settle before the next event. Resolves immediately when nothing animates.
    await animation.whenFocused();
  }

  await Promise.all(outstanding); // drain any trailing immediate departures
};
