# bpmn-js-animation

Animation for BPMN powered by [bpmn-js](https://github.com/bpmn-io/bpmn-js).

![Example](docs/playback.gif)

## Motivation

This project allows to animate BPMN execution using tokens flowing through the model.
It is inspired by [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation), and reuses the fundamental token-flow animation, but takes a deliberately different approach:

- The main goal is an **API to programmatically animate token flows** during process execution (controlled by external execution engines).
- The design assumes that multiple instances of processes and activities run simultaneously and independently. To help viewers understand the instance-specific context, every instance is shown in its own environment, and viewers can scroll through these stacked environments by (shift) double-clicking them.
- Besides the API, an **Animator** and an interactive **Simulator** are provided.

## Installation

To use the library, add one of its modules to a bpmn-js viewer and import the stylesheet. The default export provides the animation API.

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import AnimationModule from 'bpmn-js-animation'; // the animation API (default export)

import 'bpmn-js-animation/assets/animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

await viewer.importXML(diagramXML);
// drive tokens via viewer.get('animation') — see docs/animation.md
```

The `animation` API provides functions such as `createToken`, `advanceToken`, `forkToken`, `joinTokens`, and `consumeToken` (documented in [docs/animation.md](docs/animation.md)). Internally, these call low-level `primitives` documented in [docs/primitives.md](docs/primitives.md). Tokens are identified by BPMN node and instance label. For unambiguous identification there must never be two tokens at the same node with the same label (race-condition-free models satisfy this).

## Demo

The [demo](https://bpmn-os.github.io/bpmn-js-animation/) showcases a **Simulator** and an **Animator** based on the animation API.

Simulator and animator support the following BPMN elements: Tasks (including send / receive), exclusive / parallel / inclusive / complex and event-based gateways, sub-processes (expanded, and collapsed with drill in / out), multi-instance activities, boundary events, event sub-processes, terminate, error & escalation propagation, and link events.

Compensation, call activities, transaction sub-processes are not (yet) supported.

## Simulator

The **simulator** (`SimulatorModule`) allows users to control process execution with a buttonless interactive interface just by double-clicking tokens.

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { SimulatorModule } from 'bpmn-js-animation';
import 'bpmn-js-animation/assets/animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ SimulatorModule ]
});

await viewer.importXML(diagramXML);
// no host code — drive it by double-clicking (start with a process start event)
```

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
| **pulse** | a process / sub-process is **running** | nothing, it completes on its own once its contents finish |
| **pulse-pause** | a **decision** the simulator can't make without a data layer | pick / spawn, then double-click |

- **Diverging gateway** (exclusive / inclusive / complex): its outflows **dim**; **click** the flow(s) you want (one for exclusive, several for inclusive), then **double-click the token** to depart. A parallel or event-based gateway forks automatically.
- **Standard-loop activity**: at completion the **loop marker** is a loop/exit toggle — **black** = loop again (outflows dimmed), **dimmed** = leave. **Double-click** with the marker black runs **another iteration**; **click an outflow** (or **click the loop marker**) to mark "leave", then **double-click** to depart. Clicking the marker also leaves a loop with **no outgoing flow** (implicit end), which then completes.
- **Multi-instance activity**: the outer token **pulse-pauses** on the incoming flow, **double-click** it to spawn an activity-instance, then advance each instance token. An MI activity with **no incoming flow** (e.g. an ad-hoc sub-process child) instead gets its outer token at the activity's **left edge** — double-click it the same way to spawn.

The simulator **records** the execution log (`startRecording` / `getRecording`). In the demo's **Tokens** panel you can **save** the log and **load** it back to replay with the animator.

## Animator

The **animator** plays back a recorded execution log that is either produced by the simulator or an external execution engine. 

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { AnimatorModule } from 'bpmn-js-animation';
import 'bpmn-js-animation/assets/animation.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimatorModule ]
});

await viewer.importXML(diagramXML);

// an array of token-flow events; see docs/execution-log.md for the format
const executionLog = [ /* ... */ ];

const animator = viewer.get('animator');
animator.autoFocus(true);
await animator.replay(executionLog);
```

See [docs/execution-log.md](docs/execution-log.md) for the execution log format.

## Token panel

`TokenPanelModule` adds a **Tokens** tab to a [`bpmn-js-side-panel`](https://github.com/bpmn-os/bpmn-js-side-panel) that inspects the running tokens and hosts the controls. Add it alongside `SidePanelModule` and the simulator / animator you want to drive (the tab label is configurable via `config.tokenPanel.label`):

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import SidePanelModule from 'bpmn-js-side-panel';
import { SimulatorModule, AnimatorModule, TokenPanelModule } from 'bpmn-js-animation';

import 'bpmn-js-side-panel/assets/side-panel.css';
import 'bpmn-js-animation/assets/animation.css';
import 'bpmn-js-animation/assets/token-panel.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ SimulatorModule, AnimatorModule, SidePanelModule, TokenPanelModule ],
  sidePanel: { parent: '#side-panel' }
});
```

