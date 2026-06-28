# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses [Semantic Versioning](https://semver.org/).

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

[0.3.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bpmn-os/bpmn-js-animation/releases/tag/v0.1.0
