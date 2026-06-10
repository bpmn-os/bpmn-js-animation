# bpmn-js-animation

Animation for BPMN powered by [bpmn-js](https://github.com/bpmn-io/bpmn-js).

![Example](docs/playback.gif)

## Motivation

This project allows to animate BPMN execution using tokens flowing through the model.
It is inspired by [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation), and reuses the fundamental token-flow animation, but takes a deliberately different approach:

- The main goal is an API to programmatically animate process execution controlled by external execution engines.
- The design assumes that multiple instances of processes and activities run simultaneously and independently. To help viewers understand the instance-specific context, every instance is shown in its own environment, and viewers can scroll through these stacked environments by (shift) double-clicking them.
- Besides the API and an animator using json-logs, an interactive simulator is provided. The simulator is buttonless and is driven by double-clicking tokens.

## Installation

Add a module to a bpmn-js viewer and import the stylesheet. The package ships four composable modules:

| Module | Services | Use it for |
| --- | --- | --- |
| `AnimationModule` | `animation` + `primitives` | drive tokens programmatically (the enabling API) |
| `SimulatorModule` | `+ simulator` | the interactive simulator (drives + records) |
| `AnimatorModule` | `+ animator` | replay a recorded event log (playback) |
| *default export* | all of the above | the full drop-in — both tools |

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import TokenAnimationModule from 'bpmn-js-animation'; // the full drop-in
// or: import { AnimationModule, SimulatorModule, AnimatorModule } from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ TokenAnimationModule ]
});

await viewer.importXML(diagramXML);
```

The `animation` API provides function such as `createToken`, `advanceToken`, `forkToken`, `joinTokens`, and `consumeToken` (documented in [docs/animation.md](docs/animation.md). Internally, these call low-level `primitives` documented in  [docs/primitives.md](docs/primitives.md). Tokens are identified by BPMN node and instance label. For unambiguous identification there must never be two tokens at the same node with the same label (race-condition-free models satisfy this).

## Simulator

The **simulator** is a self-contained, **double-click-driven** interactive view — no host orchestration code. A live **demo** is at [bpmn-os.github.io/bpmn-js-animation](https://bpmn-os.github.io/bpmn-js-animation/).

- Spawn a new instance by double-clicking a process **start event**.
- Every activity goes through three stages (start, middle, end); at each, **double-click the token** to advance.
- **Double-click a process** to scroll between its instances (shift-double-click steps back).

![Example](docs/simple_process.gif)

- **Click** the sequence flow(s) out of a diverging gateway to choose them, then double-click the token.
- **Double-click** the token resting at a catching event to trigger it.

![Example](docs/gateways.gif)

A token's animation tells you what it is waiting for:

| Cue | Meaning | What to do |
| --- | --- | --- |
| **bounce** | the token is waiting for **you** | **double-click it** to advance to its next step |
| **pulse** | a process / sub-process is **running** | nothing — it completes on its own once its contents finish |
| **pulse-pause** | a **decision** the simulator can't make without a data layer | pick / spawn, then double-click |

- **Diverging gateway** (exclusive / inclusive / complex): its outflows **dim**; **click** the flow(s) you want (one for exclusive, several for inclusive), then **double-click the token** to depart. A parallel or event-based gateway forks automatically.
- **Standard-loop activity**: at completion the outflows dim — **double-click** with nothing selected to run **another iteration**, or **click an outflow then double-click** to leave the loop.
- **Multi-instance activity**: the outer token **pulse-pauses** on the incoming flow — **double-click** it to spawn a sub-instance, then advance each sub; the activity departs when the last sub completes.

The simulator **records** every BPMN event it drives (`startRecording` / `getRecording`) — in the demo, use **⬇ Download log** to save the log, then replay it with the animator.

## Animator

The **animator** plays back a recorded event log — the package's headline use case, animating a log produced by an external execution engine. A log is plain data, an array of self-describing `{ action, node, label, … }` events; playback paces itself like a live run, but lets a diverging gateway's branches depart concurrently and (with auto-focus) follows the active instance and drills in/out of collapsed sub-processes.

```javascript
const animator = viewer.get('animator');
animator.autoFocus(true);
await animator.replay(eventLog);
```

See [docs/animator.md](docs/animator.md) for the replay API, the event-log format, and the simulator's recording. The [demo](https://bpmn-os.github.io/bpmn-js-animation/) ties them together: a **Simulator ⇄ Playback** toggle — drive a model in Simulator mode (it records every event), then Playback replays it (or any other event log).

## Supported BPMN elements

Tasks (including send / receive), exclusive / parallel / inclusive / complex and event-based gateways, sub-processes (expanded, and collapsed with drill in / out), multi-instance activities, boundary events, event sub-processes, terminate, error & escalation propagation, and link events.

**Not supported**: compensation, call activities, transaction sub-processes.

## Development

```sh
npm install     # deps (incl. dev: bpmn-js + vite for the demo)
npm run dev     # vite dev server — the demo (Simulator ⇄ Playback) at /
npm test        # karma + mocha in headless Chrome
npm run build   # production bundle of the demo → dist/ (sanity-checks all imports)
```

## Disclaimer

This project was built using Claude Code. The code itself has not been reviewed, only the visual behaviour has been validated.

## License

MIT

Copyright © Asvin Goel
