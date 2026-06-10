# Animator (playback) — `animator` service

The **animator** plays back a recorded **event log**, turning it into animated token flow. It's an
opinionated *tool* on top of the [`simulation`](simulation-api.md) vocabulary — the mirror of the
interactive [`simulator`](../README.md#interactive-simulator): where the simulator turns *user gestures
→ token-flow verbs*, the animator turns *a log → verbs*. It owns **replay**; it doesn't record (that's
the simulator's job) and doesn't depend on it. The two share only the **event-log format** below.

Playing back a log is the package's headline use case — animating a log produced by an external
execution engine.

## Installation

Add the **`AnimatorModule`** (`animation` + `simulation` + `animator`) — or the full default export,
which bundles both tools:

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { AnimatorModule } from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimatorModule ]
});

await viewer.importXML(diagramXML);
const animator = viewer.get('animator');

animator.autoFocus(true);
await animator.replay(eventLog);
```

## API

| Method | Description |
| --- | --- |
| `replay(log, { gate? })` → `Promise` | Replay a log, in order — each entry re-issues its `simulation` call at the animation speed. Most events play **serially** (each waits for every previously-started animation to finish), but a token **travelling out along a flow** (`advanceToken` with a `sequenceFlow`) starts **immediately**, so a diverging gateway's branches leave **together** rather than one-after-another; the next event drains them. With **`autoFocus`** on, each serial event reveals its instance **before** animating it (and lets a reveal arc settle after a `createToken`) and drills the canvas **into** a collapsed sub-process's body and back **out** as the action crosses planes. Pass `gate` (awaited before each event) to **pause**; throw from it to **abort** (stops at the next event). |
| `autoFocus(on = true)` | Follow the active instance/plane while replaying. Forwards to [`simulation.autoFocus`](simulation-api.md#autofocuson--true) so the verbs' own post-op reveal fires too. Off by default. |

A `gate` is any `() => void | Promise<void>` run before each event — `await` inside it to pause, or
throw to abort:

```javascript
let paused = false;
await animator.replay(log, {
  gate: () => paused ? new Promise(resolve => { /* resolve when resumed */ }) : undefined
});
```

## The event-log format

A log is plain, serialisable data — an array of flat, self-describing **event objects**
`{ action, ...fields }`, where `action` is a [`simulation`](simulation-api.md) method name and the
fields are its named arguments. The recorded methods are the semantic token-flow operations an
execution engine emits (`createToken` / `advanceToken` / `forkToken` / `joinTokens` / `consumeToken`,
plus `jumpToken` / `departToken` / `throwIcon` / `catchIcon` / `playTokenEffect`). View navigation and
focus settings are **not** part of a log — replay derives which instance to show from the events
themselves (run it with `autoFocus` on).

```json
[
  { "action": "createToken",  "node": "Process_1",   "label": "order-42" },
  { "action": "createToken",  "node": "StartEvent_1", "label": "order-42" },
  { "action": "advanceToken", "node": "StartEvent_1", "label": "order-42", "sequenceFlow": "Flow_1" },
  { "action": "advanceToken", "node": "Task_1",       "label": "order-42", "position": "busy" },
  { "action": "consumeToken", "node": "EndEvent_1",   "label": "order-42" }
]
```

You can author a log directly (mapping your engine's events to these), or capture one with the
**simulator's recording**.

## Recording (producing a log) — the `simulator`

The interactive [`simulator`](../README.md#interactive-simulator) is the matching producer: it wraps
the `simulation` verbs it drives, so it can capture a run as a log in this exact format.

| Method (on `simulator`) | Description |
| --- | --- |
| `startRecording()` | Begin recording — every subsequent `simulation` token-flow call is appended to the log. Resets any prior recording. |
| `stopRecording()` → `event[]` | Stop appending and return the log (also kept; `startRecording` resets it). |
| `getRecording()` → `event[]` | The log so far (a copy) — recording stays on. |

```javascript
const simulator = viewer.get('simulator');
simulator.startRecording();
// … user drives the model (double-clicks), or a host calls simulation.* …
const log = simulator.stopRecording();   // a flat event log

// later, on a fresh diagram, with the animator:
await viewer.get('animator').replay(log);
```

Recording captures any call on the shared `simulation` instance, so it works whether the simulator's
own interactions drive it or a host does.
