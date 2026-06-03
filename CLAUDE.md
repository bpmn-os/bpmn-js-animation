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
  - **Token** = `{ node, label, color, state, selected }`. `state = { position, sequenceFlow, bounce }`
    is a pure visual descriptor (no lifecycle meaning baked in): `position` is a 3×3
    anchor (`{top|center|bottom}-{left|middle|right}`), `sequenceFlow` rests the dot
    where a flow meets the node, mutually exclusive; `bounce` is the "action needed" cue.
  - **Identity = `(node, label, state.sequenceFlow)`** — key `` `node|label|sequenceFlow` ``
    (empty flow for anchor tokens). The rest flow is in the key so same-label tokens can
    **coexist** on distinct flows at one node (branches piling up at a merging gateway);
    anchor tokens stay one-per-`(node,label)`.
  - State maps: `_tokens` (`key -> Token`), `_order` (`Token[]` in **global order**, front
    first — the single source of truth for draw order; `getTokens`/`_renderNode` iterate it,
    `_nodeTokens` stays for membership/dedup), `_nodeTokens` (`node -> Set<Token>`, render
    set, deduped by `identityOf` = `label|flow`), `_nodeOverlays` (`node -> overlayId[]`,
    one per location cluster), `_activeAnimations` (`Token -> movement`), `_movements`
    (all live tween instances), `_filter` (visibility predicate).
  - **API:** `createToken(node,label,color,state?)`,
    `sendToken([{node,label,sequenceFlow,state?},…]) → Promise<Token[]>`,
    `setState(node,label,state,sequenceFlow?)`, `removeToken(node,label,sequenceFlow?)`,
    `selectToken(node,label,sequenceFlow?)` / `deselectToken(…)`,
    `getSelectedTokens() → Token[]`, `setNodeSelected(node,selected=true)`,
    `getSelectedNodes() → string[]`, `setStackSize(node,size)`, `getStackSize(node) → number`,
    `getStackIndex(node) → number`, `setStackIndex(node,index,getInstance?)`, `getProcessBox() → string|null`,
    `scrollStack(node,direction='forward'|'backward',getInstance?) → Promise`, `getMaxVisible() → number`,
    `throwIcon(node) → Promise`, `catchIcon(node) → Promise`, `getTokens(filter?)` (in global order),
    `moveToFront(token)` / `moveToBack(token)`, `setFilter(predicate|null)`, `clear`,
    `setAnimationDuration`. `moveToFront`/`moveToBack` take the **token object** (from `createToken`/
    `getTokens`), splice it to the front/back of `_order`, and re-render its node (front = first at the
    node = what a stacked node shows on top); a stale/unknown reference is a no-op. The internal
    `_visibleTokensAt(node)` returns the node's visible tokens in global order. `setFilter` hides non-matching tokens (kept, not removed; excluded
    from rendering + the cap, and in-flight ones `animation.hide()`) via `_isVisible` checked in
    `_renderNode`.
    `setState`/`removeToken`/`selectToken`/`deselectToken` take a trailing `sequenceFlow` to
    disambiguate; `setState` is a **partial merge** and rekeys (merging) when it changes the
    rest flow/position — that's how a join completes.
  - **Selection** (`selected`, a **carried** token field like `color` — *not* in `state`):
    `selectToken`/`deselectToken` toggle a blue ring on the resting dot (`.bts-selected`,
    `data-selected`). It **carries across a move**, is **copied to every branch on a split**,
    and **OR-merges on a join** (merged token stays selected if any input was — done where
    identities collapse in `setState` and `sendToken`; `color` is left last-writer-wins).
    `setNodeSelected(node,selected?)` draws the **modeller-style blue boundary** on an element
    by appending our own `.bts-node-outline` rect (5px offset, rounded) into its `getGraphics`
    and adding a `bts-selected` marker class — we *don't* rely on diagram-js's Outline module
    (a bare viewer may not load it). The outline is **stack-aware**: `_drawNodeOutline` grows it by the
    stack extent (`_stackExtent` = visible copies × `STACK_OFFSET`) so it wraps the whole stack, and
    `setStackSize` re-syncs it when the size changes. Tracked in `_selectedNodes`; cleared by `clear`.
  - **Instance stack** (`setStackSize(node,size)` / `getStackSize`): renders a node as a diagonally-
    offset **stack of its own shape** — the real node on top, with `size-1` faithful, opaque clones of
    `.djs-visual` (ids stripped, `pointer-events:none`, class `bts-stack-shape`) inserted as **leading
    children** of `getGraphics` so they paint *behind* the body and track pan/zoom. Shifted by
    `STACK_OFFSET` (4px), capped at `maxVisible` copies (so ≤ `maxVisible+1` shapes; `getStackSize` still
    reports the true size); `size<=1` removes it; rebuilt each call. Opaque (carries the node's own fill)
    so it hides content behind it. Static copies are **outline-only** (the silhouette suffices at the small
    offset) — even for containers; their **contents** (children + nested stacks + flows) are only drawn on the
    `scrollStack` snapshots (`_cloneNodeVisual(element, gfx, withContent)`). **Visual-only & host-driven — the
    library never infers the size from tokens.** Tracked in `_stackSizes` (+ `_stackIndex`, the front-instance
    index — see 3e below); cleared by `clear`.
    When the true size exceeds the drawn cap, `_drawStackMarker` adds a **stack `+k` overflow marker** —
    `k = size − (maxVisible+1)` hidden instances — as a diagram-js overlay (`_stackOverlays`, one per node):
    **plain bold black text** (`.bts-stack-count`, 12px Arial, *no* badge circle, unlike the token-cluster
    `+k`), placed on the **right of the stack at ¾ height** (a usually-vacant band), pushed past `_stackExtent`
    (+2px). The selection outline grows to **span the marker** (`_drawNodeOutline` adds `_stackMarkerWidth`).
    Redrawn each `setStackSize`, removed when `size ≤ maxVisible+1`; cleared by `clear`. This is the *stack-
    level* `+k` (hidden instances); the *token-level* `+k` (cluster overflow in `_renderNode`) is unchanged.
    `scrollStack(node, direction, getInstance?)` is a one-off **snapshot transition** (Web Animations API):
    snapshot the current instance (A) **with content**; **commit the next instance** onto the real descendants
    via `setStackIndex` (synchronous, between snapshots, before hiding the real node → no flash, lands on the
    next instance); snapshot that (B) **with content** for the incoming-front slot; the other behind clones
    are outline ghosts. With-content clones deep-clone the sibling `.djs-children` (compensated `translate(-x,-y)`;
    `.djs-hit`/outlines stripped, nested kept) and inline arrowhead `<marker>`s with fresh `bts-marker-N` ids
    (shared `<defs>` don't paint on clones). Hide the real node + its `.djs-children` + old copies; animate
    **clones only** — the recycling clone **arcs over the stack** (lifts clear, travels across, drops in) while
    the rest slide one slot (`'forward'` recycles front→back *behind*; `'backward'` lowest→front *on top*; paint
    order swapped mid-flight at the apex). On finish: reveal the real node (now B) and rebuild
    the canonical stack via `setStackSize`. Runs at a **fixed `STACK_SCROLL_DURATION` (600ms)** — UI feedback,
    *not* simulation, so independent of `animationDuration`.
    **Token *at the node* rides the scroll (3c):** the with-content clones draw the node's **own top token**
    (`_drawTokenDots` → `_visibleTokensAt(node)[0]`) as an SVG `.bts-stack-token` dot at its `_clusterPoint`
    (element-local), so A carries the old top and B the new top. The order **steps by one** mid-gesture (between
    the A and B snapshots): `'forward'` ⇒ `moveToBack(top)`, `'backward'` ⇒ `moveToFront(last)` — rotation length
    = the node's at-node token count (cycles among themselves; stack size stays decorative). The real at-node
    token overlay is `display:none` for the gesture (the snapshot dot stands in) and restored on finish, where
    `setStackSize` re-renders it for the new top; the **`+k` marker stays visible** (stack-level — the instance
    count is unchanged by a scroll and it sits outside the stack footprint).
    **Tokens *in scope* of a container (3e):** the descendants' tokens are instance-specific state the library
    can't infer (an **event sub-process has no at-node token, only inside**), and the scroll is always a UI
    gesture the client app doesn't initiate — so the library **pulls**. It keeps a per-node front index
    (`_stackIndex`, 0-based, wraps on scroll / clamps on resize / reset by `clear`; `getStackIndex`) and, on a
    scroll, calls **`getInstance(node, indices) → { tokens, stacks }`** — `indices` = `{ stackNodeId: index }`
    for every stacked node up `node`'s ancestor chain (`node` at its new index); `tokens` are **references**
    `{ node, label }` to already-created tokens; `stacks` are `[{ node, stackSize, stackIndex }]`. All instances'
    scope tokens **coexist** in the model (created once, distinct identities, color/state stable); a scroll only
    **toggles** which show — `setStackIndex` applies the nested sizes/indices and sets `_scopeHidden` on the
    non-active scope tokens (honored by `_isVisible`, so they're excluded from render + cap). `setStackIndex(node,
    index, getInstance?)` is the no-animation **load primitive** (seed instance 0 / jump); `scrollStack` wraps it
    with the A/B snapshots. `_drawTokenDots` draws the node's own top token **and** every visible descendant
    token into the snapshot (so scope tokens ride the arc); the node's + descendants' token overlays (and
    descendant `+k` markers) hide for the gesture. Flat — one `getInstance` per scrolled node returns its whole
    subtree; no recursion. Composes with 3c (event sub-process → no at-node token, only 3e runs).
  - **Implicit-process box (T4)** — a bare `bpmn:Process` (no `bpmn:Collaboration`/pool) has its flow nodes on
    the root plane with **no shape** to stack. So when `setStackSize(node, size>1)` is called on a node where
    `is(element, 'bpmn:Process')` (a pool is `bpmn:Participant`, excluded), `_ensureProcessBox` lazily draws a
    **pool-style box** we own: `getBBox(children) + banner/padding`, **set on the root element** (`x/y/width/
    height`, saved + restored) so every bounds-based path works on it, and a `.bts-process-box` `<g>`
    (`.djs-visual` = white-filled rect + `x=30` banner divider + rotated `bpmn:Process` name) inserted as the
    **first child of `canvas.getActiveLayer()`** (behind the flow groups; opaque white so offset copies hide
    content). Only `getGraphics` is shimmed (`_stackGfx` → the box, since `getGraphics(root)` is the layer);
    bounds are real, so at-process tokens (3a/3c) + scope tokens (3e — `root.children` have real `parent`) work
    unchanged. Scroll content = the layer's groups beside the box (`_processBoxContent`, the root has no
    `.djs-children`). `getProcessBox() → id|null`; removed on `size<=1`/`clear` (bounds restored). The example
    selects the pool-less process by **clicking the empty background** (`element.click` fires with the root).
  - **`throwIcon(node)` / `catchIcon(node)`** (both → `_animateIcon(node, 'emit'|'receive')`):
    clone the element's icon geometry from `getGraphics` (`iconNodes` — any child shape
    whose bbox isn't the full-size body/outline, so it's tag-agnostic: path/circle/rect/polygon/…),
    place them over the element on the plane layer, and play a one-off CSS animation. `throwIcon`
    flies the icon diagonally up-right + fades out (`.bts-icon-emit`); `catchIcon` flies it in
    from up-left + fades in (`.bts-icon-receive`). **Direction is the caller's choice — the node
    API reads no BPMN semantics** (it does not guess throw/catch from element type). Native color,
    shared `animationDuration`; no-op if no icon; resolves on `animationend` (timeout fallback).
  - **`sendToken(transitions)`**: resolve all first (invalid → reject, no side effects),
    group by source token (looked up by `(node,label)`, **rejects if ambiguous**), consume
    once and fork one **branch** per flow. `_resolveFlow` handles outgoing=forward /
    incoming=reverse (reversed waypoints); the animator gets `{ waypoints }` so direction
    is just the order. Branches keep the source's `color`/`label`/`selected` and take their
    entry's landing `state`, and **inherit the source's slot** in `_order` (splits stay
    contiguous; a branch merging onto an occupied identity drops the absorbed token from `_order`).
    Identity committed **optimistically at depart**; resting badge added on landing.
  - **Fast events:** `sendToken` calls `_settle(token)` first — mid-flight tokens
    `finish()` immediately (land now), so rapid sends never overlap. No public settle call.
  - **Rendering:** tokens at a node are grouped into **location clusters** (by anchor
    `position` or rest `sequenceFlow`), in **global `_order`**; each cluster is its own overlay
    (`overlays.add`, `bts-token-count`) positioned at the computed point (`_clusterPoint`: anchor
    fraction of bounds, or the flow's node-end waypoint). Per dot: `background: color`,
    `title = label`, `.bts-bounce` when `bounce`, `.bts-selected` when `selected`,
    `data-position`/`-sequence-flow`/`-bounce`/`-selected`.
    Capped per cluster at `config.animation.maxVisible` (default 3; `max+1` shown
    rather than a "+1" marker). Delegated click fires `token.click {node,label,sequenceFlow}`
    or `token.overflow.click {node,hidden}`.
    **Stacked node → only the top token:** when `getStackSize(node) > 1`, `_renderNode` draws
    just `_visibleTokensAt(node)[0]` (the top stack's token) at its own anchor — the silhouette +
    stack `+k` convey the rest; `scrollStack`/`moveToFront` bring another to the top. Non-stacked
    nodes render every token as above. `setStackSize` re-renders so tokens collapse to the top
    (or expand back) when the size crosses 1.
  - **Low-level tween:** `TokenAnimation` lives at the **bottom of `Animation.js`, below a
    banner comment** — **adapted from bpmn-js-token-simulation** (everything above the banner
    is ours). It moves an SVG dot along a connection's waypoints over a **fixed** duration
    (`config.animation.animationDuration` / `setAnimationDuration`, default 1000ms — *not*
    the upstream geometry-derived `Math.log(length)*…`; per-segment timings are still
    distributed by length for steady speed), with a `finish()` fast-forward + `_done` guard.
    `sendToken` drives it via `_move`. Keep edits below the banner minimal for upstream syncing.

### Key invariants
- **Identity = `(node, label, sequenceFlow)`.** Element ids are unique within a
  diagram (no process id needed); the rest flow lets same-label tokens coexist on
  distinct flows at one node, while anchor tokens stay one-per-`(node,label)`.
- **`state` is visual-only.** The library bakes in no lifecycle meaning (arrived/
  entered/completed and the event/gateway placement rules are caller convention).
- **Color is caller-supplied and carried** by the token; splits inherit it. **`selected`
  is carried the same way** (copied on split, OR-merged on join).
- **Engine-free.** Do not reintroduce a simulator dependency. The `animation` service
  resets on `diagram.clear`/`diagram.destroy`.

## Vendored code

The **low-level tween** at the bottom of `lib/Animation.js` (below the banner) derives from
upstream `lib/animation/Animation.js`; keep edits there minimal so upstream fixes can be
re-applied. Everything above the banner is ours. `assets/token-animation.css` is the
token-relevant subset of upstream's stylesheet plus the `.bts-overflow` / `.bts-icon*` /
`.bts-selected` / `.bts-node-outline` / `.bts-stack-*` styles.

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
