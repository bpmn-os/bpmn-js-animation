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
| `createToken(node, label, color, state?, stackIndices?)` | Place a token (replaces one at the same identity). `state` defaults to bottom-left, bouncing. `stackIndices` (a map `{ stackedNodeId: index }`) sets which instance it belongs to — omit unless the node or an ancestor is stacked. Returns the token. |
| `sendToken([{ node, label, sequenceFlow, state?, stackIndices? }, …])` | Animate token(s) along flow(s) and land in `state`. Same-source entries = **split**; `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). A move keeps the token's instance (`stackIndices`). Resolves `Promise<Token[]>` when landed; auto-settles an in-flight source; rejects if a source is ambiguous. |
| `setState(node, label, state, selector?)` | Update state in place (partial merge). `selector` = `{ sequenceFlow?, stackIndices? }` picks which token when several rest at the node. |
| `removeToken(node, label, selector?)` | Remove a token, cancelling any in-flight animation. |
| `selectToken(node, label, selector?)` / `deselectToken(…)` | Toggle a blue ring on a resting token. Selection is **carried**: it survives a move, is copied to each split branch, and OR-merges on a join. |
| `getSelectedTokens()` | The selected tokens (`Token[]`). |
| `setNodeSelected(node, selected?)` / `getSelectedNodes()` | Draw a modeller-style blue boundary on an element (stack-aware); list selected node ids. |
| `throwIcon(node)` | Play the element's own **icon** (event/task-type icon) as a **throw**: fly it diagonally up-right and fade out. Native color, shared duration. `→ Promise`; no-op if the element has no icon. |
| `catchIcon(node)` | Play the element's own **icon** as a **catch**: draw it in from up-left and fade in. Counterpart to `throwIcon`. `→ Promise`; no-op if no icon. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color, state, selected, stackIndices }`), in insertion order. |
| `setFilter(predicate \| null)` | Visibility filter: tokens where `predicate(token)` is falsy are **hidden** (kept, not removed — `getTokens` still returns them; they don't count toward the `+N` cap). `null` shows all. |
| `clear()` | Remove all tokens. |
| `setAnimationDuration(ms)` | Global animation duration — token moves **and** `throwIcon`/`catchIcon` (see below). |

### Events (on the bpmn-js `eventBus`)

- `token.click` — `{ node, label, sequenceFlow, stackIndices }` (`stackIndices` is the
  clicked **instance** — pass it back as the selector to address that token, since a
  stacked node shows only its front instance)
- `token.overflow.click` — `{ node, hidden }` (the `+N` marker; `hidden` is the
  list of `{ node, label, stackIndices }` not shown)

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
| `setStackSize(node, size, ancestorStackIndices?)` | Declare `node`'s **instance count** (`size`). The first instance is drawn by whatever already represents the node — its own shape, or the implicit process's box (T4) — and the additional `size - 1` instances render as diagonally-offset copies, so **size 1 is a single instance with no copies** and `0`/`null` clears it (for the process, removes the box). A plain **`+k`** marks instances beyond the drawn cap. `ancestorStackIndices` (a map `{ stackedAncestorId: index }`) declares the count *for a given outer instance*, so a nested activity can differ per outer instance — **contexts are independent** (a count set under one outer instance never leaks to another). Omit it to target the instance **currently on screen**; pass `{}` for the base/flat context explicitly. |
| `getStackSize(node)` / `getMaxVisible()` | The stack size for the instance on screen (resolved against the current context); the per-node drawn cap (default 3, via `animation: { maxVisible }`). |
| `getStackIndex(node)` | The current front-instance index (0-based). |
| `getStackIndices(node)` | The `stackIndices` a token resting at `node` must carry to belong to the instance **currently on screen** (`node`'s own front index when stacked, plus each stacked ancestor's). Pass it to `createToken`/`sendToken`, or inside a selector, so an action targets the visible instance instead of the base. `{}` when nothing in the chain is stacked. |
| `setStackIndex(node, index)` / `moveToFront(node, instanceIndex)` / `moveToBack(node, instanceIndex)` | Reorder the node's instances (no animation): jump an instance to the front, or send it to the back. |
| `scrollStack(node, direction?)` | Animate stepping to the next (`'forward'`) / previous (`'backward'`) instance, at a fixed UI speed. **No callback.** `→ Promise`. |
| `getProcessBox()` | Id of the box drawn around an implicit (pool-less) `bpmn:Process` while it's stacked, else `null`. |

**Per-instance tokens.** A token records which instance it belongs to via `stackIndices`, so
a stacked node shows exactly its current front instance's tokens. You declare the
instances up front and the library resolves what to show against the current front indices —
there is no callback:

```javascript
animation.setStackSize('SubProcess_1', 3);

// each instance's tokens, tagged with the instance index
animation.createToken('SubTask_1', 'order-42', color, state, { SubProcess_1: 0 });
animation.createToken('SubTask_1', 'order-77', color, state, { SubProcess_1: 1 });

await animation.scrollStack('SubProcess_1', 'forward'); // now shows instance 1's tokens
```

A token's instance membership is fixed (a move keeps it); only the node's display order
changes when you scroll / reorder. `stackIndices` need only list the stacked nodes in the
token's own/ancestor chain (omit it entirely when nothing is stacked; an omitted stacked
entry means instance 0 — which is also the base/default context).

You may, however, pass a **complete** ancestor map if that's simpler — entries with index
`0` (or `null`) are normalized away, so listing every ancestor with its current index and
using `0`/`null` for the non-stacked ones yields exactly the same identity as the minimal
form (and stays addressable by either). The only rule: never give a non-stacked ancestor a
**positive** index — a node with no stack genuinely has no instance above `0` (its
`getStackIndex` is `0`), so populating each ancestor with its real current index is always
correct and needs no stackability check on your side.

**Nested stacks.** A token deep inside lists every stacked ancestor, e.g.
`{ Process_1: 2, MI_Activity: 1 }`. Nested stack *sizes* that differ per outer instance are
declared with the context argument, e.g. `setStackSize('MI_Activity', 3, { Process_1: 1 })`,
and resolve automatically as you scroll the outer stack.

**Implicit process box.** A bare `bpmn:Process` with no pool has no shape of its own, so
the box *is* its first instance. `setStackSize(processId, n >= 1)` draws a **pool-style
box** (outer rect + left banner with the process name) around its flow nodes — at `n = 1`
just the box, at `n > 1` the box plus `n - 1` offset copies — and `setStackSize(processId,
0)` (or `null`) removes it. `getProcessBox()` returns its id. The box behaves like a
sub-process — it carries tokens at the process and tokens in its scope, and supports
selection.

## License

MIT
