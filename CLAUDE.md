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

A bpmn-js `additionalModule` (didi DI — see `lib/index.js`) providing two services:

- **`tokens`** (`lib/Tokens.js`) — the public API and the resting-token renderer.
  - **Token** = `{ node, label, color, state }`. `state = { position, sequenceFlow, bounce }`
    is a pure visual descriptor (no lifecycle meaning baked in): `position` is a 3×3
    anchor (`{above|center|below}-{left|middle|right}`), `sequenceFlow` rests the dot
    where a flow meets the node, mutually exclusive; `bounce` is the "action needed" cue.
  - **Identity = `(node, label, state.sequenceFlow)`** — key `` `node|label|sequenceFlow` ``
    (empty flow for anchor tokens). The rest flow is in the key so same-label tokens can
    **coexist** on distinct flows at one node (branches piling up at a merging gateway);
    anchor tokens stay one-per-`(node,label)`.
  - State maps: `_tokens` (`key -> Token`), `_nodeTokens` (`node -> Set<Token>`, render
    set, deduped by `identityOf` = `label|flow`), `_nodeOverlays` (`node -> overlayId[]`,
    one per location cluster), `_activeAnimations` (`Token -> animation`).
  - **API:** `createToken(node,label,color,state?)`,
    `sendToken([{node,label,sequenceFlow,state?},…]) → Promise<Token[]>`,
    `setState(node,label,state,sequenceFlow?)`, `removeToken(node,label,sequenceFlow?)`,
    `animateSymbol(node) → Promise`, `getTokens(filter?)`, `setFilter(predicate|null)`, `clear`,
    `setAnimationDuration`. `setFilter` hides non-matching tokens (kept, not removed; excluded
    from rendering + the cap, and in-flight ones `animation.hide()`) via `_isVisible` checked in
    `_renderNode`.
    `setState`/`removeToken` take a trailing `sequenceFlow` to disambiguate; `setState` is a
    **partial merge** and rekeys (merging) when it changes the rest flow/position — that's how
    a join completes.
  - **`animateSymbol(node)`**: clones the element's symbol/marker geometry from `getGraphics`
    (`symbolNodes` — any child shape whose bbox isn't the full-size body/outline, so it's
    tag-agnostic: path/circle/rect/polygon/…), places them over the element on the plane
    layer, and plays a one-off CSS
    animation: throwing elements (`_isThrowing`: send task, throw/end event) fly the symbol
    diagonally up-right + fade out (`.bts-symbol-emit`); catching ones fly it in from up-left +
    fade in (`.bts-symbol-receive`). Native color, shared `animationDuration`; no-op if no
    symbol; resolves on `animationend` (timeout fallback).
  - **`sendToken(transitions)`**: resolve all first (invalid → reject, no side effects),
    group by source token (looked up by `(node,label)`, **rejects if ambiguous**), consume
    once and fork one **branch** per flow. `_resolveFlow` handles outgoing=forward /
    incoming=reverse (reversed waypoints); the animator gets `{ waypoints }` so direction
    is just the order. Branches keep the source's `color`/`label` and take their entry's
    landing `state`. Identity committed **optimistically at depart**; resting badge added
    on landing.
  - **Fast events:** `sendToken` calls `_settle(token)` first — mid-flight tokens
    `finish()` immediately (land now), so rapid sends never overlap. No public settle call.
  - **Rendering:** tokens at a node are grouped into **location clusters** (by anchor
    `position` or rest `sequenceFlow`); each cluster is its own overlay (`overlays.add`,
    `bts-token-count`) positioned at the computed point (`_clusterPoint`: anchor fraction
    of bounds, or the flow's node-end waypoint). Per dot: `background: color`,
    `title = label`, `.bts-bounce` when `bounce`, `data-position`/`-sequence-flow`/`-bounce`.
    Capped per cluster at `config.tokenAnimation.maxVisible` (default 3; `max+1` shown
    rather than a "+1" marker). Delegated click fires `token.click {node,label,sequenceFlow}`
    or `token.overflow.click {node,hidden}`.
- **`animation`** (`lib/Animation.js`) — the low-level animator, **vendored from
  bpmn-js-token-simulation** with the engine coupling removed (no `scopeFilter`,
  no simulator/scope events). Moves an SVG dot along `connection.waypoints` with
  per-segment easing. Inputs it needs: a `tokenLike = { color, element: connection }`
  and a connection with waypoints; `element` only resolves the canvas plane.
  - Local changes vs. the upstream copy (preserve when syncing fixes): the total
    duration is a **fixed** value (`config.tokenAnimation.animationDuration`, default 1000ms,
    or `setAnimationDuration()`), **not** the upstream geometry-derived `Math.log(length)*…`
    — segment timings are still distributed by length so speed is steady, but a long
    and a short flow take the same total time. Plus a `finish()` fast-forward and a
    `_done` guard in `completed()`. The token graphic is a plain colored circle
    (`token.color`); no label text (labels are hover-only on resting badges).

### Key invariants
- **Identity = `(node, label, sequenceFlow)`.** Element ids are unique within a
  diagram (no process id needed); the rest flow lets same-label tokens coexist on
  distinct flows at one node, while anchor tokens stay one-per-`(node,label)`.
- **`state` is visual-only.** The library bakes in no lifecycle meaning (arrived/
  entered/completed and the event/gateway placement rules are caller convention).
- **Color is caller-supplied and carried** by the token; splits inherit it.
- **Engine-free.** Do not reintroduce a simulator dependency. `Animation` listens
  only to `diagram.destroy`; `Tokens` to `diagram.clear`/`diagram.destroy`.

## Vendored code

`lib/Animation.js` derives from upstream `lib/animation/Animation.js`. When touching
it, preserve attribution and prefer minimal diffs so upstream fixes can be
re-applied. `assets/token-animation.css` is the token-relevant subset of upstream's
stylesheet plus the `.bts-overflow` marker style.

## Testing

`npm test` runs karma + mocha in headless Chrome (`test/spec/TokensSpec.js`, booting
a `NavigatedViewer` via `test/TestHelper.js`). It uses a **system Chrome** (no
puppeteer — its Chromium download is blocked here); `karma.conf.js` sets
`CHROME_BIN` (default `google-chrome`, override via env) and runs
`ChromeHeadlessNoSandbox`. Determinism comes from bootstrapping with
`tokenAnimation: { animationDuration: 0 }` (instant landings, synchronous-ish) + `await`; the
auto-settle test uses a non-zero duration so a transition is genuinely in flight.

The **vite example** (`example/`, `npm run dev`) remains the visual check (placement,
smoothness, colors, hover).
