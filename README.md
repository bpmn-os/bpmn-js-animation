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
await tokens.sendToken([ { node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' } ]);

// split at a diverging gateway — same source, several flows; one copy per flow
await tokens.sendToken([
  { node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_3' },
  { node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_4' }
]);

// advance its lifecycle in place — position + bounce are your call (see below)
tokens.setState('Task_1', 'order-42', { position: 'center-middle' });  // "entered"
tokens.setState('Task_1', 'order-42', { bounce: true });               // needs user action

// react to clicks — the host app decides what to show
viewer.get('eventBus').on('token.click', ({ node, label, sequenceFlow }) => {
  console.log('clicked token', label, 'at', node, sequenceFlow ? `(on ${sequenceFlow})` : '');
});

// remove it
tokens.removeToken('Task_1', 'order-42');
```

## Token identity & color

- A token is identified by **`(node, label, sequenceFlow?)`**. `node` is a BPMN
  element id; `label` is any string you choose (an instance id, an order number, …);
  `sequenceFlow` is set only when the token **rests on a flow** (see state, below).
- Placing a token at an existing identity **replaces** it. At most one token per
  `(node, label)` rests at an **anchor**; tokens resting on **distinct flows** can
  **coexist** at one node — that's how branches pile up at a merging gateway. Move
  them to a shared anchor (or remove the extras) to **merge**.
- **`color` is required** and may be **any CSS color** — name (`tomato`), hex
  (`#3399ff`), `rgb()/rgba()`, `hsl()/hsla()`. Applied directly, no parsing; a token
  carries its color, so `sendToken` keeps it and split copies inherit it.
- Need a color? Use the **`getRandomColor()`** named export: mint one per identity
  and reuse it so related tokens stay consistent. The package never assigns colors.

  ```javascript
  import TokenAnimationModule, { getRandomColor } from 'bpmn-js-token-animation';
  const color = getRandomColor();   // e.g. "hsl(207, 65%, 45%)"
  ```
- Tokens carry **no other data** — just `color` + `state`. The `label` shows on
  **hover**; the dot is a plain colored circle.

## Token state — position & bounce

A token's `state` is a **pure visual descriptor**; the library has no built-in
lifecycle semantics — *you* map your meaning onto positions.

```
state = {
  position: '{above|center|below}-{left|middle|right}' | null,  // a 3×3 anchor on/around the node
  sequenceFlow: '<connected sequence flow id>'         | null,  // rest where that flow meets the node
  bounce: boolean                                               // a "user action needed" cue
}
```
- `position` and `sequenceFlow` are **mutually exclusive**; `bounce` is independent.
- Default (when omitted): `{ position: 'below-left', bounce: true }` — the familiar
  bottom-left bouncing token.
- A typical **caller convention** for an activity: arrived → `above-left`, entered →
  `center-middle`, completed → `below-right`; for events/gateways the symbol is
  centered, so use `center-right`; for a gateway *arrived*, rest on the incoming
  flow via `{ sequenceFlow: '<incoming flow id>' }`. None of this is hard-coded.

## `tokens` API

| Method | Description |
| --- | --- |
| `createToken(node, label, color, state?)` | Place a token (replaces one at the same identity). `state` defaults to below-left, bouncing. Returns the token. |
| `sendToken([{ node, label, sequenceFlow, state? }, …])` | Animate token(s) along flow(s) and land in `state`. Same-source entries = **split**; `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). Resolves `Promise<Token[]>` when landed; auto-settles an in-flight source first; rejects if a source `(node, label)` is ambiguous. |
| `setState(node, label, state, sequenceFlow?)` | Update state in place (partial merge — toggle `bounce` without moving, etc.). Trailing `sequenceFlow` selects which token when several rest at the node. |
| `removeToken(node, label, sequenceFlow?)` | Remove a token, cancelling any in-flight animation. |
| `animateSymbol(node)` | Play the element's own **symbol**: throw/end events + **send** tasks fly it diagonally up-right and fade out; everything else with a symbol (catch/start/boundary events, **receive** + other typed tasks like user/service/script) draws it in from up-left and fades in. Native color, shared duration. `→ Promise`; no-op if the element has no symbol. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color, state }`). |
| `clear()` | Remove all tokens. |
| `setAnimationDuration(ms)` | Global animation duration — token moves **and** `animateSymbol` (see below). |

### Events (on the bpmn-js `eventBus`)

- `token.click` — `{ node, label, sequenceFlow }`
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
  tokenAnimation: { maxVisible: 5, animationDuration: 600 }
});
```

### Keeping up with fast events

Every transition takes a **fixed duration**, independent of flow length (default
1000 ms; set globally via `tokenAnimation: { animationDuration }` config or
`tokens.setAnimationDuration(ms)` at runtime — `0` makes transitions instant). If
transitions are driven by external events that can arrive faster than a token animates:

- **No pile-up** — a token's logical position updates the instant you call
  `sendToken` (so it's addressable at the destination immediately), and a new
  `sendToken` auto-finishes any still-running transition first. Rapid sends never
  overlap; the animation is cosmetic catch-up.
- **Shorten transitions** — lower the global duration with `setAnimationDuration(ms)`
  (or the `tokenAnimation: { animationDuration }` config); `0` makes them instant.

## License

MIT
