# AnimationAPI (`animation` service)

The low-level visual primitive: place a colored dot (a **token**) on a node, move it along a
flow, set its resting position, stack a node into instances. No BPMN semantics are baked in —
*you* map your meaning onto positions. The high-level [`simulation`](simulation-api.md) service
is built on top of this; use `animation` directly when you want full control.

```javascript
const animation = viewer.get('animation');
```

## Token identity & color

- A token is identified by **`(node, label, sequenceFlow?, stackIndices?)`**. `node` is a BPMN
  element id; `label` is any string you choose (an instance id, an order number, …);
  `sequenceFlow` is set only when the token **rests on a flow**; `stackIndices` ties it to a
  particular [instance](#instance-stacks) of a stacked node.
- Placing a token at an existing identity **replaces** it. At most one token per identity rests
  at an **anchor**; tokens resting on **distinct flows** can **coexist** at one node — that's how
  branches pile up at a merging gateway. Move them to a shared anchor (or remove the extras) to
  **merge**.
- **`color` is required** and may be **any CSS color** — name (`tomato`), hex (`#3399ff`),
  `rgb()`/`hsl()`. Applied directly, no parsing; a token carries its color, so a move keeps it.

### Colors

Two named exports mint colors — both wrap [`randomcolor`](https://github.com/davidmerfield/randomColor),
the **same scheme as bpmn-js-token-simulation**. The package never assigns colors itself; you mint
one per identity and pass it in.

```javascript
import AnimationModule, { getRandomColor, getDistinctColor } from 'bpmn-js-animation';

const a = getRandomColor();        // one random color, e.g. "#3b82c4"
const b = getDistinctColor(0);     // the 0th of a fixed, contrast-filtered palette (cycles)
const c = getDistinctColor(1);     // visually distinct from b
```

`getDistinctColor(index)` cycles a fixed palette of 60 contrast-filtered colors — successive
indices stay well-separated, so concurrent instances read distinctly. Reuse one color across an
instance's tokens (a **child** should inherit its parent's color). Pass `{ seed }` to pin the
palette in tests.

## Token state — position, animate & hidden

A token's `state` is a **pure visual descriptor**:

```
state = {
  position: { left, top, hoffset, voffset } | null,   // a point on/around the shape
  sequenceFlow: '<connected sequence flow id>' | null, // rest where that flow meets the node
  animate: '<effect name>' | null,                     // a motion cue (-> .bts-anim-<name>)
  hidden: boolean                                      // park the dot (kept in the model, CSS display:none)
}
```

- `position.left` / `position.top` are **fractions** of the shape (`0` = left/top edge, `1` =
  right/bottom; may go outside, e.g. `top: -0.1` sits above); default `0.5` (center).
  `position.hoffset` / `position.voffset` add a **pixel** nudge on top (default `0`). So a point
  is a proportional anchor plus a constant offset — `x = left*w + hoffset`. Mix freely:
  `{ left: 1, hoffset: -10 }` is 10px inside the right edge.
- `position` and `sequenceFlow` are **mutually exclusive**; `animate` and `hidden` are independent.
- **`animate`** names a motion-cue effect (or `null`/absent = still), rendered as a class
  `.bts-anim-<name>` on the dot. Six built-ins ship — `bounce`, `pulse`, `flip`, each with a
  continuous variant and a `-pause` variant (plays once quickly, then holds still before repeating):
  `bounce` / `bounce-pause` / `pulse` / `pulse-pause` / `flip` / `flip-pause`. It's an **open set** —
  add `.bts-anim-myeffect { animation: … }` in your own CSS to define more, with no library change.
- `hidden: true` keeps the token in the model (`getTokens` still returns it, it stays in its cluster)
  but CSS-hides the dot — for "parked" tokens like an MI activity's outer thread while its instances run.
- Default (when omitted): `{ position: { left: 0.5, top: 0.5 } }` — centered, still.
- Tokens that resolve to the **same point queue** at that spot. None of the lifecycle meaning is
  hard-coded — a typical caller convention for an activity is arrived → `{ left: 0, top: 0 }`,
  entered → `{ left: 0.5, top: 0.5 }`, completed → `{ left: 1, top: 1 }`.

## API

| Method | Description |
| --- | --- |
| `createToken(node, label, color, state?, stackIndices?)` | Place a token (replaces one at the same identity). `state` defaults to centered, bouncing. `stackIndices` (a map `{ stackedNodeId: key }`) sets which [instance](#instance-stacks) it belongs to — omit unless the node or an ancestor is stacked. Returns the token. |
| `sendToken([{ node, label, sequenceFlow, stackIndices? }, …])` | Travel token(s) **already resting on a flow** along that flow to its far node, leaving them resting on the **same flow** there (no landing `state` — anchor afterwards with `setState`). `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). A **split** is the host's job (create a token on each flow). Resolves `Promise<Token[]>`; auto-settles an in-flight source; rejects if it isn't on the flow or several share it. |
| `setState(node, label, state, selector?)` | Update state in place (partial merge). `selector` = `{ sequenceFlow?, stackIndices? }` picks which token when several rest at the node. Rekeys (merging) when it changes the rest flow/position — that's how a join completes; when the rest point moves it **glides** the dot to the new point. |
| `removeToken(node, label, selector?)` | Remove a token, cancelling any in-flight animation. |
| `selectToken(node, label, selector?)` / `deselectToken(…)` | Toggle a blue ring on a resting token. Selection is **carried**: it survives a move and OR-merges on a join. |
| `getSelectedTokens()` | The selected tokens (`Token[]`). |
| `setNodeSelected(node, selected?)` / `getSelectedNodes()` | Draw a modeller-style blue boundary on an element (stack-aware); list selected node ids. |
| `throwIcon(node)` / `catchIcon(node)` | Play the element's own **icon** as a **throw** (fly up-right, fade out) / **catch** (fly in from up-left, fade in). Native color, shared duration. `→ Promise`; no-op if the element has no icon. The direction is your choice — the library reads no BPMN semantics. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color, state, selected, stackIndices }`), in insertion order. |
| `clear()` | Remove all tokens. |
| `setAnimationDuration(ms)` / `getAnimationDuration()` | Global animation duration — token moves **and** `throwIcon`/`catchIcon`. `0` makes transitions instant. |

### Events (on the bpmn-js `eventBus`)

- `token.click` — `{ node, label, sequenceFlow, stackIndices }` (`stackIndices` is the clicked
  **instance** — pass it back as the selector to address that token, since a stacked node shows
  only its front instance).
- `token.overflow.click` — `{ node, hidden }` (the `+N` marker; `hidden` lists the
  `{ node, label, stackIndices }` not shown).

### Crowded nodes

At most **`maxVisible`** dots (default **3**) render at one spot on a node; beyond that, a single
neutral **`+N`** marker is shown (clicking it fires `token.overflow.click`). Configure via module
config:

```javascript
new BpmnViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ],
  animation: { maxVisible: 5, animationDuration: 600 }
});
```

### Keeping up with fast events

Every transition takes a **fixed duration** (default 1000 ms), independent of flow length. A
token's logical position updates the instant you call `sendToken` (addressable at the destination
immediately), and a new `sendToken` auto-finishes any still-running transition first — so rapid
sends never overlap; the animation is cosmetic catch-up. Lower the duration with
`setAnimationDuration(ms)` (`0` = instant) when events arrive faster than a token animates.

