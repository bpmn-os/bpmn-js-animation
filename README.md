# bpmn-js-animation

Animation for BPMN powered by [bpmn-js](https://github.com/bpmn-io/bpmn-js).

![Example](docs/playback.gif)

## Motivation

This project allows to animate BPMN execution using tokens flowing through the model.
It is inspired by [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation), and reuses the fundamental token-flow animation, but takes a deliberately different approach:

- The main goal of this project is to provide an API that can be used to programmatically animate process execution logs produced by external execution engines.
- The design assumes that multiple instances of processes and activities can run simultaneously and independently. To help viewers understand the instance-specific context, every instance is shown
  in its own environment and viewers can scroll through these stacked environments by
  (shift) double-clicking them.
- Besides the API, a user-controlled simulator is provided. The simulator is buttonless and simulation is primarily controlled by double-clicking tokens.

## Simulation API

The API allows to control token simulation programmatically using a small set of provided high-level functions (`createToken`, `advanceToken`, `forkToken`, `joinTokens`, `consumeToken`, …). Tokens are identified by BPMN node and label. To guarantee unambiguous identification, process execution must guarantee that at no time there are multiple tokens at the same node with the same label. Process models free of race conditions satisfy this property. Should there be multiple tokens at the same node with the same label, these tokens are visualised next to each other as a queue, and user selection of such tokens may not resolve to the correct identity should the host application aim to show additional token-specific information, e.g. in a property panel.

### Installation

Add the **`AnimationModule`** (the `animation` + `simulation` services, without the interactive simulator) to a bpmn-js viewer and import the stylesheet:

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { AnimationModule } from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

await viewer.importXML(diagramXML);
const simulation = viewer.get('simulation');
```

An example animating a process instance through `start → task → end`:

```javascript
// an instance: a token on the process box, and one at the start event
simulation.createToken({ node: 'Process_1', label: 'order-42' });
simulation.createToken({ node: 'StartEvent_1', label: 'order-42' });

// travel the start event's token along Flow_1 into the task, then run it
await simulation.advanceToken({ node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'busy' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'completion' });

// depart along Flow_2 to the end event, anchor there, and consume
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', sequenceFlow: 'Flow_2' });
await simulation.advanceToken({ node: 'EndEvent_1', label: 'order-42' }); // center-anchor
await simulation.consumeToken({ node: 'EndEvent_1', label: 'order-42' });
```

Further details can be found in the [Simulation API documentation](docs/simulation-api.md), and the [Animation API documentation](docs/animation-api.md) describes the low-level primitives underneath.

## Playback

On top of the enabling API sit two optional **tools**, each its own module — the **simulator** (interactive driving, below) and the **animator** (playback). The **animator** plays back a recorded **event log** — the package's headline use case, animating a log produced by an external execution engine. A log is plain data, an array of self-describing `{ action, node, label, … }` events; playback paces itself like a live run, but lets a diverging gateway's branches depart **concurrently** and (with auto-focus) follows the active instance and drills in/out of collapsed sub-processes.

```javascript
import { AnimatorModule } from 'bpmn-js-animation';
// … additionalModules: [ AnimatorModule ]
const animator = viewer.get('animator');
animator.autoFocus(true);
await animator.replay(eventLog);
```

The **simulator** is the matching producer: it **records** the events you drive (`startRecording` / `getRecording`), so the [demo](https://bpmn-os.github.io/bpmn-js-animation/) records an interactive run and replays it in Playback. See the [Animator (playback) documentation](docs/animator-api.md).

## Interactive simulator

A **demo** of the interactive simulator can be found
[here](https://bpmn-os.github.io/bpmn-js-animation/).

### Installation

Add the **default export** (the full drop-in — `animation` + `simulation` + both tools, `simulator` *and* `animator`) to a bpmn-js viewer and import the stylesheet. (For just the interactive simulator without playback, use the named `SimulatorModule`; the modules compose freely — `AnimationModule`, `SimulatorModule`, `AnimatorModule`, or the full default.)

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import TokenAnimationModule from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ TokenAnimationModule ]
});

await viewer.importXML(diagramXML);
// that's it — double-click a start event to spawn an instance, double-click tokens to advance them
```

### Usage

- You can spawn a new instance by double-clicking on the start event of a process.
- Every activity goes through three stages: start, middle, and end. At each stage you can double-click the token to advance.
- You can double-click on a process to scroll between its instances (shift-double-click steps back).

![Example](docs/simple_process.gif)

- You can select the sequence flows out of a diverging gateway by clicking on it.
- You can double-click on the token resting at a catching event to trigger the event.

![Example](docs/gateways.gif)

The simulator is double-click driven. A token's animation tells you what it is waiting for:

| Cue | Meaning | What to do |
| --- | --- | --- |
| **bounce** | the token is waiting for **you** | **double-click it** to advance to its next step |
| **pulse** | a process / sub-process is **running** | nothing, it completes on its own once its contents finish |
| **pulse-pause** | a **decision** that the simulator can't make without a data layer | pick / spawn, then double-click |

- **Diverging gateway** (exclusive / inclusive / complex): its outflows **dim**; **click** the flow(s) you want (one for exclusive, several for inclusive), then **double-click the token** to depart. A parallel or event-based gateway forks automatically.
- **Standard-loop activity**: at completion the outflows dim — **double-click** with nothing selected to run **another iteration**, or **click an outflow then double-click** to leave the loop.
- **Multi-instance activity**: the outer token **pulse-pauses** on the incoming flow — **double-click** it to spawn a sub-instance, then advance each sub; the activity departs when the last sub completes.

Every observed event and the resulting token action is logged to the browser console. The demo records everything you drive — use **⬇ Download log** to save it, then switch to **Playback** to replay it (or any other event log) on the same page.

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
