/**
 * executionLog — the **execution-log format** shared by the two tools that produce and consume it: the
 * `simulator` (which **records** the BPMN events it drives — see `Simulator`) and the `animator`
 * (which **replays** a log — see `Animator`). The two are otherwise independent; this module is the
 * one thing they agree on.
 *
 * A log is plain, serialisable data — an array of flat, self-describing **event objects**
 * `{ action, ...fields }`, where `action` is an `animation` method name and the fields are the keys of
 * its single object argument. The recorded methods are the semantic token-flow operations an execution
 * engine emits: `createToken` / `advanceToken` / `forkToken` / `joinTokens` / `consumeToken`. Everything
 * else is **derived** on replay — the icon a node flies, the cancel an interrupting boundary does, the
 * instance to show — so it is **not** recorded (nor is view navigation or focus). A replay works it out
 * from the events themselves (run it with `autoFocus` on), so the log is a clean execution log.
 */

export const RECORDED_METHODS = [
  'createToken', 'advanceToken', 'forkToken', 'joinTokens', 'consumeToken'
];

// Normalise a recorded call to a flat `{ action, ...fields }` object — the self-descriptive log entry.
// Each recorded method takes a single `{ node, label, … }` argument whose keys are already the fields.
export function describeEvent(method, args) {
  return JSON.parse(JSON.stringify({ action: method, ...args[0] })); // serialisable; drops `undefined`
}

// Rebuild a method call from a flat `{ action, ...fields }` entry, the inverse of `describeEvent`.
// `api` is the `animation` service the event is re-issued against.
export function eventCall(api, entry) {
  const { action, ...fields } = entry;
  return api[action](fields);
}

// Replay scheduling policy: should replay start this event **immediately** (concurrently with
// whatever is still animating), rather than waiting for all previously-started animations to finish?
// True only for a token **travelling out along a flow** (`advanceToken` with a `sequenceFlow`) — the
// departure the user sees: a diverging gateway's branches then leave **together** instead of
// one-after-another (each branch was already placed on its outflow by a prior `forkToken`, so its input
// is settled). Everything else stays a **wait** event (drains all outstanding first), which keeps the
// rule safe and self-correcting:
//   - an **arrival/settle** (`advanceToken` to a position/center, `joinTokens`, `consumeToken`, link/icon
//     ops) must see a fully-landed diagram;
//   - `forkToken` reads the token resting **at** the gateway, and `createToken` for a multi-instance
//     sub-instance reads the outer token resting on the **incoming flow** — both depend on a prior
//     travel having *landed*, which it has not until awaited (a travel's landed token is registered only
//     when its animation resolves). (Concurrent *spawns* gain nothing visually anyway — instances stack,
//     so only the front one renders; the one visible concurrency is same-plane gateway branches.)
export function startsImmediately(event) {
  return event.action === 'advanceToken' && event.sequenceFlow != null;
}
