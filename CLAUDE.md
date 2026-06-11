# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [bpmn-js](https://github.com/bpmn-io/bpmn-js) extension that renders **tokens** on
a diagram and moves them along flows under **programmatic control** — there is no
BPMN execution engine. It is the "visualization only" counterpart to
[bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation):
the host application decides when tokens are created, moved, split, and removed.

Shipped as ES modules under `lib/`; consumers bundle it. No build step for the
library. `demo/` is the vite app (single page, `index.html` + `main.js`) — a
**Simulator ⇄ Playback** toggle: in *Simulator* you load a diagram / pick a bundled
`examples/` model and drive tokens by double-click (the `simulator` **records** every BPMN event —
download it as JSON); in *Playback* the `animator` replays an execution log (the recording, a loaded
file, or the example's shipped `examples/<id>.json`) via `animator.replay`. The two
modes are separate — toggling clears the diagram (no replay take-over). Watch the
**console** for each event + action. It's the package's sole example app, published to
GitHub Pages on push to `main` (`.github/workflows/deploy.yml`). `examples/` holds the
curated showcase models (and their execution logs).

## Commands

```sh
npm install      # deps (incl. dev: bpmn-js + vite for the demo)
npm run dev      # vite dev server for demo/ (open the printed localhost URL)
npm run build    # production bundle of the demo → dist/ (sanity-checks all imports)
```

## Docs (keep in sync)

User-facing docs live in three places — **keep them current with every public-API change in the
same commit** (a renamed/removed/added method, changed signature, or new behaviour):

- **`README.md`** — purpose & what, install, a minimal basic-usage snippet, links to the guides.
  Keep it short; detailed API tables belong in `docs/`, not here.
- **`docs/animation.md`** — the high-level `animation` service (the supported surface).
- **`docs/primitives.md`** — the low-level `primitives` service.
- **`docs/execution-log.md`** — the shared **execution-log format**, plus its producer/consumer API: the
  `simulator`'s recording (`startRecording` / `getRecording`) and the `animator`'s `replay`. (The
  `animator`/`simulator` *tools* themselves are described in `README.md`, not a per-tool doc.)

`CLAUDE.md` (this file) is the **internal architecture/invariant** doc — a different audience;
update it too, but it is not a substitute for the user-facing guides. When you change a public
method, grep `README.md docs/` for the old name/signature and fix every mention. (Auto-generation
via documentation.js was evaluated and **declined** — it dumps every internal `_`-prefixed method
without `@private` tags; the hand-curated guides read better.)

## Architecture

The package entry (`lib/index.js`) exports **three composable modules** — the **default** is
**`AnimationModule`** (`primitives` + `animation` — the bare enabling API, no tools). The two tools are
**opt-in** and each pulls `AnimationModule` in via `__depends__`: **`SimulatorModule`** (`+ simulator`,
interactive + record) and **`AnimatorModule`** (`+ animator`, playback) — add either, or both (the demo
does), and each works without the other. **Plus named color
helpers `getRandomColor` / `getDistinctColor`** (`lib/color.js`) — callers mint a color
per identity and pass it in; the package never assigns colors itself. Both wrap the
**`randomcolor`** library — the **same coloring scheme as bpmn-js-token-simulation**:
`getDistinctColor(index)` cycles a fixed, contrast-filtered palette (60 `randomColor`
values kept under a YIQ cutoff), so concurrent instances read distinctly; a **child token
inherits its parent's color** (no per-instance "related shade" ring). `randomcolor` is the
package's one runtime dependency added for this; a `seed` option pins the palette for tests.

**Service layering (4):** `primitives` (low-level visual primitive) → `animation` (the BPMN-shaped
**enabling vocabulary** composed over it; the supported surface — *pure*, no record/replay) → two
opinionated **tools** that turn something into `animation` calls: `simulator` (gestures → functions;
**owns record**) and `animator` (a log → functions; **owns replay**). The two tools are **independent**
(neither depends on the other) and share only the **execution-log format** in `lib/executionLog.js`
(`RECORDED_METHODS` = the five token-flow functions, `describeEvent`/`eventCall`/`startsImmediately`). Record is the simulator
wrapping the shared `animation` instance's functions; replay re-issues a log against `animation` (using
the public `focusToken` seam + `animation.drillTo` to follow instance + plane). The "animate an
external execution log" goal is the **animator** consuming a log; `animation` itself stays a clean
vocabulary.

