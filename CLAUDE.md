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
  - **Token** = `{ node, label, color }`. Identity is the `(node, label)` pair;
    `color` is any CSS color string (applied directly — no parsing).
  - State maps: `_tokens` (`"node|label" -> Token`), `_nodeTokens`
    (`node -> Set<Token>`, render set), `_nodeOverlays` (`node -> overlayId`),
    `_activeAnimations` (`Token -> animation`).
  - **API:** `createToken(node,label,color)`, `sendToken([{node,label,flow},…])`
    → `Promise<Token[]>`, `removeToken(node,label)`, `getTokens(filter?)`,
    `clear`, `setDuration`.
  - **`sendToken(transitions)`** takes `[{node,label,flow},…]`. It resolves all transitions first
    (an invalid one rejects with no side effects), groups them by source `(node,label)`
    so a shared source is **consumed once and forks** (split), then for each flow
    spawns a **branch**. Different sources whose flows land on one node **merge**
    (join — via the `_addToNode`/replace dedupe). `_resolveFlow` accepts a flow that is
    **outgoing** from the node (forward → target, waypoints as-is) or **incoming**
    (reverse → source, waypoints reversed — e.g. rewinding); the animator is handed
    `{ waypoints }` so direction is just the order. Branches keep the source's
    `label`+`color`. Identity is committed **optimistically at depart** (the branch is
    registered in `_tokens` at its destination immediately, so it's addressable
    there during the cosmetic flight); the resting badge is added on landing.
  - **Replace/join invariant:** one token per `(node, label)`. `createToken` on an
    occupied pair replaces; a `sendToken` landing on an occupied pair replaces
    (`_addToNode`/`_removeFromNode` dedupe by `label`). This is how joins collapse.
  - **Fast events:** `sendToken` calls `_settle(token)` first — if the token is
    mid-flight it `finish()`es immediately (lands now). So rapid sends never overlap.
    There is no public "settle"/"arrive" call — settling is internal.
  - **Rendering:** one overlay per node (`overlays.add`, `bts-token-count`) holding a
    `.bts-token-count` dot per token (`background: color`, `title = label` for hover,
    `data-label`/`data-node-id`). Capped at `config.tokenAnimation.maxVisible`
    (default 3); beyond `max+1`, shows `max` dots + a `.bts-overflow` `+N` marker. A
    delegated click fires `token.click {node,label}` (a dot) or
    `token.overflow.click {node,hidden}` (the marker).
- **`animation`** (`lib/Animation.js`) — the low-level animator, **vendored from
  bpmn-js-token-simulation** with the engine coupling removed (no `scopeFilter`,
  no simulator/scope events). Moves an SVG dot along `connection.waypoints` with
  per-segment easing. Inputs it needs: a `tokenLike = { color, element: connection }`
  and a connection with waypoints; `element` only resolves the canvas plane.
  - Local changes vs. the upstream copy (preserve when syncing fixes): the total
    duration is a **fixed** value (`config.tokenAnimation.duration`, default 1000ms,
    or `setDuration()`), **not** the upstream geometry-derived `Math.log(length)*…`
    — segment timings are still distributed by length so speed is steady, but a long
    and a short flow take the same total time. Plus a `finish()` fast-forward and a
    `_done` guard in `completed()`. The token graphic is a plain colored circle
    (`token.color`); no label text (labels are hover-only on resting badges).

### Key invariants
- **`(node, label)` is unique.** Element ids are unique within a diagram, so no
  process id is needed; `label` distinguishes tokens sharing a node.
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
`tokenAnimation: { duration: 0 }` (instant landings, synchronous-ish) + `await`; the
auto-settle test uses a non-zero duration so a transition is genuinely in flight.

The **vite example** (`example/`, `npm run dev`) remains the visual check (placement,
smoothness, colors, hover).
