# bpmn-js-animation

Interactive **BPMN token animation** for [bpmn-js](https://github.com/bpmn-io/bpmn-js) and the **API** it's built upon.

Renders tokens on a BPMN diagram and moves them through a process: spawn instances, advance
tasks, fork and join gateways, run sub-processes and multi-instance activities, fire boundary and
event sub-processes, throw and catch errors and escalations, jump link events, and more.

## Motivation

This project is based on [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation), 
kudos to the bpmn-io team. It reuses the core token-flow animation, but takes a deliberately different approach:

- token-simulation shows all tokens of all instances in one holistic view, driven by on-canvas buttons,
  and combines animation with simulation into one module;
- this project separates the API that you can drive programmatically from an interactive simulator
  built on top of it. The simulator has no buttons, you just double-click a start event to spawn an instance
  and double-click a token to advance it; where the model is ambiguous (a diverging gateway, a loop), 
  you select the sequence flow(s) to choose, then double-click the token;
- process instances, multi-instance activities, and non-interrupting event sub-processes are shown as stacks.
  Only the tokens in the front instance are visible; another instance is brought forward by double-clicking the
  stack (Shift+double-click steps back).

## Demo

In the [demo](https://bpmn-os.github.io/bpmn-js-animation/) you can load a diagram (or pick a bundled
example), then double-click the start event and the tokens. The low-level simulation log can be followed
in the browser console.

## Install

```sh
npm install bpmn-js-animation
```

```javascript
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import SimulatorModule from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new BpmnViewer({
  container: '#canvas',
  additionalModules: [ SimulatorModule ]
});

await viewer.importXML(diagramXML);
// that's it, double-click a start event to spawn an instance, double-click tokens to advance them
```

## Simulator

The simulator is **double-click driven**; a token's animation tells you what it is waiting for.

| Cue | Meaning | What to do |
| --- | --- | --- |
| **bounce** | the token is waiting for **you** | **double-click it** to advance to its next step |
| **pulse** | a process / sub-process is **running** | nothing, it completes on its own once its contents finish |
| **pulse-pause** | a **decision** that the simulator can't make without a data layer | pick / spawn, then double-click (see below) |

- **Spawn an instance**: double-click a process (or pool) **start event**. A new instance appears;
  earlier ones stack behind it.
- **Advance a token**: double-click it. A task runs entry → busy → completion → out; an event or
  gateway passes through; a **catch event or boundary** fires.
- **Diverging gateway** (exclusive / inclusive / complex): its outflows **dim**; **click** the flow(s)
  you want (one for exclusive, several for inclusive), then **double-click the token** to depart. A
  parallel or event-based gateway forks automatically.
- **Standard-loop activity**: at completion the outflows dim: **double-click** with nothing selected to
  run **another iteration**, or **click an outflow then double-click** to leave the loop.
- **Multi-instance activity**: the outer token **pulse-pauses** on the incoming flow: **double-click**
  it to spawn a sub-instance, then advance each sub; the activity departs when the last sub completes.
- **Inclusive (OR) join**: fires automatically the moment no other branch can still arrive (proper BPMN
  non-local merge semantics).
- **Errors / escalations**: an error or escalation end event throws; the simulator bubbles it to a
  matching boundary or event sub-process, innermost first.

Every observed event and the resulting token action is logged to the browser **console**.

## Simulation API

To drive tokens programmatically with your own UI, automated tests, or a different interaction model,
use the simulation API directly. It's a high-level, BPMN-shaped vocabulary (`createToken`,
`advanceToken`, `forkToken` / `joinTokens`, `consumeToken`, `jumpToken`, …) that addresses tokens by
readable `(node, label)` names and applies prescribed per-type behaviour.

For example, run one instance through `start → task → end` (each call animates and resolves when the
motion settles):

```javascript
const simulation = viewer.get('simulation');

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

See [documentation](docs/simulation-api.md) for further details.

## Supported BPMN elements

Tasks (including send / receive), exclusive / parallel / inclusive / complex and event-based gateways,
sub-processes (expanded, and collapsed with drill in / out), multi-instance activities, boundary
events, event sub-processes, terminate, error & escalation propagation, and link events.

**Not supported**: compensation, call activities, transaction sub-processes.

## Development

```sh
npm install     # deps (incl. dev: bpmn-js + vite for the demo)
npm run dev     # vite dev server for the demo/ simulator app
npm test        # karma + mocha in headless Chrome
npm run build   # production bundle of the demo → dist/ (sanity-checks all imports)
```

The **`demo/`** app is the simulator above; **`examples/`** holds the showcase models. The demo is
published to GitHub Pages on every push to `main` (`.github/workflows/deploy.yml`).

## Disclaimer

This project was built using Claude Code. The code itself has not been reviewed, only the visual
behaviour has been validated.

## License

MIT

Copyright © Asvin Goel
