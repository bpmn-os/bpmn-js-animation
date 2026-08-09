import SelectionModule from 'diagram-js/lib/features/selection';
import OutlineModule from 'diagram-js/lib/features/outline';
import RulesModule from 'diagram-js/lib/features/rules';

import Primitives from './primitives';
import Animation from './animation';
import Simulator from './Simulator';
import Animator from './Animator';
import Playback from './Playback';
import TokenPanel from './TokenPanel';
import Mode from './Mode';
import ModeRules from './ModeRules';

/**
 * bpmn-js additionalModule — the **enabling API** and the **default export**: `primitives` +
 * `animation`, the bare vocabulary a host drives tokens with, **without either tool**. Add this when
 * you animate process execution programmatically (e.g. from your own engine); the two tools below are
 * **opt-in** (each pulls this module in via `__depends__`).
 *
 *  - `primitives` — the low-level visual layer (createToken / sendToken / setState / removeToken /
 *    setStacks / moveToFront / scrollStack / throwIcon / playTokenEffect / drillTo / …).
 *  - `animation`  — the high-level, BPMN-shaped **enabling API** composed over it (the supported
 *    surface for hosts driving tokens programmatically: createToken / advanceToken / forkToken /
 *    joinTokens / consumeToken / …). Pure vocabulary — record/replay live in the tools below.
 *
 * Integrated like `bpmn-js-token-simulation` (add to `additionalModules`, import
 * `assets/animation.css`). Depends on the documented diagram-js `selection` + `outline` features
 * so native selection (and our stack-aware OutlineProvider) work even in a bare viewer — keeping the
 * bpmn-js ecosystem compatible.
 */
export const AnimationModule = {
  __depends__: [ SelectionModule, OutlineModule ],
  __init__: [ 'primitives', 'animation' ],
  primitives: [ 'type', Primitives ],
  animation: [ 'type', Animation ]
};

export default AnimationModule;

/**
 * Opt-in **interactive simulator** tool — adds the `simulator` service to the enabling API (pulled in
 * via `__depends__`): an opinionated, double-click-driven BPMN token simulator that needs no host code,
 * and **owns recording** (`startRecording` / `getRecording` — the log it produces replays through the
 * `animator`). Add alongside `AnimatorModule` for both tools.
 */
export const SimulatorModule = {
  __depends__: [ AnimationModule ],
  __init__: [ 'simulator' ],
  simulator: [ 'type', Simulator ]
};

/**
 * Opt-in **playback** tool — adds the `animator` service to the enabling API (pulled in via
 * `__depends__`): the mirror of the simulator, it **owns replay** (`animator.replay(log)`), turning a
 * recorded execution log back into animated token flow. This is the package's headline use case — animating
 * an execution log.
 */
export const AnimatorModule = {
  __depends__: [ AnimationModule ],
  __init__: [ 'animator' ],
  animator: [ 'type', Animator ]
};

/**
 * Opt-in **playback controller** — adds the `playback` service: a small run/pause/resume/stop state
 * machine around `animator.replay`, firing `playback.changed` so UI can stay in sync. Pulls in the
 * `animator` via `__depends__`.
 */
export const PlaybackModule = {
  __depends__: [ AnimatorModule ],
  __init__: [ 'playback' ],
  playback: [ 'type', Playback ]
};

/**
 * Opt-in **Token panel** — adds a "Tokens" tab to a `bpmn-js-side-panel` (if one is present):
 * selected-token / tokens-at-node inspector (click a token to bring its stack to the front), plus
 * run/pause, auto-focus, speed and execution-log save/load. No-ops without a side panel, so it stays
 * optional for the host. Pulls in the `playback` controller via `__depends__`. Tab label is
 * configurable via `config.tokenPanel.label` (default "Tokens").
 */
export const TokenPanelModule = {
  __depends__: [ PlaybackModule ],
  __init__: [ 'tokenPanel' ],
  tokenPanel: [ 'type', TokenPanel ]
};

/**
 * Opt-in **mode controller** — adds the `mode` service: one switch,
 * `mode.setMode('model'|'simulate'|'playback')`, that turns the **modeller's editing** off outside
 * `model`, the **simulator** on only in `simulate` (fresh recording), clears tokens on every switch,
 * toggles the `.bts-simulation` view + palette, and fires `mode.changed`. Viewer-safe — it only touches
 * modeller services (directEditing / dragging / modeling / editorActions / palette) when present, so a
 * modeller becomes read-only during simulation/playback while a viewer just gets the simulation gating.
 * The host renders a control (toolbar toggle / on-canvas buttons) that calls `setMode`.
 */
export const ModeModule = {
  __depends__: [ AnimationModule, RulesModule ],
  __init__: [ 'mode', 'modeRules' ],
  mode: [ 'type', Mode ],
  modeRules: [ 'type', ModeRules ]
};

// color helpers — call to obtain a color, then pass it to createToken. Both wrap the
// `randomcolor` library (token-simulation's scheme); getDistinctColor cycles a fixed,
// contrast-filtered palette. Children inherit the parent's color (no "related" ring).
export { getRandomColor, getDistinctColor } from './color';

// Reusable token-UI factories (plain DOM, built on bpmn-js-side-panel). A consumer composes its own
// Tokens panel from these instead of taking the packaged TokenPanel: a keyed live list of token
// entries, one token entry, and the run/pause + speed transport. See each file for its API.
export { default as createTokenEntry } from './TokenEntry';
export { default as createTokenList } from './TokenList';
export { default as createPlaybackControlsEntry } from './PlaybackControlsEntry';

// The controls a run is driven by, as one entry: the transport with the speed beside it, and the three that
// act on the run as a whole. The Tokens tab draws one at its foot unless the host says `controls: false`,
// which is what a host does when it keeps what governs the whole panel somewhere of its own.
export { default as createControlsEntry } from './ControlsEntry';

// The glyph for auto-focus, which this package owns as a setting and draws no control for: a host puts the
// control where its own furniture over the canvas goes, and takes the glyph from here so that two hosts
// agree. See `animator.autoFocus`, `animator.getAutoFocus` and the `autoFocus.changed` event.
export { AUTO_FOCUS_ICON } from './icons';
