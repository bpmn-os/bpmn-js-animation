/**
 * eventLog — the **event-log format** shared by the two tools that produce and consume it: the
 * `simulator` (which **records** the BPMN events it drives — see `Simulator`) and the `animator`
 * (which **replays** a log — see `Animator`). The two are otherwise independent; this module is the
 * one thing they agree on.
 *
 * A log is plain, serialisable data — an array of flat, self-describing **event objects**
 * `{ action, ...fields }`, where `action` is a `simulation` method name and the fields are its named
 * arguments. The recorded methods are the semantic token-flow operations an execution engine emits
 * (`createToken` / `advanceToken` / `forkToken` / `joinTokens` / `consumeToken`, plus the positional
 * ones below). View-navigation (`moveToFront` / `scrollStack`) and focus settings (`autoFocus` /
 * `setFocusContext`) are deliberately **not** recorded — a replay derives which instance to show from
 * the events themselves (run it with `autoFocus` on), so the log is a clean event log, not a
 * transcript of how a user scrolled.
 */

// The **positional** recorded methods, with names for their args — so a call is logged as a flat,
// self-descriptive object (`{ action, node, label, … }`) rather than positional data. The object-arg
// methods below carry a single `{ node, label, … }` argument whose keys are already the field names.
export const POSITIONAL_FIELDS = {
  jumpToken: [ 'fromNode', 'label', 'toNode' ],
  departToken: [ 'node', 'label', 'sequenceFlow' ],
  throwIcon: [ 'node', 'label', 'selector' ],
  catchIcon: [ 'node', 'label', 'selector' ],
  playTokenEffect: [ 'node', 'label', 'effect', 'selector' ]
};

export const RECORDED_METHODS = [
  // object-arg: createToken/advanceToken/forkToken/joinTokens/consumeToken (logged as `{ action, ...arg }`)
  'createToken', 'advanceToken', 'forkToken', 'joinTokens', 'consumeToken',
  // positional (named via POSITIONAL_FIELDS)
  ...Object.keys(POSITIONAL_FIELDS)
];

// Normalise a recorded call to a flat `{ action, ...fields }` object — the self-descriptive log entry.
export function describeEvent(method, args) {
  const names = POSITIONAL_FIELDS[method];
  const entry = { action: method };
  if (names) {
    names.forEach((name, i) => { if (args[i] !== undefined) entry[name] = args[i]; });
  } else {
    Object.assign(entry, args[0]); // object-arg: the argument's keys are the field names
  }
  return JSON.parse(JSON.stringify(entry)); // plain, serialisable data (drops `undefined`)
}

// Rebuild a method call from a flat `{ action, ...fields }` entry, the inverse of `describeEvent`.
// `api` is the `simulation` service the event is re-issued against.
export function eventCall(api, entry) {
  const { action, ...fields } = entry;
  const names = POSITIONAL_FIELDS[action];
  return names ? api[action](...names.map(k => fields[k])) : api[action](fields);
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
