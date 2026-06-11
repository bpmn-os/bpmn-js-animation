# The execution log

Simulator and animator exchange execution logs using a JSON interchange format. It is an array of event objects of the form `{ action, ...fields }`. The simulator records a log from a run, and the animator replays a log as an animation. The log belongs to neither tool, so you can also write one yourself by translating the events of an external execution engine into this format. That is the main intended use of the library.

## Format

The `action` field names a method of the `animation` service, and the remaining fields are that method's arguments. The methods that may appear in a log are the token-flow operations an engine emits: `createToken`, `advanceToken`, `forkToken`, `joinTokens`, `consumeToken`, `departToken`, `throwIcon`, and `catchIcon`. 

Replay turns each entry into a single call on the `animation` service. The `action` field selects the method, and the way the remaining fields are passed depends on the method.

Five methods take one object argument. The object is the entry with the `action` field removed, so a field that is absent from the entry is absent from the object. The other three methods take positional arguments in a fixed order, and a missing optional argument is passed as `undefined`.

| Action | Resulting call |
| --- | --- |
| `createToken` | `animation.createToken({ node, label, animate })` |
| `advanceToken` | `animation.advanceToken({ node, label, sequenceFlow, position, animate })` |
| `forkToken` | `animation.forkToken({ node, label, sequenceFlow })` |
| `joinTokens` | `animation.joinTokens({ node, label })` |
| `consumeToken` | `animation.consumeToken({ node, label, sequenceFlow })` |
| `departToken` | `animation.departToken(node, label, sequenceFlow)` |
| `throwIcon` | `animation.throwIcon(node, label)` |
| `catchIcon` | `animation.catchIcon(node, label)` |

A log does not record view navigation or focus. During replay the animator determines which instance to show from the events themselves, provided you turn `autoFocus` on.

```json
[
  { "action": "createToken",  "node": "Process_1",   "label": "order-42" },
  { "action": "createToken",  "node": "StartEvent_1", "label": "order-42" },
  { "action": "advanceToken", "node": "StartEvent_1", "label": "order-42", "sequenceFlow": "Flow_1" },
  { "action": "advanceToken", "node": "Task_1",       "label": "order-42", "position": "busy", "animate": "pulse" },
  { "action": "consumeToken", "node": "EndEvent_1",   "label": "order-42" }
]
```

Every field that can appear in a log is listed below, together with the actions that use it.

| Field | Used by | Meaning |
| --- | --- | --- |
| `action` | every event | The `animation` method to call. |
| `node` | every event | The id of the BPMN element the action applies to. |
| `label` | every event | The instance label that identifies the token. |
| `sequenceFlow` | `advanceToken`, `forkToken`, `consumeToken`, `departToken` | The sequence flow the token travels along or rests on. |
| `position` | `advanceToken` | The target lifecycle position: `entry`, `busy`, `completion`, or `center`. |
| `animate` | `createToken`, `advanceToken` | A looping motion cue on the resting token, for example `bounce` or `pulse`. |


The object forms list every field the method accepts; only the fields present in the entry are included. See [animation.md](animation.md) for what each call does.

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

Recording captures every call to the shared `animation` instance, so it works whether the simulator drives the animation or your own code does.

## Replaying a log with the animator

The animator consumes a log. It re-issues each entry as the corresponding `animation` call.

| Method (on `animator`) | Description |
| --- | --- |
| `replay(log, { gate? })` → `Promise` | Replay a log in order, re-issuing each entry as its `animation` call. The optional `gate` pauses or aborts replay. The timing and focus behaviour are described below the table. |
| `autoFocus(on = true)` | While replaying, follow the active instance and plane. This forwards to [`animation.autoFocus`](animation.md#autofocuson--true) so the post-operation reveal also runs. It is off by default. |

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