## Instance stacks

Render a node as a **stack of its own shape** (multiple instances) and scroll through them.
Visualization only — the host drives sizes and contents; the library never infers a stack from
tokens. **Instances are identified by stable keys** (e.g. instance labels) — removing one never
disturbs the others.

| Method | Description |
| --- | --- |
| `setStacks(node, keys, ancestorStackIndices?)` | Set `node`'s **ordered instance keys** (front first). Count = `keys.length`. The first instance is drawn by whatever already represents the node (its own shape, or the implicit process box); the rest render as diagonally-offset copies, with a plain **`+k`** beyond the drawn cap. `ancestorStackIndices` (a map `{ stackedAncestorId: key }`) sets the keys *for a given outer instance* — **contexts are independent**. Omit it to target the instance **currently on screen**; pass `{}` for the base context explicitly. |
| `getStacks(node)` → `key[]` | The node's ordered keys (count = `.length`) for the on-screen context. |
| `getCurrentStack(node)` → `key` | The current **front-instance** key. |
| `getCurrentStacks(node)` → `{ id: key }` | The `stackIndices` a token resting at `node` must carry to belong to the instance **currently on screen** (`node`'s own front key when stacked, plus each stacked ancestor's). Pass it to `createToken`/`sendToken`, or inside a selector, so an action targets the visible instance. `{}` when nothing in the chain is stacked. |
| `moveToFront(node, key)` / `moveToBack(node, key)` | Reorder the node's instances **and animate** the swap (a copy arcs over the stack). Both `→ Promise`. The order + render update synchronously (a sync `getCurrentStack` read sees the new front); the arc is cosmetic. Animate only when the shown front changes — `moveToBack` of a non-front key reorders instantly. No-op when not stacked or `key` is already front. |
| `scrollStack(node, direction?)` | Step to the next (`'forward'`) / previous (`'backward'`) instance — thin sugar over `moveTo*`. `→ Promise`. |
| `getProcessBox()` | Id of the box drawn around an implicit (pool-less) `bpmn:Process` while it's stacked, else `null`. |
| `getMaxVisible()` | The per-node drawn cap (default 3, via `animation: { maxVisible }`). |

