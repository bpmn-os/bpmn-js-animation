# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.6.1] - 2026-07-13

### Fixed

- The resting-token count overlay now sits above the bpmnlint issue markers, so its count stays visible where a marker overlaps the node.

## [0.6.0] - 2026-07-01

### Added

- The Tokens panel marks **actionable** tokens by animating their row dot with the same cue as the canvas: **bounce** (waiting for a double-click to advance) and **pulse-pause** (a decision to pick / spawn first). Other tokens stay still, so the list reads as a to-do surface. Works in both the "all" and "selected" views.

## [0.5.1] - 2026-07-01

### Fixed

- The Tokens panel now updates the selected-token highlight when the selection changes **on the canvas** (or anywhere else), not only when selecting from the panel. Previously the "all" / at-node rows kept a stale highlight because only the "Selected tokens" list was reconciled on `token.selection.changed`.

## [0.5.0] - 2026-06-30

Token-panel usability: start instances by name, in-panel usage hints, and a host model-mode note.

### Added

- **Instantiate process** group in the Tokens panel (Simulate mode): pick a process and spawn an instance by name with a ✓ button — repeat it to start several. The name is pre-filled with the next free `<process>°k`, and the group auto-expands as a call-to-action while there are no tokens. (Double-clicking a process start event still spawns an instance.)
- In-panel **usage hints** for the double-click gestures, plus a footer note on (shift-)double-clicking instance stacks. The hints auto-hide when the token list needs the space and return on refresh / clear / mode switch.
- `config.tokenPanel.modelNote` — an HTML string or element shown in the Tokens panel in **model** mode (e.g. a host call-to-action pointing at its mode controls).

### Changed

- Instance labels now use a degree sign: `<process>°k` (was `<process>_k`), which reads more clearly against modeller ids such as `Process_1`. Multi-instance sub-instances (`#k`) and event-subprocess firings are unchanged.

## [0.4.0] - 2026-06-29

Adds a mode controller so the same package works in a **modeller** that toggles between editing and simulation, not only a viewer.

### Changed

- Renamed `SimulationPanelModule` → `TokenPanelModule` (service `simulationPanel` → `tokenPanel`, config `config.tokenPanel`); the side-panel tab is now labelled **"Tokens"** (configurable via `config.tokenPanel.label`). The token inspector is mode-agnostic (used by both simulate and playback), so "Tokens" fits better than "Simulation".
- Fixed completion detection for a process whose only token is its start event (e.g. a lone start event with no outflow): the process now completes instead of hanging. A process/sub-process's **own** start event is no longer mistaken for an armed event-sub-process waiter.
- The implicit-process box now repositions the process token's overlay container directly when it (re)sets the root's bounds, so the token tracks pans / mode round-trips instead of lagging at a stale position (without firing `element.changed` for the root, which would draw a spurious selection outline and mis-route clicks inside the box).
- Multi-instance completion no longer requires an outgoing flow: an MI activity that is the **last node** (implicit end) — or an **ad-hoc child** — now completes (its outer/parent token is consumed) once the last sub-instance finishes, instead of throwing. The fan-in un-parks the parent to the activity's completion position and the host consumes it.
- The **Tokens** panel inspector is now a `Tokens` view filter (radio): **all** lists every token; **selected** lists the selected token(s) **plus** the tokens at the selected node(s). Purely a display switch — it never changes the selection.
- Standard-loop activities can now be **left without selecting an outflow**: at completion the loop marker is a clickable loop/exit toggle (black = loop again, dimmed = leave). Click an outflow to leave via it, or click the marker to leave with no pick — including a loop with **no outgoing flow** (implicit end), which now completes. Previously a loop could only be left by selecting an outflow, so an implicit-end loop was inescapable.
- Moving tokens now render in a **dedicated SVG layer above diagram-js's overlay container**, so a gliding token paints **above** HTML overlays such as bpmn-js-bpmnlint issue markers (which stay visible) — matching the resting tokens. The layer mirrors the canvas viewport transform (pan / zoom) and is **plane-aware**: only the active drill plane's moving tokens are shown.
- Fixed a stray selection box: the implicit-process selection outline is now **cleared when its process box is removed** (e.g. at instance completion), instead of lingering and being repainted at the root's restored, bounds-less coordinates.

### Added

