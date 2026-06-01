# bpmn-js-token-animation

API-driven token animation for [bpmn-js](https://github.com/bpmn-io/bpmn-js).

Render colored tokens on a BPMN diagram, move them along sequence flows with an
animation, split them at gateways, and make them clickable — all driven by
**your** code. There is **no BPMN simulation engine**: you decide when tokens
are created, where they move, and when they disappear.

> The token-along-connection animator (`lib/Animation.js`) is vendored and
> adapted from [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation)
> (MIT). Everything else is new.

## Install

```sh
npm install bpmn-js-token-animation
```

## Usage

```javascript
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import TokenAnimationModule from 'bpmn-js-token-animation';

import 'bpmn-js-token-animation/assets/token-animation.css';

const viewer = new BpmnViewer({
  container: '#canvas',
  additionalModules: [ TokenAnimationModule ]
});

await viewer.importXML(diagramXML);

const tokens = viewer.get('tokens');

// create a token (a colored dot resting on a node)
tokens.createToken('StartEvent_1', 'order-42', 'tomato');

// move it along a sequence flow (animates, then rests at the flow's target)
await tokens.sendToken([ { node: 'StartEvent_1', label: 'order-42', flow: 'Flow_1' } ]);

// split at a diverging gateway — same source, several flows; one copy per flow
await tokens.sendToken([
  { node: 'Gateway_1', label: 'order-42', flow: 'Flow_3' },
  { node: 'Gateway_1', label: 'order-42', flow: 'Flow_4' }
]);

// join / rewind a split — several sources whose flows land on one node (incoming
// flows animate in reverse); the arrivals merge into one token
await tokens.sendToken([
  { node: 'Task_2', label: 'order-42', flow: 'Flow_3' },
  { node: 'Task_3', label: 'order-42', flow: 'Flow_4' }
]);

// react to clicks — the host app decides what to show
viewer.get('eventBus').on('token.click', ({ node, label }) => {
  console.log('clicked token', label, 'at', node);
});

// remove it
tokens.removeToken('Task_2', 'order-42');
```

## Token identity & color

- A token is identified by the **unique `(node, label)` pair**. `node` is a BPMN
  element id; `label` is any string you choose (an instance id, an order number,
  …). Element ids are unique within a diagram, so no process id is needed.
- Placing a token where `(node, label)` already exists **replaces** it. This also
  makes **joins** trivial: send several branch tokens (same `label`) into a join
  node and they collapse to one.
- **`color` is required** and may be **any CSS color** — name (`tomato`), hex
  (`#3399ff`), `rgb()/rgba()`, `hsl()/hsla()`. It's applied directly, no parsing.
  A token carries its color, so `sendToken` keeps it and split copies inherit it.
- Need a color? Use the **`getRandomColor()`** helper (a named export): mint one per
  identity (e.g. per instance) and reuse it so related tokens stay consistent. The
  package never assigns colors itself.

  ```javascript
  import TokenAnimationModule, { getRandomColor } from 'bpmn-js-token-animation';

  const color = getRandomColor();                 // e.g. "hsl(207, 65%, 45%)"
  tokens.createToken('StartEvent_1', 'order-42', color);
  // reuse `color` for any other token of order-42
  ```
- Tokens carry **no other data** — just `color`. The `label` is shown on **hover**
  (as a tooltip); the dot itself is a plain colored circle.

## `tokens` API

| Method | Description |
| --- | --- |
| `createToken(node, label, color)` | Place a token (replaces an existing one at `(node,label)`). Returns the token. |
| `sendToken([{ node, label, flow }, …])` | Send tokens along flows; each entry takes the token at `(node, label)` and animates it along `flow`. Same-source entries = **split**; different sources landing on one node = **join**; a flow may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). Resolves a `Promise<Token[]>` when all have landed; auto-settles any in-flight source first. |
| `removeToken(node, label)` | Remove the token, cancelling any in-flight animation. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color }`). |
| `clear()` | Remove all tokens. |
| `setDuration(ms)` | Global transition duration (see below). |

### Events (on the bpmn-js `eventBus`)

- `token.click` — `{ node, label }`
- `token.overflow.click` — `{ node, hidden }` (the `+N` marker; `hidden` is the
  list of `{ node, label }` not shown)

### Crowded nodes

At most **`maxVisible`** dots (default **3**) render on a node; beyond that, a
single neutral **`+N`** marker is shown (clicking it fires `token.overflow.click`).
A lone overflow is shown as an extra dot rather than a pointless "+1". Configure
via module config:

```javascript
new BpmnViewer({
  container: '#canvas',
  additionalModules: [ TokenAnimationModule ],
  tokenAnimation: { maxVisible: 5, duration: 600 }
});
```

### Keeping up with fast events

Every transition takes a **fixed duration**, independent of flow length (default
1000 ms; set globally via `tokenAnimation: { duration }` config or
`tokens.setDuration(ms)` at runtime — `0` makes transitions instant). If transitions are
driven by external events that can arrive faster than a token animates:

- **No pile-up** — a token's logical position updates the instant you call
  `sendToken` (so it's addressable at the destination immediately), and a new
  `sendToken` auto-finishes any still-running transition first. Rapid sends never
  overlap; the animation is cosmetic catch-up.
- **Shorten transitions** — lower the global duration with `setDuration(ms)` (or
  the `tokenAnimation: { duration }` config); `0` makes transitions instant.

## License

MIT
