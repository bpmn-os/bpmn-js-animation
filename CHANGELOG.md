# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-11

### Changed

- The animation API (`AnimationModule`) is now the default export. The interactive simulator and the
  animator are opt-in modules, `SimulatorModule` and `AnimatorModule`, and each one includes the
  animation API, so you add only the module you need.
- Renamed the recording format from "event log" to "execution log". The internal module
  `lib/eventLog.js` is now `lib/executionLog.js`, and the guide is now `docs/execution-log.md`.

### Removed

- Removed `jumpToken` from the `animation` service and `moveToken` from `primitives`. A link event is
  now an ordinary `consumeToken` at the throw followed by `createToken` at the matching catch, and
  `createToken` now accepts a link catch event.
- Removed `playTokenEffect`, and the `effect` and `selector` fields, from the execution-log format. The
  `playTokenEffect` method remains on the `animation` and `primitives` services; it is simply no longer
  a recorded log action.
- Removed `departToken`. An interrupting boundary event now fires with a single `advanceToken` along its
  outflow, which cancels the host activity and its whole subtree (the listener and the activity's
  contents, an MI activity's instances included) and continues a fresh token. The reparenting that let a
  boundary token survive the cancel is gone, because the continuing token is created fresh in the
  enclosing scope. A non-interrupting boundary keeps its listener armed and sends a fresh token.
- Removed `throwIcon` and `catchIcon` from the execution-log format and the `animation` service. A
  node's own icon is now flown automatically by `advanceToken` from the node type: a throw or end event,
  or a send task, flies its symbol out; a catch event, a typed start event, a boundary, or a receive
  task flies it in. The recorded format is therefore exactly the five token-flow verbs (`createToken`,
  `advanceToken`, `forkToken`, `joinTokens`, `consumeToken`); everything visual is derived on replay.
  The `throwIcon` / `catchIcon` methods remain on the low-level `primitives` service.

### Documentation

- Rewrote the README and the guides in plainer language.
- Consolidated the format, recording, and replay documentation into `docs/execution-log.md`, and
  removed the separate animator guide.

## [0.1.0] - 2026-06-10

- Initial release. Token animation for bpmn-js: the high-level `animation` API, the low-level
  `primitives` layer, an interactive `simulator` that records runs, and an `animator` that replays an
  execution log.

[0.2.0]: https://github.com/bpmn-os/bpmn-js-animation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bpmn-os/bpmn-js-animation/releases/tag/v0.1.0