- **Ad-hoc multi-instance**: an MI activity used as an ad-hoc child with **no incoming flow** is seeded with its outer/main token at the new `Position.ARRIVAL` (the node's left-edge centre); double-clicking it spawns sub-instances, exactly like the outer token resting on an incoming flow. The arrival token renders small and stays put (visible, not riding the scroll) while its sub-instances stack the node (a shared `_ownNodeExempt` rule, the same exemption flow tokens get).
- `setLoopMarkerDimmed(node, dimmed)` and `setLoopToggleEnabled(node, on)` (on `primitives`, with `animation` pass-throughs) — dim a standard-loop activity's loop marker and lay a clickable hit area over it (fires `loop.marker.click`), used for the loop/exit toggle above.

- `ModeModule` — an opt-in `mode` service with one switch, `setMode('model' | 'simulate' | 'playback')` (+ `getMode()`, a `mode.changed` event). One call turns the modeller's **editing off** outside `model`, the **simulator on** only in `simulate` (with a fresh recording), clears the tokens on every switch, toggles the `.bts-simulation` view + hides the palette, and — when modeller services are present — makes the canvas read-only (a folded-in port of bpmn-js-token-simulation's `DisableModeling`). Viewer-safe: it only touches modeller services (`directEditing`/`dragging`/`modeling`/`editorActions`/`palette`/`contextPad`) when they exist. The host renders the control (toolbar toggle / on-canvas buttons) and calls `setMode`.
- `simulator.setActive(active)` / `simulator.isActive()` — gate the simulator's reaction to user gestures (double-click to spawn/advance, gateway/flow picks). Default **on**, so existing viewers are unchanged; the `mode` controller turns it off outside `simulate`. `config.simulator.active` sets the initial value.

## [0.3.1] - 2026-06-29

### Changed

- Boundary-event avoidance now repositions the activity sweep horizontally instead of dropping it. The entry/busy/completion stops are laid out together so each stays clear of the boundary symbols while still advancing left to right. The sweep prefers the top edge, moves to the bottom edge when the top cannot hold it, and only falls back to dropping the row when neither edge fits. This also applies to multi-instance activities.

### Fixed

- In the `collaboration` example log, each machine-process event sub-process waiter is now armed when its instance starts, instead of after the token reaches the conditional event.

## [0.3.0] - 2026-06-28

Adds a simulation side panel and reusable playback controls, and standardises token instance naming to match the engine.

### Added

- `SimulationPanelModule` — an opt-in "Simulation" side-panel tab (built on `bpmn-js-side-panel`) that inspects the selected token(s) and the tokens at the selected node(s). Click a listed token to bring its stack to the front and select it; double-click to advance it. When nothing is selected it lists **all** tokens. The tab also hosts the controls: run/pause + animation speed (Playback), save/load execution log, refresh, and an auto-focus toggle. The panel is purely incremental (one DOM update per token event, never a rebuild) and works with or without a side panel.
- `PlaybackModule` — a reusable playback controller (`play`/`pause`/`resume`/`stop`/`toggle`, `getState`, a `playback.changed` event) extracted from the demo's replay loop.
- `animation.reveal(token)` — bring a token's stack(s) to the front across all its stacked ancestors.
- Opt-in node-selection frame for the simulator/panel (`config.simulator.nodeSelection` / `config.simulationPanel.nodeSelection`), including the implicit-process box; the implicit process can be multi-selected with other nodes.
- Precise token events from `primitives` for incremental UIs: `token.added` / `token.removed` / `token.updated` / `token.moved` / `token.selection.changed`, plus `stack.changed` when the visible stack instance flips.

### Changed

- The simulator labels instances `<processId>_k` (the process id with a per-process counter) instead of a global `I<k>`; multi-instance sub-instances are `<parent>#k` and event-subprocess firings `<scope>^<eventSubProcessId>#k` (the parent label for interrupting starts), matching the engine. The bundled example models and execution logs were updated accordingly.
- A token merge at a converging gateway (`joinTokens`) now preserves the branches' selection.
- A token click on the canvas no longer also selects the node beneath it.

## [0.2.0] - 2026-06-11

A large spring clean, breaking release. The execution-log format and the module layout both changed. A log recorded with 0.1.0 will not replay; re-record it.

### Changed

- The animation API (`AnimationModule`) is now the default export. The simulator and animator are opt-in (`SimulatorModule`, `AnimatorModule`), and each one includes the animation API.
- The execution log now records `createToken`, `advanceToken`, `forkToken`, `joinTokens`, `consumeToken`. Everything else is derived on replay from the BPMN model.

## [0.1.0] - 2026-06-10

- Initial release. Token animation for bpmn-js: the high-level `animation` API, the low-level `primitives` layer, an interactive `simulator` that records runs, and an `animator` that replays an execution log.

[0.6.1]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bpmn-os/bpmn-js-animation/releases/tag/v0.1.0
