# bpmn-js-animation

API-driven animation for [bpmn-js](https://github.com/bpmn-io/bpmn-js).

> The token animation (`lib/Animation.js`) is vendored and
> adapted from [bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation)
> (MIT). Everything else is new.

## Install

```sh
npm install bpmn-js-animation
```

## Usage

```javascript
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import AnimationModule from 'bpmn-js-animation';

import 'bpmn-js-animation/assets/token-animation.css';

const viewer = new BpmnViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ]
});

await viewer.importXML(diagramXML);

const animation = viewer.get('animation');

// create a token (a colored dot resting on a node)
animation.createToken('StartEvent_1', 'order-42', 'tomato');

// move it along a sequence flow (animates, then rests at the flow's target)
await animation.sendToken([ { node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' } ]);

// split at a diverging gateway — same source, several flows; one copy per flow
await animation.sendToken([
  { node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_3' },
  { node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_4' }
]);

// advance its lifecycle in place — position + bounce are your call (see below)
animation.setState('Task_1', 'order-42', { position: 'center-middle' });  // "entered"
animation.setState('Task_1', 'order-42', { bounce: true });               // needs user action

// react to clicks — the host app decides what to show
viewer.get('eventBus').on('token.click', ({ node, label, sequenceFlow }) => {
  console.log('clicked token', label, 'at', node, sequenceFlow ? `(on ${sequenceFlow})` : '');
});

// remove it
animation.removeToken('Task_1', 'order-42');
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
  import AnimationModule, { getRandomColor } from 'bpmn-js-animation';
  const color = getRandomColor();   // e.g. "hsl(207, 65%, 45%)"
  ```
- Tokens carry **no other data** — just `color` + `state`. The `label` shows on
  **hover**; the dot is a plain colored circle.

## Token state — position & bounce

A token's `state` is a **pure visual descriptor**; the library has no built-in
lifecycle semantics — *you* map your meaning onto positions.

```
state = {
  position: '{top|center|bottom}-{left|middle|right}' | null,  // a 3×3 anchor on/around the node
  sequenceFlow: '<connected sequence flow id>'         | null,  // rest where that flow meets the node
  bounce: boolean                                               // a "user action needed" cue
}
```
- `position` and `sequenceFlow` are **mutually exclusive**; `bounce` is independent.
- Default (when omitted): `{ position: 'bottom-left', bounce: true }` — the familiar
  bottom-left bouncing token.
- A typical **caller convention** for an activity: arrived → `top-left`, entered →
  `center-middle`, completed → `bottom-right`; for events/gateways the icon is
  centered, so use `center-right`; for a gateway *arrived*, rest on the incoming
  flow via `{ sequenceFlow: '<incoming flow id>' }`. None of this is hard-coded.

## `animation` API

| Method | Description |
| --- | --- |
| `createToken(node, label, color, state?)` | Place a token (replaces one at the same identity). `state` defaults to bottom-left, bouncing. Returns the token. |
| `sendToken([{ node, label, sequenceFlow, state? }, …])` | Animate token(s) along flow(s) and land in `state`. Same-source entries = **split**; `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). Resolves `Promise<Token[]>` when landed; auto-settles an in-flight source first; rejects if a source `(node, label)` is ambiguous. |
| `setState(node, label, state, sequenceFlow?)` | Update state in place (partial merge — toggle `bounce` without moving, etc.). Trailing `sequenceFlow` selects which token when several rest at the node. |
| `removeToken(node, label, sequenceFlow?)` | Remove a token, cancelling any in-flight animation. |
| `selectToken(node, label, sequenceFlow?)` / `deselectToken(…)` | Toggle a blue ring on a resting token. Selection is **carried**: it survives a move, is copied to each split branch, and OR-merges on a join. |
| `getSelectedTokens()` | The selected tokens (`Token[]`). |
| `moveToFront(token)` / `moveToBack(token)` | Reorder a token in the **global draw order** (pass the token object from `createToken`/`getTokens`). Front = first drawn at its node, and the token a stacked node shows on top. Stale reference → no-op. |
| `setNodeSelected(node, selected?)` / `getSelectedNodes()` | Draw a modeller-style blue boundary on an element (stack-aware); list selected node ids. |
| `throwIcon(node)` | Play the element's own **icon** (event/task-type icon) as a **throw**: fly it diagonally up-right and fade out. Native color, shared duration. `→ Promise`; no-op if the element has no icon. |
| `catchIcon(node)` | Play the element's own **icon** as a **catch**: draw it in from up-left and fade in. Counterpart to `throwIcon`. `→ Promise`; no-op if no icon. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color, state }`). |
| `setFilter(predicate \| null)` | Visibility filter: tokens where `predicate(token)` is falsy are **hidden** (kept, not removed — `getTokens` still returns them; they don't count toward the `+N` cap). `null` shows all. |
| `clear()` | Remove all tokens. |
| `setAnimationDuration(ms)` | Global animation duration — token moves **and** `throwIcon`/`catchIcon` (see below). |

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
  additionalModules: [ AnimationModule ],
  animation: { maxVisible: 5, animationDuration: 600 }
});
```

### Keeping up with fast events

Every transition takes a **fixed duration**, independent of flow length (default
1000 ms; set globally via `animation: { animationDuration }` config or
`animation.setAnimationDuration(ms)` at runtime — `0` makes transitions instant). If
transitions are driven by external events that can arrive faster than a token animates:

- **No pile-up** — a token's logical position updates the instant you call
  `sendToken` (so it's addressable at the destination immediately), and a new
  `sendToken` auto-finishes any still-running transition first. Rapid sends never
  overlap; the animation is cosmetic catch-up.
- **Shorten transitions** — lower the global duration with `setAnimationDuration(ms)`
  (or the `animation: { animationDuration }` config); `0` makes them instant.

## Instance stacks

Render a node as a **stack of its own shape** (multiple instances) and scroll through
them. Visualization only — the host drives sizes and contents; the library never infers
a stack from tokens.

| Method | Description |
| --- | --- |
| `setStackSize(node, size)` | Render `node` as a diagonally-offset stack of `size` copies of its own shape (`size <= 1` removes it). A plain **`+k`** marks instances beyond the drawn cap. |
| `getStackSize(node)` / `getMaxVisible()` | The stack size; the per-node drawn cap (default 3, configurable via `animation: { maxVisible }`). |
| `getStackIndex(node)` / `setStackIndex(node, index, getInstance?)` | The current front-instance index (0-based, wraps); set/seed it (loads that instance via `getInstance`, no animation). |
| `scrollStack(node, direction?, getInstance?)` | Animate stepping to the next (`'forward'`) / previous (`'backward'`) instance, at a fixed UI speed. `→ Promise`. |
| `getProcessBox()` | Id of the box drawn around an implicit (pool-less) `bpmn:Process` while it's stacked, else `null`. |

**Tokens on a stack.** A stacked node shows only its **top** token (first by global order —
use `moveToFront` / `moveToBack` to choose which). On scroll, that token rides the
transition and steps to the next instance's.

**Instance content (`getInstance`).** Scrolling a *container* (sub-process, event
sub-process, or a pool-less process) is a UI gesture, so the library owns the index and
**pulls** the incoming instance from a host callback:

```javascript
animation.setStackSize('SubProcess_1', 5);
animation.setStackIndex('SubProcess_1', 0, getInstance);          // seed instance 0
await animation.scrollStack('SubProcess_1', 'forward', getInstance);

function getInstance(node, indices) {
  // indices = { stackNodeId: index } for every stacked node up the ancestor chain
  // (node at its new index). Return what the instance shows:
  return {
    tokens: [ { node: 'SubTask_1', label: 'order-42' } ],          // refs to existing tokens
    stacks: [ { node: 'SubTask_2', stackSize: 3, stackIndex: 0 } ] // nested stack sizes/indices
  };
}
```

All instances' scope tokens live in the model at once (created once, with their own
color/state); `getInstance` returns **references** `{ node, label }` to the ones shown for
the active instance, and the library toggles visibility — nothing is recreated and
color/state never change on a scroll.

**Implicit process box.** A bare `bpmn:Process` with no pool has no shape to stack.
`setStackSize(processId, n > 1)` draws a **pool-style box** (outer rect + left banner with
the process name) around its flow nodes and stacks that; `setStackSize(processId, 1)`
removes it. `getProcessBox()` returns its id. The box behaves like a sub-process — it
carries tokens at the process and tokens in its scope, and supports selection.

## License

MIT