The panel:

- has a **Tokens** view filter (radio): **all** lists every token; **selected** lists the selected token(s) **plus** the tokens at the selected node(s) — purely a display switch, it never changes the selection. **Click** a listed token to bring its stack to the front and select it, **double-click** to advance it;
- has an **Instantiate process** group (Simulate mode) for spawning a named instance of a chosen process with a ✓ button — repeat it to start several. The instance name is pre-filled with the next free `<process>°k`, and the group auto-expands as a call-to-action while there are no tokens (double-clicking a process start event still works too);
- marks **actionable** tokens by animating their row dot like the canvas — **bounce** (double-click to advance) or **pulse-pause** (pick / spawn a decision first) — so the list reads as a to-do surface (other tokens stay still);
- shows brief **usage hints** for the double-click gestures, plus a footer note on (shift-)double-clicking instance stacks; the hints auto-hide when the token list needs the room and return on refresh;
- in **model** mode shows an optional host note via `config.tokenPanel.modelNote` (an HTML string or element — e.g. a call-to-action pointing at the host's mode controls);
- hosts **run / pause** + **animation speed** (Playback mode), **save / load** execution log, **refresh**, and an **auto-focus** toggle.

A row lists a token and, where the host supplies `config.tokenPanel.renderTokenDetail`, expands to show a body the host draws, such as the state a token carries in the host's own engine. A row is identified by the node and the label of its token, and it is carried across a hop from one node to the next with everything drawn inside it intact.

The panel no-ops when no side panel is present. Its run/pause is backed by `PlaybackModule` — a reusable playback controller (`play` / `pause` / `resume` / `stop`, with a `playback.changed` event) that wraps the animator and can be used on its own. A run belongs to the diagram it plays on, so loading another model, which clears that diagram, returns the controller to idle and the run button to **Run**.

The panel is assembled from three exported factories, `createTokenEntry`, `createTokenList` and `createPlaybackControlsEntry`, which a host composes into a token list of its own. See [docs/token-panel.md](docs/token-panel.md) for the configuration and for those parts.

## Mode (modeller integration)

`ModeModule` adds a `mode` service — one switch for a host that toggles between **editing** and **simulation** (e.g. a modeller). `mode.setMode('model' | 'simulate' | 'playback')` does it all in one call:

- **model** — the simulator is off and the canvas is fully editable;
- **simulate** — the simulator is on (double-click to drive, recording a log), and editing is disabled;
- **playback** — read-only replay; both editing and the simulator are off.

```javascript
import BpmnModeler from 'bpmn-js/lib/Modeler';
import { SimulatorModule, PlaybackModule, ModeModule } from 'bpmn-js-animation';

const modeler = new BpmnModeler({
  container: '#canvas',
  additionalModules: [ SimulatorModule, PlaybackModule, ModeModule ]
});

modeler.get('mode').setMode('simulate'); // ← your toolbar/canvas control calls this; fires `mode.changed`
```

On each switch it clears the tokens, toggles the `.bts-simulation` view and the palette, and — when modeller services are present — makes the canvas read-only outside `model` (a folded-in port of token-simulation's `DisableModeling`, including hiding the context pad). It is **viewer-safe**: in a plain viewer it only does the simulation gating (no modeller services to touch). The low-level gate is `simulator.setActive(active)` (default on), which `ModeModule` drives.

Read-only is the default rather than the whole story. Some elements are about the run rather than about the process — a note a reader opens to see what a node holds — and a host may keep the modelling of those alive by declaring **exceptions**, as `config.mode.exceptions` or through `mode.setExceptions(exceptions)`:

```js
const modeler = new BpmnModeler({
  mode: {
    exceptions: [ {
      operations: [ 'appendShape', 'moveShape', 'resizeShape', 'removeElements' ],
      entries: [ 'my-note' ],                       // context pad entries kept; every other is stripped
      applies: (operation, element) => isNote(element) || operation === 'appendShape'
    } ]
  }
});
```

An operation runs while a run is on when some exception names it and applies to every element the call names; a drag starts when an exception is about the element the gesture concerns, which is `applies` answering to the operation `dragging`, and the operation the gesture ends in is judged on its own when it is issued; the context pad opens only where an entry is kept and shows the kept entries alone; and an element a move or a resize is permitted on keeps its handles and its selection outline, which the simulation view otherwise hides. Only the outermost call is judged, since how an operation decomposes into others is no business of the host permitting it. `mode.allows(operation, element)` and `mode.entriesFor(element)` answer the same questions to a host driving the modeller itself.

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
