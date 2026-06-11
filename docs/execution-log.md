# The execution log

Simulator and animator exchange process execution logs using a JSON interchange format. It is an array of event objects of the form `{ action, ...fields }`. The `SimulatorModule` records a log from a run, and the `AnimatorModule` replays a log as an animation. The log can equally be produced by an external execution engine.

Each entry in the array must have a field named `action` with value `createToken`, `advanceToken`, `forkToken`, `joinTokens`, or `consumeToken`. These values correspond to functions of the `AnimationModule`, each representing an individual token animation.

Every entry carries a `node` and a `label`. `node` is the id of the BPMN element the action applies to, and `label` is the instance the token belongs to. The other fields depend on the action, and are described with each function:

| Action | Resulting call |
| --- | --- |
| [`createToken`](animation.md#createtoken) | `animation.createToken({ node, label, animate })` |
| [`advanceToken`](animation.md#advancetoken) | `animation.advanceToken({ node, label, sequenceFlow, position, animate })` |
| [`forkToken`](animation.md#forktoken) | `animation.forkToken({ node, label, sequenceFlow })` |
| [`joinTokens`](animation.md#jointokens) | `animation.joinTokens({ node, label })` |
| [`consumeToken`](animation.md#consumetoken) | `animation.consumeToken({ node, label, sequenceFlow })` |

## Example log file

```json
[
  { "action": "createToken",  "node": "Process_1",   "label": "order-42" },
  { "action": "createToken",  "node": "StartEvent_1", "label": "order-42" },
  { "action": "advanceToken", "node": "StartEvent_1", "label": "order-42", "sequenceFlow": "Flow_1" },
  { "action": "advanceToken", "node": "Task_1",       "label": "order-42", "position": "busy", "animate": "pulse" },
  { "action": "consumeToken", "node": "EndEvent_1",   "label": "order-42" }
]
```

## Recording a log with the simulator

The simulator produces a log. It wraps the `animation` calls that it drives, so it can capture a run as a log in this format.

| Method (on `simulator`) | Description |
| --- | --- |
| `startRecording()` | Begin recording. Every later `animation` token-flow call is appended to the log. Any previous recording is discarded. |
| `stopRecording()` → `event[]` | Stop recording and return the log. The log is kept, and the next call to `startRecording` discards it. |
| `getRecording()` → `event[]` | Return a copy of the log recorded so far. Recording continues. |

```javascript
const simulator = viewer.get('simulator');
simulator.startRecording();
// … user drives the model (double-clicks), or a host calls animation.* …
const log = simulator.stopRecording();   // a flat execution log
```

Recording captures every call to the shared `animation` instance, so it works whether the simulator drives the animation or host code does.

## Replaying a log with the animator

The animator consumes a log. It re-issues each entry as the corresponding `animation` call.

| Method (on `animator`) | Description |
| --- | --- |
| `replay(log, { gate? })` → `Promise` | Replay a log in order, re-issuing each entry as its `animation` call. The optional `gate` pauses or aborts replay. The timing and focus behaviour are described below the table. |
| `autoFocus(on = true)` | While replaying, follow the active instance and plane. This forwards to [`animation.autoFocus`](animation.md#autofocus) so the post-operation reveal also runs. It is off by default. |

```javascript
const animator = viewer.get('animator');
animator.autoFocus(true);
await animator.replay(log);
```

Replay runs the events in order, re-issuing each as its `animation` call at the configured animation speed. Most events run one after another, so each event waits for all previously started animations to finish. The exception is a token travelling out along a sequence flow, that is, an `advanceToken` with a `sequenceFlow`. Such an event starts immediately, so the branches of a diverging gateway leave together rather than one after another, and the next event waits for them to arrive.

When `autoFocus` is on, each event that is played in sequence first brings its instance into view, waits for the reveal animation to settle after a `createToken`, and drills the canvas into a collapsed sub-process and back out as the action moves between planes.

The `gate` is a function of type `() => void | Promise<void>` that runs before each event. Await inside it to pause replay, or throw from it to abort, which stops replay at the next event.

```javascript
let paused = false;
await animator.replay(log, {
  gate: () => paused ? new Promise(resolve => { /* resolve when resumed */ }) : undefined
});
```
