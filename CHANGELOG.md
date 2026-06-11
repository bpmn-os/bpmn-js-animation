# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-11

A large spring clean, breaking release. The execution-log format and the module layout both changed. A log recorded with 0.1.0 will not replay; re-record it.

### Changed

- The animation API (`AnimationModule`) is now the default export. The simulator and animator are opt-in (`SimulatorModule`, `AnimatorModule`), and each one includes the animation API.
- The execution log now records `createToken`, `advanceToken`, `forkToken`, `joinTokens`, `consumeToken`. Everything else is derived on replay from the BPMN model.

## [0.1.0] - 2026-06-10

- Initial release. Token animation for bpmn-js: the high-level `animation` API, the low-level `primitives` layer, an interactive `simulator` that records runs, and an `animator` that replays an execution log.

[0.2.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bpmn-os/bpmn-js-animation/releases/tag/v0.1.0
