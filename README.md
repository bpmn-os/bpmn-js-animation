# bpmn-js-animation

API-driven token animation for [bpmn-js](https://github.com/bpmn-io/bpmn-js).

Render **tokens** — colored dots — on a BPMN diagram and move them along flows under
**programmatic control**. There is no execution engine: the host application decides when tokens
are created, moved, split, and removed. It's the "visualization only" counterpart to
[bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation).

> The low-level token tween (the bottom of `lib/AnimationAPI.js`) is vendored and adapted from
> bpmn-js-token-simulation (MIT). Everything else is new.

## Two layers

The module registers two bpmn-js services:

- **`simulation`** — a high-level, BPMN-shaped vocabulary (`createToken`, `advanceToken`,
  `forkToken` / `joinTokens`, `consumeToken`). It addresses tokens by readable `(node, label)`
  names and applies prescribed per-type behaviour. **The supported surface most hosts use.**
  → **[docs/simulation-api.md](docs/simulation-api.md)**
- **`animation`** — the low-level visual primitive it's built on (place a dot, move it along a
  flow, set its position, stack a node into instances). Use it directly for full control.
  → **[docs/animation-api.md](docs/animation-api.md)**

## Install

```sh
npm install bpmn-js-animation
```

## Basic usage

```javascript
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import AnimationModule from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new BpmnViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

await viewer.importXML(diagramXML);

const simulation = viewer.get('simulation');

// start a process instance (a colored dot on the implicit process / pool)
simulation.createToken({ node: 'Process_1', label: 'order-42' });

// a child token at the start event, then travel it along a flow and into a task
simulation.createToken({ node: 'StartEvent_1', label: 'order-42' });
await simulation.advanceToken({ node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'busy' });

// react to clicks on a token (the host decides what to show)
viewer.get('eventBus').on('token.click', ({ node, label }) => console.log('clicked', label, 'at', node));
```

For full control over placement, movement, selection, icons, and instance stacks, drive the
**`animation`** service directly — see **[docs/animation-api.md](docs/animation-api.md)**.

## Development

```sh
npm install     # deps (incl. dev: bpmn-js + vite for the example)
npm run dev     # vite playground (example/) — the visual check
npm test        # karma + mocha in headless Chrome
npm run build   # production bundle of the example (sanity-checks all imports)
```

## License

MIT
