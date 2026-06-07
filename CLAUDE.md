# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [bpmn-js](https://github.com/bpmn-io/bpmn-js) extension that renders **tokens** on
a diagram and moves them along flows under **programmatic control** — there is no
BPMN execution engine. It is the "visualization only" counterpart to
[bpmn-js-token-simulation](https://github.com/bpmn-io/bpmn-js-token-simulation):
the host application decides when tokens are created, moved, split, and removed.

Shipped as ES modules under `lib/`; consumers bundle it. No build step for the
library. `example/` is a vite playground for local development (not published).

## Commands

```sh
npm install      # deps (incl. dev: bpmn-js + vite for the example)
npm run dev      # vite dev server for example/ (open the printed localhost URL)
npm run build    # production bundle of the example (sanity-checks all imports)
```

## Architecture

The package entry (`lib/index.js`) exports the module as default **plus a named
`getRandomColor`** (`lib/color.js`) — a pure CSS-color helper callers use to mint a
color per identity and pass it in; the package never assigns colors itself.

A bpmn-js `additionalModule` (didi DI — see `lib/index.js`) providing **one service,
`animation`** (`lib/Animation.js`), which owns both token animation and node animation.
(The earlier split into `tokens` + `animation` services was merged — `createToken`/
`setState`/etc. *are* animation concerns, and one service beats a fuzzy boundary.)

- **`animation`** (`lib/Animation.js`) — the whole public API + renderer + low-level tween.
  - **Token** = `{ node, label, color, state, selected, stackIndices }`. `state = { position,
    sequenceFlow, bounce }` is a pure visual descriptor (no lifecycle meaning baked in): `position` is a
    point `{ left, top, hoffset, voffset }` on/around the shape — `left`/`top` are **fractions** (may exceed
    0..1; default 0.5), `hoffset`/`voffset` add a **px** nudge (default 0): `x = left*w + hoffset` (`anchorPoint`)
    — `sequenceFlow` rests the dot
    where a flow meets the node, mutually exclusive; `bounce` is the "action needed" cue. **`stackIndices`**
    (T5) is the token's per-instance membership — a map `{ stackedNodeId: instanceKey }` over the stacked
    nodes in its own/ancestor chain. **An instance key is the stable id of an instance** — the count-based
    `setStackSize` keys instances by their numeric index `0..n-1`, while `setStacks` (and SimulationAPI,
    which keys by **instance label**) names them. (Omitted/`{}` when nothing is stacked; omitted entry ⇒ 0
    for count-based stacks. `_contextKey` keeps only truthy entries, so `0`/`null` normalize away to the same
    identity — a non-stacked ancestor must never carry a positive index; its real `getCurrentStack` is 0.)
  - **Identity = `(node, label, state.sequenceFlow, stackIndices)`** — key
    `` `node|label|sequenceFlow|A:2,B:1` `` (instance entries are non-zero, sorted; `_contextKey`).
    The rest flow lets same-label tokens **coexist** on distinct flows at one node (branches piling up
    at a merging gateway); `stackIndices` lets the same label coexist across **instances**.
  - State maps: `_tokens` (`key -> Token`), `_nodeTokens` (`node -> Set<Token>`, render set, deduped by
    `identityOf` = `label|flow|stackIndices`), `_nodeOverlays` (`node -> overlayId[]`, one per location
    cluster), `_activeAnimations` (`Token -> movement`), `_movements` (all live tween instances),
    `_filter` (visibility predicate). **Per-instance, context-keyed (T5):** `_stackSizes`
    (`node -> Map<contextKey, size>`, a key-count cache) and `_stackOrder` (`node -> Map<contextKey, key[]>`
    — instance **keys**, front first), both resolved against the current ancestor context (`_currentContext`).
  - **API:** `createToken(node,label,color,state?,stackIndices?)`,
    `sendToken([{node,label,sequenceFlow,stackIndices?},…]) → Promise<Token[]>` (token must already rest on
    `sequenceFlow`; travels to the far node, stays on the flow),
    `setState(node,label,state,selector?)`, `removeToken(node,label,selector?)`,
    `selectToken(node,label,selector?)` / `deselectToken(…)` — `selector` = `{ sequenceFlow?,
    stackIndices? }`. `getSelectedTokens() → Token[]`, `setNodeSelected(node,selected=true)`,
    `getSelectedNodes() → string[]`, `setStacks(node,keys,ancestorStackIndices?)` (the key-based primitive:
    set a node's ordered instance **keys**, front first — removing one never shifts the others),
    `getStacks(node) → key[]` (count = `.length`), `getCurrentStack(node) → key`
    (the front instance's key), `getCurrentStacks(node) → {id:key}` (the membership for the on-screen
    instance — node's own + stacked ancestors' front keys),
    `moveToFront(node,key)` / `moveToBack(node,key)`, `getProcessBox() → string|null`,
    `scrollStack(node,direction='forward'|'backward') → Promise`, `getMaxVisible() → number`,
    `throwIcon(node) → Promise`, `catchIcon(node) → Promise`, `getTokens(filter?)` (insertion order),
    `setFilter(predicate|null)`, `clear`, `setAnimationDuration`. (The count/index conveniences
    `setStackSize`/`getStackSize`/`setStackIndex` are **not** service methods — they live as shims in
    `test/TestHelper.js` + `example/app.js` over the key-based API above.) `moveToFront`/`moveToBack`
    reorder the node's **`stackOrder`** in the current context (front = the shown instance); `scrollStack`
    rotates it. `setFilter` hides non-matching tokens (kept, not removed; excluded from rendering + the
    cap, and in-flight ones `animation.hide()`) via `_isVisible` checked in `_renderNode`.
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
    `setNodeSelected(node,selected?)` draws the **modeller-style blue boundary** on an element
    by appending our own `.bts-node-outline` rect (5px offset, rounded) into its `getGraphics`
    and adding a `bts-selected` marker class — we *don't* rely on diagram-js's Outline module
    (a bare viewer may not load it). The outline is **stack-aware**: `_drawNodeOutline` grows it by the
    stack extent (`_stackExtent` = visible copies × `STACK_OFFSET`) so it wraps the whole stack, and
    `setStackSize` re-syncs it when the size changes. Tracked in `_selectedNodes`; cleared by `clear`.
  - **Instance stack** (`setStackSize(node,size,ancestorStackIndices?)` / `getStackSize`): renders a node as a
    diagonally-offset **stack of its own shape** — the real node on top, with `size-1` opaque clones of
    `.djs-visual` (ids stripped, `pointer-events:none`, class `bts-stack-shape`) inserted as **leading children**
    of `getGraphics` so they paint *behind* the body and track pan/zoom. Shifted by `STACK_OFFSET` (4px), capped
    at `maxVisible` copies. **`size` is the instance count, uniform across node kinds:** `setStackSize` records
    `size>=1` and `0`/`null` clears it; the first instance is the node itself (or the process box), so only the
    `size-1` extras become copies — **size 1 = a single instance, no copies** (`getStackSize` returns 1).
    **Instances are identified by stable keys** (`_stackOrder` is a `key[]`): `setStackSize` keys them by
    numeric index `0..n-1`, while **`setStacks(node, keys, ctx?)`** sets explicit keys (SimulationAPI uses
    each instance's **label**). So removing one instance drops its *specific* key (`setStacks` minus that
    key) — survivors keep their keys and stay rendered, no positional gap (this is how `consume` shrinks a
    process stack). `getStacks(node) → key[]` reads the order. Static
    copies are **outline-only**; their **contents** are only
    drawn on the `scrollStack` snapshots (`_cloneNodeVisual(element, gfx, withContent)`). **Visual-only &
    host-driven — never inferred from tokens.** `_redrawStack(node)` draws the silhouette/`+k`/outline + re-renders
    tokens for the **currently-resolved** size.
  - **Per-instance state is context-keyed (T5).** A "context" is the ancestor-instance map
    `{ stackedAncestorId: index }`; `_contextKey` normalizes it (non-zero, sorted; **`{}`/`{A:0}` → `''`** — so
    *instance 0 is the base context*). `_stackSizes`/`_stackOrder` are `Map<contextKey, …>` per node;
    `setStackSize(node, size, ancestorStackIndices)` declares the size for *that outer-instance context* (**omit =
    the context currently on screen**, `_currentContext(node)`; pass `{}` for the base explicitly).
    `getStackSize`/`getCurrentStack(node)` **resolve** against `_currentContext(node)` (each stacked ancestor's
    current front index). **Contexts are independent — no fall-back to the base** (a size set for one outer
    instance never leaks to another; an unset context has no stack). So a nested activity can have a different
    count per outer instance, with **no callback**.
  - **One resolution rule** drives all token visibility (`_isVisible`): a token shows iff `_filter` passes and,
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
  - **`scrollStack(node, direction)`** — a one-off **snapshot transition** (Web Animations API), **no callback**:
    snapshot the current instance (A, with content); **rotate the node's `stackOrder` in its current context** by
    one (`'forward'` front→back, `'backward'` last→front) and `_renderStackSubtree` so the new instance is
    current; snapshot that (B); hide the real node + content + the node's & descendants' token overlays; animate
    **clones only** — the recycling clone **arcs over the stack** while the rest slide one slot (paint order
    swapped at the apex). On finish: reveal, `_redrawStack` + re-render the subtree. Which tokens A/B carry is the
    resolution rule (`_drawTokenDots` draws every rule-visible token of the node + descendants that are
    **co-rendered on the same plane** (`_coRendered`) — a collapsed sub-process's drill-plane children are
    excluded from its collapsed-view snapshot). Fixed
    `STACK_SCROLL_DURATION` (600ms) — UI feedback, independent of `animationDuration`. **When drilled *into* the
    node's own plane** (its shape sits on a different plane than the active root, so the arc would play
    off-screen), `scrollStack` **swaps instantly** instead — rotate `stackOrder` + `_renderStackSubtree`, no
    overlay-hide — otherwise the on-plane token overlays would just vanish for 600ms and snap back. `moveToFront`/`moveToBack(
    node, key)` reorder the same `stackOrder` by **key** and `setStackIndex(node, index)` jumps by numeric
    position (count-based stacks; wraps); `getCurrentStack` = `stackOrder[0]` (the **front key**). With-content clones deep-clone the sibling `.djs-children` (compensated
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
  - **`throwIcon(node)` / `catchIcon(node)`** (both → `_animateIcon(node, 'emit'|'receive')`):
    clone the element's icon geometry from `getGraphics` (`iconNodes` — any child shape
    whose bbox isn't the full-size body/outline, so it's tag-agnostic: path/circle/rect/polygon/…),
    place them over the element on the plane layer, and play a one-off CSS animation. `throwIcon`
    flies the icon diagonally up-right + fades out (`.bts-icon-emit`); `catchIcon` flies it in
    from up-left + fades in (`.bts-icon-receive`). **Direction is the caller's choice — the node
    API reads no BPMN semantics** (it does not guess throw/catch from element type). Native color,
    shared `animationDuration`; no-op if no icon; resolves on `animationend` (timeout fallback).
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
  - **Fast events:** `sendToken` calls `_settle(token)` first — mid-flight tokens
    `finish()` immediately (land now), so rapid sends never overlap. No public settle call.
  - **Rendering:** the node's **rule-visible** tokens (`_isVisible` — filter + the instance rule) are
    grouped into **location clusters** — keyed by the **resolved point** (`anchorPoint`, rounded) so equal/
    equivalent positions queue together, or by rest `sequenceFlow`; each cluster is its own overlay
    (`overlays.add`, `bts-token-count`) at the computed point (`_clusterPoint`: `anchorPoint` of the position,
    or the flow's node-end waypoint). **Dot size:** the default is small (20px, the moving-token size — so it
    doesn't cover an event/gateway symbol); an **anchored** token on a `bpmn:Activity`/`bpmn:Process` gets the
    larger 25px badge (`.bts-on-activity`, set per cluster via `big`). Per dot: `background: color`, `title =
    label`, `.bts-bounce` when `bounce`, `.bts-selected` when `selected`,
    `data-left`/`-top`/`-hoffset`/`-voffset`/`-sequence-flow`/`-bounce`/`-selected`. Capped per cluster at
    `config.animation.maxVisible` (default 3; `max+1` shown rather than a "+1" marker). Delegated click
    fires `token.click {node,label,sequenceFlow,stackIndices}` or `token.overflow.click {node,hidden}`. A **stacked**
    node therefore shows exactly its **current front instance's** tokens (those whose `stackIndices` match
    the front), in insertion order — no special branch.
  - **Low-level tween:** `TokenAnimation` lives at the **bottom of `Animation.js`, below a
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
- **Engine-free.** Do not reintroduce a simulator dependency. The `animation` service
  resets on `diagram.clear`/`diagram.destroy`.

## Vendored code

The **low-level tween** at the bottom of `lib/Animation.js` (below the banner) derives from
upstream `lib/animation/Animation.js`; keep edits there minimal so upstream fixes can be
re-applied. Everything above the banner is ours. `assets/token-animation.css` is the
token-relevant subset of upstream's stylesheet plus the `.bts-overflow` / `.bts-icon*` /
`.bts-selected` / `.bts-on-activity` / `.bts-node-outline` / `.bts-stack-*` styles.

## Testing

`npm test` runs karma + mocha in headless Chrome (`test/spec/TokensSpec.js`, booting
a `NavigatedViewer` via `test/TestHelper.js`). It uses a **system Chrome** (no
puppeteer — its Chromium download is blocked here); `karma.conf.js` sets
`CHROME_BIN` (default `google-chrome`, override via env) and runs
`ChromeHeadlessNoSandbox`. Determinism comes from bootstrapping with
`animation: { animationDuration: 0 }` (instant landings, synchronous-ish) + `await`; the
auto-settle test uses a non-zero duration so a transition is genuinely in flight.

The **vite example** (`example/`, `npm run dev`) remains the visual check (placement,
smoothness, colors, hover).
