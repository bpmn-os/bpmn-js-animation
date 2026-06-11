# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-11

A large, breaking release. The execution-log format and the module layout both changed. A log recorded
with 0.1.0 will not replay; re-record it.

### Changed

- The animation API (`AnimationModule`) is now the default export. The simulator and animator are opt-in
  (`SimulatorModule`, `AnimatorModule`), and each one includes the animation API.
- The execution log now holds only the five token-flow verbs (`createToken`, `advanceToken`,
  `forkToken`, `joinTokens`, `consumeToken`). Everything else is derived on replay from the BPMN model:
  a node's icon, an interrupting boundary or event-sub cancel, an event-based gateway's losing branches,
  and the cleanup of boundary listeners and event-sub waiters that never fire. A `consumeToken` is now
  only a token reaching its own end. A link event is a `consumeToken` at the throw plus a `createToken`
  at the matching catch.
- Renamed "event log" to "execution log" (`lib/eventLog.js` became `lib/executionLog.js`, and the guide
  is now `docs/execution-log.md`).
- Each run starts the token-color cycle at a random offset, so playback no longer always begins with the
  same color.

### Removed

- From the public API: `jumpToken`, `moveToken`, and `departToken`.
- From the recorded format: `throwIcon`, `catchIcon`, `playTokenEffect`, and the `effect` and `selector`
  fields. These methods remain on the lower-level `primitives` service; they are simply no longer
  recorded log actions.

### Fixed

- A non-interrupting event sub-process firing keeps focus instead of scrolling to its re-armed waiter and
  back.
- A hidden (back-stack) instance's token jumps to its new position instead of flashing a glide graphic
  over the visible instance.

### Documentation

- Rewrote the README and the guides in plainer language, and consolidated the format, recording, and
  replay documentation into `docs/execution-log.md`.

## [0.1.0] - 2026-06-10

- Initial release. Token animation for bpmn-js: the high-level `animation` API, the low-level
  `primitives` layer, an interactive `simulator` that records runs, and an `animator` that replays an
  execution log.

[0.2.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bpmn-os/bpmn-js-animation/releases/tag/v0.1.0