> **Count-based convenience.** A node's instances are keyed by *any* stable key. If you'd rather
> address instances by a numeric count/index (`setStackSize(node, n)`, `setStackIndex(node, i)`),
> build those over the key-based API — `setStacks(node, [0, 1, …, n-1])`,
> `moveToFront(node, getStacks(node)[i])`. The example (`example/app.js`) and test helper
> (`test/TestHelper.js`) ship exactly such shims; they're intentionally **not** part of the
> service.

**Per-instance tokens.** A token records which instance it belongs to via `stackIndices`, so a
stacked node shows exactly its current front instance's tokens. You declare the instances up
front and the library resolves what to show against the current front keys — no callback:

```javascript
animation.setStacks('SubProcess_1', [ 'a', 'b', 'c' ]);  // three instances, 'a' in front

// each instance's tokens, tagged with the instance key
animation.createToken('SubTask_1', 'order-42', color, state, { SubProcess_1: 'a' });
animation.createToken('SubTask_1', 'order-77', color, state, { SubProcess_1: 'b' });

await animation.moveToFront('SubProcess_1', 'b'); // now shows instance 'b' (animated)
```

A token's instance membership is **fixed** (a move keeps it); only the node's display order
changes when you scroll / reorder. `stackIndices` need only list the stacked nodes in the token's
own/ancestor chain; an omitted stacked entry means the base instance.

**Nested stacks.** A token deep inside lists every stacked ancestor, e.g.
`{ Process_1: 'i2', MI_Activity: 'm1' }`. Nested stack *contents* that differ per outer instance
are declared with the context argument, e.g. `setStacks('MI_Activity', [...], { Process_1: 'i2' })`,
and resolve automatically as you scroll the outer stack.

### Implicit process box

A bare `bpmn:Process` with no pool has no shape of its own, so the box *is* its first instance.
`setStacks(processId, keys)` (with one or more keys) draws a **pool-style box** (outer rect + left
banner with the process name) around its flow nodes — at one key just the box, at more keys the box
plus offset copies — and clearing the keys removes it. `getProcessBox()` returns its id. The box
behaves like a sub-process — it carries tokens at the process and tokens in its scope, and supports
selection.
