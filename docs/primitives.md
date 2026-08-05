# Primitives (`primitives` service)

The low-level visual primitive: place a colored dot (a **token**) on a node, move it along a flow, set its resting position, stack a node into instances. No BPMN semantics are baked in — *you* map your meaning onto positions. The high-level [`animation`](animation.md) service is built on top of this; use `primitives` directly when you want full control.

```javascript
const animation = viewer.get('primitives');
```

## Token identity & color

- A token is identified by **`(node, label, sequenceFlow?, stackIndices?)`**. `node` is a BPMN element id; `label` is any string you choose (an instance id, an order number, …); `sequenceFlow` is set only when the token **rests on a flow**; `stackIndices` ties it to a particular [instance](#instance-stacks) of a stacked node.
- Placing a token at an existing identity **replaces** it. At most one token per identity rests at an **anchor**; tokens resting on **distinct flows** can **coexist** at one node — that's how branches pile up at a merging gateway. Move them to a shared anchor (or remove the extras) to **merge**.
- **`color` is required** and may be **any CSS color** — name (`tomato`), hex (`#3399ff`), `rgb()`/`hsl()`. Applied directly, no parsing; a token carries its color, so a move keeps it.

### Colors

Two named exports mint colors — both wrap [`randomcolor`](https://github.com/davidmerfield/randomColor), the **same scheme as bpmn-js-token-simulation**. The package never assigns colors itself; you mint one per identity and pass it in.

```javascript
import { AnimationModule, getRandomColor, getDistinctColor } from 'bpmn-js-animation';

const a = getRandomColor();        // one random color, e.g. "#3b82c4"
const b = getDistinctColor(0);     // the 0th of a fixed, contrast-filtered palette (cycles)
const c = getDistinctColor(1);     // visually distinct from b
```

`getDistinctColor(index)` cycles a fixed palette of 60 contrast-filtered colors — successive indices stay well-separated, so concurrent instances read distinctly. Reuse one color across an instance's tokens (a **child** should inherit its parent's color). Pass `{ seed }` to pin the palette in tests.

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

- `position.left` / `position.top` are **fractions** of the shape (`0` = left/top edge, `1` = right/bottom; may go outside, e.g. `top: -0.1` sits above); default `0.5` (center). `position.hoffset` / `position.voffset` add a **pixel** nudge on top (default `0`). So a point is a proportional anchor plus a constant offset — `x = left*w + hoffset`. Mix freely: `{ left: 1, hoffset: -10 }` is 10px inside the right edge.
- `position` and `sequenceFlow` are **mutually exclusive**; `animate` and `hidden` are independent.
- **`animate`** names a motion-cue effect (or `null`/absent = still), rendered as a class `.bts-anim-<name>` on the dot. Six built-ins ship — `bounce`, `pulse`, `flip`, each with a continuous variant and a `-pause` variant (plays once quickly, then holds still before repeating): `bounce` / `bounce-pause` / `pulse` / `pulse-pause` / `flip` / `flip-pause`. It's an **open set** — add `.bts-anim-myeffect { animation: … }` in your own CSS to define more, with no library change.
- `hidden: true` keeps the token in the model (`getTokens` still returns it, it stays in its cluster) but CSS-hides the dot — for "parked" tokens like an MI activity's outer thread while its instances run.
- Default (when omitted): `{ position: { left: 0.5, top: 0.5 } }` — centered, still.
- Tokens that resolve to the **same point queue** at that spot. None of the lifecycle meaning is hard-coded — a typical caller convention for an activity is arrived → `{ left: 0, top: 0 }`, entered → `{ left: 0.5, top: 0.5 }`, completed → `{ left: 1, top: 1 }`.

## API

| Method | Description |
| --- | --- |
| `createToken(node, label, color, state?, stackIndices?)` | Place a token (replaces one at the same identity). `state` defaults to centered, still. `stackIndices` (a map `{ stackedNodeId: key }`) sets which [instance](#instance-stacks) it belongs to — omit unless the node or an ancestor is stacked. Returns the token. |
| `sendToken([{ node, label, sequenceFlow, stackIndices? }, …])` | Travel token(s) **already resting on a flow** along that flow to its far node, leaving them resting on the **same flow** there (no landing `state` — anchor afterwards with `setState`). `sequenceFlow` may be **outgoing** (forward → target) or **incoming** (reverse → source, e.g. rewind). A **split** is the host's job (create a token on each flow). Resolves `Promise<Token[]>`; auto-settles an in-flight source; rejects if it isn't on the flow or several share it. |
| `setState(node, label, state, selector?)` | Update state in place (partial merge). `selector` = `{ sequenceFlow?, stackIndices? }` picks which token when several rest at the node. Rekeys (merging) when it changes the rest flow/position — that's how a join completes; when the rest point moves it **glides** the dot to the new point. Synchronous (returns the token). |
| `glideToState(node, label, state, selector?, via?)` | Awaitable `setState`: resolves once the dot is at rest — after the glide when one runs (`animationDuration > 0` and the rest point moved), or immediately otherwise. Pass `via` (an array of intermediate `position` points) to glide **through** them in one continuous motion before resting at `state` (the model commits to `state` only; `via` points are visual waypoints). Use it to sequence several rest-point changes so the dot visibly travels through each. `→ Promise<Token>`. |
| `removeToken(node, label, selector?, gesture?)` | Remove a token, cancelling any in-flight animation. The model drops **synchronously**; pass `gesture` (an array of one-shot effect names, e.g. `['flip','fade-out']`) to flip-fade the dot out on a **detached "ghost" clone** that plays out and self-removes independently — so removal never blocks and the gesture survives concurrent re-renders. |
| `selectToken(node, label, selector?)` / `deselectToken(…)` | Toggle a blue ring on a resting token. Selection is **carried**: it survives a move and OR-merges on a join. |
| `getSelectedTokens()` | The selected tokens (`Token[]`). |
| `setNodeSelected(node, selected?)` / `getSelectedNodes()` | Draw a modeller-style blue boundary on an element (stack-aware); list selected node ids. |
| `setFlowDimmed(flowId, on?)` | Dim / undim a **sequence flow** — a `.bts-dim` class drops its line + arrowhead to semi-transparent (and reverts cleanly, leaving the flow's own colours untouched). Used to fade a diverging gateway's unchosen outflows. `clear` undims any left dimmed. |
| `setNodeDimmed(nodeId, on?)` | Dim / undim a **node** — the same `.bts-dim` mechanism as `setFlowDimmed`, on a flow node's shape. Used to fade the candidate **link catch** events of an ambiguous link throw while the user picks the jump target. `clear` undims any left dimmed. |
| `throwIcon(node, label, selector?)` / `catchIcon(node, label, selector?)` | Play the element's own **icon**, emitted **from / into the token** `(node, label, selector)` — the icon starts centered on the token's dot and flies out up-right + fades out (**throw**), or flies in from up-left + fades in to land on the dot (**catch**). Native color, shared duration. `→ Promise`; no-op if no token rests there or the element has no icon. Direction is your choice — the library reads no BPMN semantics. |
| `playTokenEffect(node, label, effect, selector?)` | Play a **one-shot** CSS effect on the resting token's dot — e.g. `'flip'` (a single flip) or `'fade-out'` — applied as a `.bts-once-<effect>` class for one `animationDuration`, then stripped. Unlike `state.animate` (a persistent, **looping** cue), this is a transient gesture you **sequence** in front of a depart/consume, e.g. `playTokenEffect(n, l, 'fade-out').then(() => removeToken(n, l))`. `→ Promise`; no-op if the token isn't drawn (parked/`hidden`, or behind a `+N` marker). |
| `playTokenEffects(node, label, effects, selector?)` | Like `playTokenEffect` but plays a **sequence** of one-shot effects on the resting dot, in order — e.g. `['fade-in','flip']` as a token's **entrance** (the reverse of a `['flip','fade-out']` consume). `→ Promise`; no-op when there are no effects or the token isn't drawn. |
| `drillTo(node)` | Drill the canvas to `node`'s **plane** — a token inside a **collapsed sub-process** lives on a separate plane, so call this to follow the action into the body (drills **in**) and back out to the root plane (drills **out**). No-op when `node` is already on the active plane, is unknown, or the viewer has no planes (older bpmn-js / expanded sub-processes share a plane). The plane counterpart to instance auto-focus; the [`animator`](../README.md#animator)'s replay uses it. |
| `getTokens(filter?)` | List tokens (each `{ node, label, color, state, selected, stackIndices }`), in insertion order. |
| `clear()` | Remove all tokens. |
| `setAnimationDuration(ms)` / `getAnimationDuration()` | Global animation duration — token moves **and** `throwIcon`/`catchIcon`. `0` makes transitions instant. |

### Events (on the bpmn-js `eventBus`)

- `token.click` — `{ node, label, sequenceFlow, stackIndices }` (`stackIndices` is the clicked **instance** — pass it back as the selector to address that token, since a stacked node shows only its front instance).
- `token.dblclick` — same payload as `token.click`; fired on a **double-click of the token dot** (the interactive simulator's advance gesture), synthesized from two clicks (a native dblclick can't survive the selection re-render that replaces the dot between clicks). The dot is an HTML overlay, a distinct target from the SVG shape `element.dblclick` (stack-scroll) fires on, so the two never collide.
- `token.overflow.click` — `{ node, hidden }` (the `+N` marker; `hidden` lists the `{ node, label, stackIndices }` not shown).

### Crowded nodes

At most **`maxVisible`** dots (default **3**) render at one spot on a node; beyond that, a single neutral **`+N`** marker is shown (clicking it fires `token.overflow.click`). Configure via module config:

```javascript
new BpmnViewer({
  container: '#canvas',
  additionalModules: [ AnimationModule ],
  animation: { maxVisible: 5, animationDuration: 600 }
});
```

### Keeping up with fast events

Every transition takes a **fixed duration** (default 1000 ms), independent of flow length. A token's logical position updates the instant you call `sendToken` (addressable at the destination immediately), and a new `sendToken` auto-finishes any still-running transition first — so rapid sends never overlap; the animation is cosmetic catch-up. Lower the duration with `setAnimationDuration(ms)` (`0` = instant) when events arrive faster than a token animates.

## Instance stacks

Render a node as a **stack of its own shape** (multiple instances) and scroll through them. Visualization only — the host drives sizes and contents; the library never infers a stack from tokens. **Instances are identified by stable keys** (e.g. instance labels) — removing one never disturbs the others.

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

**Per-instance tokens.** A token records which instance it belongs to via `stackIndices`, so a stacked node shows exactly its current front instance's tokens. You declare the instances up front and the library resolves what to show against the current front keys — no callback:

```javascript
primitives.setStacks('SubProcess_1', [ 'a', 'b', 'c' ]);  // three instances, 'a' in front

// each instance's tokens, tagged with the instance key
primitives.createToken('SubTask_1', 'order-42', color, state, { SubProcess_1: 'a' });
primitives.createToken('SubTask_1', 'order-77', color, state, { SubProcess_1: 'b' });

await primitives.moveToFront('SubProcess_1', 'b'); // now shows instance 'b' (animated)
```

A token's instance membership is **fixed** (a move keeps it); only the node's display order changes when you scroll / reorder. `stackIndices` need only list the stacked nodes in the token's own/ancestor chain; an omitted stacked entry means the base instance.

**Nested stacks.** A token deep inside lists every stacked ancestor, e.g. `{ Process_1: 'i2', MI_Activity: 'm1' }`. Nested stack *contents* that differ per outer instance are declared with the context argument, e.g. `setStacks('MI_Activity', [...], { Process_1: 'i2' })`, and resolve automatically as you scroll the outer stack.

### Implicit process box

A bare `bpmn:Process` with no pool has no shape of its own, so the box *is* its first instance. `setStacks(processId, keys)` (with one or more keys) draws a **pool-style box** (outer rect + left banner with the process name) around its flow nodes — at one key just the box, at more keys the box plus offset copies — and clearing the keys removes it. `getProcessBox()` returns its id. The box behaves like a sub-process — it carries tokens at the process and tokens in its scope, and supports selection.

What the box wraps is what the process executes. An artifact is left out of it: a text annotation or a group says something about the diagram rather than taking part in it, and it may be placed anywhere, so wrapping one would stretch the frame across empty space to reach a comment. The box is drawn again whenever the extent of what it wraps has changed, so a diagram modelled while a box stands keeps a frame around its content rather than around where the content used to be.

The box is drawn in a layer of its own, below every plane layer, rather than among the elements diagram-js manages. It pans and zooms with the diagram as any layer does. Drawn into the active layer it would be a stranger among children diagram-js reorders, and adding any shape to the root moves it to the end of that layer, which is in front of every node: the frame would come to cover what it frames.

That layer is not a plane, so diagram-js neither hides nor shows it on a drill, and the box follows the active root itself: drilling into a collapsed sub-process removes it, and drilling back out draws it again with the stack it had. It is drawn again rather than merely revealed because a plane switch moves no token, so nothing else would redraw it.

The box is never drawn while another plane is shown. A stack changes whenever a token moves, and a token advancing into a collapsed sub-process changes the outer process's stack while the reader is watching the sub-process; the stack is recorded, and the box waits for its own plane.