The low-level `primitives` service (`lib/primitives.js`) owns both token animation and node animation.
(The earlier split into `tokens` + `primitives` services was merged — `createToken`/
`setState`/etc. *are* animation concerns, and one service beats a fuzzy boundary.)

- **`primitives`** (`lib/primitives.js`) — the whole public API + renderer + low-level tween.
  - **Token** = `{ node, label, color, state, selected, stackIndices }`. `state = { position,
    sequenceFlow, animate, hidden }` is a pure visual descriptor (no lifecycle meaning baked in): `position` is a
    point `{ left, top, hoffset, voffset }` on/around the shape — `left`/`top` are **fractions** (may exceed
    0..1; default 0.5), `hoffset`/`voffset` add a **px** nudge (default 0): `x = left*w + hoffset` (`anchorPoint`)
    — `sequenceFlow` rests the dot
    where a flow meets the node, mutually exclusive; **`animate`** is a motion-cue **effect name**
    (`null`/absent = still) rendered as `.bts-anim-<name>` — six built-ins (`bounce`/`pulse`/`flip`,
    each `±-pause`), an **open set** (a host adds effects via CSS); **`hidden`** parks the
    dot — kept in the model + cluster, just CSS-`display:none` (`.bts-hidden`), e.g. an MI activity's outer token
    while its instances run (set via `setState`). **`stackIndices`**
    (T5) is the token's per-instance membership — a map `{ stackedNodeId: instanceKey }` over the stacked
    nodes in its own/ancestor chain. **An instance key is the stable id of an instance** — the count-based
    `setStackSize` keys instances by their numeric index `0..n-1`, while `setStacks` (and Animation,
    which keys by **instance label**) names them. (Omitted/`{}` when nothing is stacked; omitted entry ⇒ 0
    for count-based stacks. `_contextKey` keeps only truthy entries, so `0`/`null` normalize away to the same
    identity — a non-stacked ancestor must never carry a positive index; its real `getCurrentStack` is 0.)
  - **Identity = `(node, label, state.sequenceFlow, stackIndices)`** — key
    `` `node|label|sequenceFlow|A:2,B:1` `` (instance entries are non-zero, sorted; `_contextKey`).
    The rest flow lets same-label tokens **coexist** on distinct flows at one node (branches piling up
    at a merging gateway); `stackIndices` lets the same label coexist across **instances**.
  - State maps: `_tokens` (`key -> Token[]` — a **FIFO queue** per identity; length 1 in the normal
    case, so transparent. Several tokens share an identity only when concurrent **same-instance** paths
    converge at one node, e.g. a non-interrupting boundary fired twice; they're **homogeneous** —
    rendered as a stack of dots (`+k` past `maxVisible`), operations take the **head** and advance FIFO
    (`_head`/`_pushToken`/`_dropToken`/`_allTokens`). **Limitation:** queued homogeneous tokens are
    interchangeable — no individual selection/targeting and no scroll; a double-click on any advances the
    first-arrived. Rekeying onto an occupied identity (`_setState`/`sendToken`) now **queues**, not
    merges — an explicit gateway join is `joinTokens`.), `_nodeTokens` (`node -> Set<Token>`, render set
    of distinct token objects), `_nodeOverlays` (`node -> overlayId[]`, one per location
    cluster), `_activeAnimations` (`Token -> movement`), `_movements` (all live tween instances).
    **Per-instance, context-keyed (T5):** `_stackOrder` (`node -> Map<contextKey, key[]>` — instance
    **keys**, front first; size = key count), resolved against the current ancestor context (`_currentContext`).
  - **API:** `createToken(node,label,color,state?,stackIndices?)`,
    `sendToken([{node,label,sequenceFlow,stackIndices?},…]) → Promise<Token[]>` (token must already rest on
    `sequenceFlow`; travels to the far node, stays on the flow),
    `setState(node,label,state,selector?)`, `removeToken(node,label,selector?,gesture?)`,
    `selectToken(node,label,selector?)` / `deselectToken(…)` — `selector` = `{ sequenceFlow?,
    stackIndices? }`. `getSelectedTokens() → Token[]`, `setNodeSelected(node,selected=true)`,
    `getSelectedNodes() → string[]`, `setFlowDimmed(flowId,on=true)` (a `.bts-dim` semi-transparent class on
    a sequence flow — the simulator fades a diverging gateway's unchosen outflows; reverted by `clear`),
    `setNodeDimmed(nodeId,on=true)` (the same `.bts-dim` on a **node** — fades candidate link-catch events;
    thin wrapper over `setFlowDimmed`, shares its tracking + `clear`),
    `setStacks(node,keys,ancestorStackIndices?)` (the key-based primitive:
    set a node's ordered instance **keys**, front first — removing one never shifts the others),
    `getStacks(node) → key[]` (count = `.length`), `getCurrentStack(node) → key`
    (the front instance's key), `getCurrentStacks(node) → {id:key}` (the membership for the on-screen
    instance — node's own + stacked ancestors' front keys),
    `moveToFront(node,key) → Promise` / `moveToBack(node,key) → Promise`, `getProcessBox() → string|null`,
    `scrollStack(node,direction='forward'|'backward') → Promise`, `getMaxVisible() → number`,
    `throwIcon(node,label,selector?) → Promise`, `catchIcon(node,label,selector?) → Promise`,
    `playTokenEffect(node,label,effect,selector?) → Promise` (a **one-shot** dot gesture —
    `.bts-once-<effect>` for a third of a token-move (quick feedback) then stripped; transient, unlike the looping `state.animate`;
    sequence it before a depart/consume; reuses `_playOnce`, shared with the ghost below), `getTokens(filter?)` (insertion order),
    `clear`, `setAnimationDuration`. (The count/index conveniences
    `setStackSize`/`getStackSize`/`setStackIndex` are **not** service methods — they live as shims in
    `test/TestHelper.js` over the key-based API above.) `moveToFront`/`moveToBack`
    reorder the node's **`stackOrder`** in the current context (front = the shown instance) **and own
    the arc gesture** (so `autoFocus` animates too) — see below; `scrollStack` is thin sugar over them.
    `setState`/`removeToken`/`selectToken`/`deselectToken` take a trailing `sequenceFlow` to
    disambiguate; `setState` is a **partial merge** and rekeys (merging) when it changes the
    rest flow/position — that's how a join completes. Crossing the **flow↔anchor** boundary
    adjusts the token's own-node stack index (anchoring a flow token commits it into the
    current front instance: `stackIndices[node] = getCurrentStack(node)`; stepping onto a flow
    drops it). When the rest point moves and `animationDuration > 0`, the dot **glides** to
    the new point (reusing `_move`, over `_duration/3`) instead of jumping; the model updates
    synchronously (glide is cosmetic).
  - **Selection** (`selected`, a **carried** token field like `color` — *not* in `state`):
    `selectToken`/`deselectToken` toggle a blue ring on the resting dot (`.bts-selected`,
    `data-selected`). It **carries across a move** and **OR-merges on a join** (the merged
    token stays selected if any input was — done where identities collapse in `setState`;
    `color` is left last-writer-wins).
    **Node selection is stack-aware two ways.** (1) **Native** (the default path): the constructor
    registers a diagram-js **`outline.registerProvider`** whose `updateOutline` **grows the native
    `.djs-outline`** for a stacked node (by `_stackExtent` + `_stackMarkerWidth`) and returns `false`
    (native default sizing) otherwise — so **host/`selection`-service selection just works**, the whole
    bpmn-js ecosystem (property panel, …) stays in charge, and only the frame geometry differs for stacks
    (tested in `test/spec/OutlineSpec.js`). The interactive `Simulator` itself does **no** node selection
    (it drives tokens + flow dimming only — it no longer even injects `selection`) and is a token-
    simulation-style view: on `diagram.init` it marks the canvas container **`.bts-simulation`**, and our
    CSS hides the native selection box (`.djs-outline`) + modeling affordances — so clicking a node still
    selects it (state intact, ecosystem unaffected) but **no frame is drawn**. Only the full `simulator`
    sets the class; a host driving the lower-level `primitives`/`animation` keeps the visible (stack-aware)
    native box. (2) **Programmatic**
    (`setNodeSelected(node,selected?)`): draws our **own** `.bts-node-outline` rect (5px offset, rounded)
    into `getGraphics` + a `bts-selected` marker — an explicit highlight **independent of** the selection
    service (a host outlines a node without selecting it; the example uses it, hiding the native frame to
    avoid a double). Also stack-aware (`_drawNodeOutline` grows by `_stackExtent`; `setStackSize`
    re-syncs). Tracked in `_selectedNodes`; cleared by `clear`.
  - **Instance stack** (`setStackSize(node,size,ancestorStackIndices?)` / `getStackSize`): renders a node as a
    diagonally-offset **stack of its own shape** — the real node on top, with `size-1` opaque clones of
    `.djs-visual` (ids stripped, `pointer-events:none`, class `bts-stack-shape`) inserted as **leading children**
    of `getGraphics` so they paint *behind* the body and track pan/zoom. Shifted by `STACK_OFFSET` (4px), capped
    at `maxVisible` copies. **`size` is the instance count, uniform across node kinds:** `setStackSize` records
    `size>=1` and `0`/`null` clears it; the first instance is the node itself (or the process box), so only the
    `size-1` extras become copies — **size 1 = a single instance, no copies** (`getStackSize` returns 1).
    **Instances are identified by stable keys** (`_stackOrder` is a `key[]`): `setStackSize` keys them by
    numeric index `0..n-1`, while **`setStacks(node, keys, ctx?)`** sets explicit keys (Animation uses
    each instance's **label**). So removing one instance drops its *specific* key (`setStacks` minus that
    key) — survivors keep their keys and stay rendered, no positional gap (this is how `consume` shrinks a
    process stack). `getStacks(node) → key[]` reads the order. Static
    copies are **outline-only**; their **contents** are only
    drawn on the `scrollStack` snapshots (`_cloneNodeVisual(element, gfx, withContent)`). **Visual-only &
    host-driven — never inferred from tokens.** `_redrawStack(node)` draws the silhouette/`+k`/outline + re-renders
    tokens for the **currently-resolved** size.
  - **Per-instance state is context-keyed (T5).** A "context" is the ancestor-instance map
    `{ stackedAncestorId: index }`; `_contextKey` normalizes it (non-zero, sorted; **`{}`/`{A:0}` → `''`** — so
    *instance 0 is the base context*). `_stackOrder` is `Map<contextKey, key[]>` per node (size = key count);
    `setStackSize(node, size, ancestorStackIndices)` declares the size for *that outer-instance context* (**omit =
    the context currently on screen**, `_currentContext(node)`; pass `{}` for the base explicitly).
    `getStackSize`/`getCurrentStack(node)` **resolve** against `_currentContext(node)` (each stacked ancestor's
    current front key). **Contexts are independent — no fall-back to the base** (a size set for one outer
    instance never leaks to another; an unset context has no stack). So a nested activity can have a different
    count per outer instance, with **no callback**. **`_currentContext` includes an ancestor at size `>= 1`**
    (not only `>1`, which is the *`_isVisible`* visibility gate) — so a single **label-keyed** instance is
    already in the context and the key stays **stable** when the outer node grows 1→2 (a 2nd process instance
    no longer orphans descendant MI/event-sub stacks). `_contextKey` still drops a count-based front index of
    `0`, so base stays base; only a truthy (label) key participates at size 1.
  - **One resolution rule** drives all token visibility (`_isVisible`): a token shows iff,
    for every stacked node `A` in its `node`+ancestors, `(stackIndices[A] ?? 0) === getCurrentStack(A)`. So a
    stacked node renders its **current front instance's** tokens (at the node *and* in scope) — no "show first
    token", no `_scopeHidden`, no `getInstance`. Non-stacked / `size≤1` nodes aren't checked → render as before.
    **Exception: a token resting on a sequence flow ignores its own node's stack index** (only ancestors gate
    it) — a flow is drawn to the stack as a whole, so a token in transit shows whatever instance is front; the
    host commits it into an instance afterwards. On a `scrollStack`, the **scrolled node's own** flow tokens are
    skipped by the snapshot (`_drawTokenDots`) and stay put (their flow-cluster overlay isn't hidden), but
    **descendant** flow tokens (e.g. on a sub-process's internal flows) **do** ride the snapshot — they're
    instance-specific via the scrolled node as an ancestor.
  - **Stack `+k` marker:** when the true size exceeds the drawn cap, `_drawStackMarker` adds `k = size −
    (maxVisible+1)` hidden instances as a diagram-js overlay (`_stackOverlays`): plain bold black text
    (`.bts-stack-count`, 12px Arial, no badge circle), on the right at ¾ height, pushed past `_stackExtent`. The
    selection outline grows to span it (`_drawNodeOutline` + `_stackMarkerWidth`). Stack-level; the *token-level*
    `+k` (cluster overflow) is separate.
  - **`moveToFront`/`moveToBack(node, key)` own the reorder + arc.** `moveToFront(key)` brings `key`'s
    instance to the front (no-op if size≤1, `key` unknown, or `key` already front); `moveToBack(key)` sends it
    to the back. Both reorder `stackOrder` **by key** in the current context. The reorder + `_renderStackSubtree`
    run **synchronously** (a sync `getCurrentStack` read sees the new front); the **arc is cosmetic** and
    returns a `Promise`. The arc plays **only when the shown (front) instance changes** — `moveToFront`
    (a back copy rises to front) and `moveToBack` *of the front* (the front sinks to back) animate;
    `moveToBack` of a **non-front** key reorders **instantly** (front unchanged, no gesture). `scrollStack(node,
    direction)` is **sugar**: `'forward'` → `moveToBack(getCurrentStack)`, `'backward'` → `moveToFront(lastKey)`.
    `getCurrentStack` = `stackOrder[0]` (the **front key**); `setStackIndex(node, index)` (test/example shim)
    jumps by numeric position via `moveToFront` (wraps).
  - **The arc gesture (`_animateStackStep(node, element, direction, reorder)`)** — a one-off **snapshot
    transition** (Web Animations API), **no callback**: settle any in-flight gesture on this node (so rapid
    `autoFocus`/`moveTo*` never pile up — tracked in `_stackAnims`); snapshot the current instance (A, with
    content); run `reorder` (the caller's `stackOrder` bookkeeping) + `_renderStackSubtree` so the new instance
    is current; snapshot that (B); hide the real node + content + the node's & descendants' token overlays;
    animate **clones only** — the recycling clone **arcs over the stack** while the rest slide one slot (paint
    order swapped at the apex). `direction` is purely the **visual** (`'backward'` = a back copy rises to front,
    `'forward'` = the front sinks to back) — **front-agnostic** (hidden copies are identical silhouettes), so the
    same gesture serves any `reorder`. On finish: reveal, `_redrawStack` + re-render the subtree (`clear` settles
    any in-flight gesture; finish skips the re-render if the node is gone). Which tokens A/B carry is the
    resolution rule (`_drawTokenDots` draws every rule-visible token of the node + descendants that are
    **co-rendered on the same plane** (`_coRendered`) — a collapsed sub-process's drill-plane children are
    excluded from its collapsed-view snapshot). Fixed
    `STACK_SCROLL_DURATION` (600ms) — UI feedback, independent of `animationDuration` **except it's instant at
    `animationDuration: 0`** (so tests stay fast and a 0-duration host gets no arc). **When drilled *into* the
    node's own plane** (its shape sits on a different plane than the active root, so the arc would play
    off-screen), it **swaps instantly** instead — `reorder` + `_renderStackSubtree`, no
    overlay-hide — otherwise the on-plane token overlays would just vanish for 600ms and snap back.
    With-content clones deep-clone the sibling `.djs-children` (compensated
    `translate(-x,-y)`; `.djs-hit`/outlines stripped) + inline arrowhead `<marker>`s with fresh `bts-marker-N`
    ids. The `+k` marker stays visible through the gesture (stack-level). Composes for nesting (the rule checks
    every stacked ancestor) and event sub-processes (no at-node token → only scope tokens).
  - **Implicit-process box (T4)** — a bare `bpmn:Process` (no `bpmn:Collaboration`/pool) has its flow nodes on
    the root plane with **no shape** of its own — so the box *is* its first instance. When `setStackSize(node,
    size>=1)` is called on a node where
    `is(element, 'bpmn:Process')` (a pool is `bpmn:Participant`, excluded), `_ensureProcessBox` lazily draws a
    **pool-style box** we own: `getBBox(children) + banner/padding`, **set on the root element** (`x/y/width/
    height`, saved + restored) so every bounds-based path works on it, and a `.bts-process-box` `<g>`
    (`.djs-visual` = white-filled rect + `x=30` banner divider + rotated `bpmn:Process` name) inserted as the
    **first child of `canvas.getActiveLayer()`** (behind the flow groups; opaque white so offset copies hide
    content). Only `getGraphics` is shimmed (`_stackGfx` → the box, since `getGraphics(root)` is the layer);
    bounds are real, so at-process tokens (3a/3c) + scope tokens (3e — `root.children` have real `parent`) work
    unchanged. Scroll content = the layer's groups beside the box (`_processBoxContent`, the root has no
    `.djs-children`). `getProcessBox() → id|null`; drawn for `size>=1` (size 1 = box only), removed on
    `size<1`/`clear` (bounds restored). The example
    selects the pool-less process by **clicking the empty background** (`element.click` fires with the root).
  - **`throwIcon(node,label,selector?)` / `catchIcon(node,label,selector?)`** (both →
    `_animateIcon(node, label, selector, 'emit'|'receive')`): the cue is **anchored to a token**, not
    the bare node — resolve the resting token `(node,label,selector)` (no-op if absent), clone the
    element's icon geometry from `getGraphics` (`iconNodes` — any child shape whose bbox isn't the
    full-size body/outline, so it's tag-agnostic: path/circle/rect/polygon/…), and **center it on the
    token's resolved dot** (`_clusterPoint`; measure the clone bbox, then translate so its centre lands
    on the point — append→measure→transform is synchronous, no flash). Play a one-off CSS animation:
    `throwIcon` flies the icon diagonally up-right + fades out (`.bts-icon-emit`); `catchIcon` flies it
    in from up-left + fades in (`.bts-icon-receive`). **Direction is the caller's choice — reads no
    BPMN semantics** (does not guess throw/catch from element type). Native color, shared
    `animationDuration`; no-op if no icon; resolves on `animationend` (timeout fallback).
  - **`sendToken(transitions)`** — `{node,label,sequenceFlow,stackIndices?}`: travel a token **that already
    rests on `sequenceFlow`** along it to the far node, leaving it **resting on the same flow** there (no
    landing `state`; the host anchors it afterwards via `setState`). Resolve all first (invalid → reject, no
    side effects): find the token at `(node,label)` **on that flow** (disambiguated by `stackIndices`), reject
    if absent ("setState it onto the flow first") or several share it. `_resolveFlow` handles outgoing=forward /
    incoming=reverse (reversed waypoints); the animator gets `{ waypoints }` so direction is just the order.
    The landed token keeps the source's `color`/`label`/`selected`/**`stackIndices`** (a move never crosses
    instances) and its `state` (same `sequenceFlow`). Identity committed **optimistically at depart**. **No
    split** — the host creates a token on each flow. (Entering a specific instance of a stacked target / leaving
    a stack is host-managed: `removeToken` + `createToken` per instance, or `setState` with the full
    `stackIndices`.)
  - **Link events** — a link throw and its matching catch are bridged by **consume + create**, not a
    teleport: the token is **consumed at the throw** and a **fresh one created at the catch**. `createToken`
    accepts a **link catch** event (`_createCatchEventToken` — a child of the enclosing scope at CENTER,
    inheriting its color, so the instance keeps its color across the link). The Simulator side:
    `advanceToDeparted` routes a link **throw** (`c.link !== undefined`, no outflow) to `_jumpLink` → one
    matching catch auto-jumps (`_jumpTo`: throw icon out fire-and-forget + `animation.consumeToken` the
    throw + `createToken` the catch + route it through `triggerCatchEvent`, which flies the catch icon in
    and departs). The consume uses the **plain `animation.consumeToken` function**, not the Simulator's
    `_consume` — a leaf removal that does **not** finalize the instance even when the throw is its last
    token, so the create can repopulate it. Several matches reuse the diverging-gateway Fallback over the
    candidate **catch nodes** (`setNodeDimmed` dims them, a click picks, a double-click jumps). Matching
    catches exclude **label** elements (they share the catch's `businessObject`, so they'd classify
    identically and double the match).
  - **Fast events:** `sendToken` calls `_settle(token)` first — mid-flight tokens
    `finish()` immediately (land now), so rapid sends never overlap. No public settle call.
  - **Rendering:** the node's **rule-visible** tokens (`_isVisible` — filter + the instance rule) are
    grouped into **location clusters** — keyed by the **resolved point** (`anchorPoint`, rounded) so equal/
    equivalent positions queue together, or by rest `sequenceFlow`; each cluster is its own overlay
    (`overlays.add`, `bts-token-count`) at the computed point (`_clusterPoint`: `anchorPoint` of the position,
    or the flow's node-end waypoint). **Boundary-event avoidance** (`_avoidBoundaryEvents`): if the activity
    has a boundary event on its **top edge** (`element.attachers`), top-edge sweep points (`top:0`) drop by a
    fixed `BOUNDARY_VOFFSET` so the dots don't sit under the boundary symbol (the whole row shifts together;
    lower-half anchors untouched). **Dot size:** the default is small (20px, the moving-token size — so it
    doesn't cover an event/gateway symbol); an **anchored** token on a `bpmn:Activity`/`bpmn:Process` gets the
    larger 25px badge (`.bts-on-activity`, set per cluster via `big`). Per dot: `background: color`, `title =
    label`, `.bts-anim-<animate>` when `animate`, `.bts-selected` when `selected`, `.bts-hidden` (`display:none`) when `hidden`,
    `data-left`/`-top`/`-hoffset`/`-voffset`/`-sequence-flow`/`-animate`/`-selected`/`-hidden`. Capped per cluster at
    `config.animation.maxVisible` (default 3; `max+1` shown rather than a "+1" marker). The delegated
    handler fires `token.click {node,label,sequenceFlow,stackIndices}` / `token.overflow.click {node,hidden}`
    on click, and **`token.dblclick`** (same payload as `token.click`) on a **double-click of the dot** —
    the interactive simulator's advance gesture, **synthesized from two clicks** within `DOUBLE_CLICK_MS`
    (a native dblclick can't survive the selection re-render that replaces the dot between clicks); the dot
    is an HTML overlay, distinct from the SVG shape that `element.dblclick` (stack-scroll) fires on, so they
    never collide. A **stacked**
    node therefore shows exactly its **current front instance's** tokens (those whose `stackIndices` match
    the front), in insertion order — no special branch.
  - **Consume = synchronous model drop + async "ghost" gesture (shape ⟂ identity).** `removeToken(node,
    label,selector,gesture?)` drops the token's **identity** (model: `_tokens`/`_nodeTokens`, and via
    `consumeToken`→`_tearDown` the `_tokenMap`) **synchronously** — callers never await a fade to observe
    the removal. For a **gestured** removal (`gesture` = effect names, e.g. `['flip','fade-out']`), the live
    dot is **cloned into a detached "ghost"** (`_ghostFor`)
    in a persistent `.bts-token-ghosts` layer (in the canvas container, `_ghostLayer`) at its on-screen
    point, the identity is dropped + `_renderNode` runs (the live cluster loses it), then `_playGhost` plays
    the effects (`_playOnce`, shared with `playTokenEffect`) and **removes the clone on `animationend`** —
    fire-and-forget. The ghost is **outside `_renderNode`**, so a concurrent re-render can't wipe the
    in-flight gesture (the bug that made a fire-and-forget consume's dot **vanish instantly**). A whole
    subtree gestures **simultaneously** (one synchronous `_tearDown` loop). Cleared by `clear`. **Never block
    a reposition/travel on a consume** — fire the gesture and proceed in the same tick.
    **`removeToken` returns a Promise** that resolves when the flip-fade has finished; `_tearDown` collects
    these and `consumeToken` **awaits them before its stack-decrement** — so a **container never collapses
    out from under a still-fading dot**: the `moveToBack` arc, the `setStacks` drop (which removes the
    **implicit-process box** at size 0), and the **MI** parent release all run *after* the gesture. The
    model identity is already gone, so this delays only the **visual** container teardown, never
    addressability — and an unstacked consume (a shed boundary) is fire-and-forget, so it still never blocks.
  - **Standard lifecycle animations (high-level, automatic).** `animation.createToken`/`consumeToken` play a
    fixed **entrance** (`['fade-in','flip']`) / **exit** (`['flip','fade-out']`) automatically — no param,
    skipped at `animationDuration: 0`. There is **no `gesture` argument** on the high-level API (only the
    low-level `removeToken`/`playTokenEffect(s)` take explicit effects). A created token's **first depart
    blocks on its entrance** (`_entering` map + `_awaitEntering`, awaited in `_travelFlow`) so a travel can't
    cut the fade-flip short; `advanceToken`'s `onDeparted` hook fires right after `sendToken` re-renders the
    source node, so a re-armed event-sub waiter is created **after** the node clears and keeps its entrance.
  - **Low-level tween:** `TokenAnimation` lives at the **bottom of `primitives.js`, below a
    banner comment** — **adapted from bpmn-js-token-simulation** (everything above the banner
    is ours). It moves an SVG dot along a connection's waypoints over a **fixed** duration
    (`config.animation.animationDuration` / `setAnimationDuration`, default 1000ms — *not*
    the upstream geometry-derived `Math.log(length)*…`; per-segment timings are still
    distributed by length for steady speed), with a `finish()` fast-forward + `_done` guard.
    `sendToken` drives it via `_move`. Keep edits below the banner minimal for upstream syncing.

### Key invariants
- **Identity = `(node, label, sequenceFlow, stackIndices)`.** The rest flow lets same-label tokens
  coexist on distinct flows; `stackIndices` lets the same label coexist across **instances**. A token's
  instance membership is **fixed** (a move keeps it); display order lives per-node in `_stackOrder`.
- **`state` is visual-only.** The library bakes in no lifecycle meaning (arrived/
  entered/completed and the event/gateway placement rules are caller convention).
- **Color is caller-supplied and carried** by the token; a move keeps it. **`selected`
  is carried the same way** (kept across a move, OR-merged on a join).
- **Engine-free.** Do not reintroduce a simulator dependency. The `primitives` service
  resets on `diagram.clear`/`diagram.destroy`.

## Vendored code

The **low-level tween** at the bottom of `lib/primitives.js` (below the banner) derives from
upstream `lib/animation/Animation.js`; keep edits there minimal so upstream fixes can be
re-applied. Everything above the banner is ours. `assets/token-animation.css` is the
token-relevant subset of upstream's stylesheet plus the `.bts-overflow` / `.bts-icon*` /
`.bts-once-*` (one-shot `playTokenEffect` gestures) / `.bts-selected` / `.bts-on-activity` /
`.bts-node-outline` / `.bts-stack-*` styles.

## Testing

`npm test` runs karma + mocha in headless Chrome (`test/spec/TokensSpec.js`, booting
a `NavigatedViewer` via `test/TestHelper.js`). It uses a **system Chrome** (no
puppeteer — its Chromium download is blocked here); `karma.conf.js` sets
`CHROME_BIN` (default `google-chrome`, override via env) and runs
`ChromeHeadlessNoSandbox`. Determinism comes from bootstrapping with
`animation: { animationDuration: 0 }` (instant landings, synchronous-ish) + `await`; the
auto-settle test uses a non-zero duration so a transition is genuinely in flight.

The **`demo/`** app (`npm run dev`) remains the visual check (placement, smoothness, colors,
hover) — the interactive simulator **and** the execution-log playback (record → replay); it logs each
event + token action to the console.
