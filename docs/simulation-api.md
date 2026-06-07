# SimulationAPI (`simulation` service)

The high-level, BPMN-shaped surface for driving token flow. It **composes** the low-level
[`animation`](animation-api.md) service into a small vocabulary and owns the bookkeeping that
lets you address tokens by readable `(node, label)` names — so the host never computes
`stackIndices` or builds selectors.

```javascript
const simulation = viewer.get('simulation');
```

SimulationAPI is **driven by a simulation engine's token log**: the host calls these functions
as the engine reports movements. The library decides *how* each node type animates — never
*when*. It is the sole writer of tokens and resets on `diagram.clear` / `diagram.destroy`.

## The token model

- A token is addressed by **`(node, label)`**, where **`label` is the instance id** (e.g.
  `"Instance_1#1"`, `"order-42"`). A node id plus an instance label is enough to find the
  token and its membership.
- Tokens form **one tree per process instance**. The process/participant `createToken` is the
  **root**; every token created inside that instance (a start-event child, a fork branch) is a
  descendant. `consumeToken` on a token cascades to its whole subtree — so terminating an
  instance is one call on its root.
- **Color is per instance.** A new instance gets a fresh
  [`getDistinctColor`](animation-api.md#colors); a **child inherits its parent's color**.

## Lifecycle positions

Within an activity/container a token sweeps **left → right across the top edge** through five
named positions; events and gateways use a single **center** point. You name the target;
`advanceToken` glides through every skipped intermediate so the path is shown.

| position | where (activity) |
| --- | --- |
| `ready` | above the top-left corner (outside) |
| `entry` | inside, top-left |
| `busy` | inside, top-center |
| `completed` | inside, top-right |
| `exit` | above the top-right corner (outside) |
| `center` | events & gateways — the symbol center (one point for the whole lifecycle) |

These names are **prescribed**, not configurable. What each *means* in your engine (arrived /
entered / running / done) is your convention.

## API

### `createToken({ node, label, bounce? })` → `token`

Create a token. Three cases, by node kind:

- **Process / Participant** — start a new instance: bump the node's instance stack and create
  the **root** token at `ready` with a fresh distinct color. For a pool-less `bpmn:Process`
  this also draws the [implicit process box](animation-api.md#implicit-process-box).
- **Start event** of a Process / SubProcess (not an event sub-process) — create a **child** of
  the token at the enclosing scope, with the **same label** and color, at `center`.
- **Boundary event** — create a **child** of the token at the **attached activity**, cloned
  from it (same label/color), at `center`. See [Boundary events](#boundary-events) below.

```javascript
simulation.createToken({ node: 'Process_1', label: 'order-42' });      // instance root
simulation.createToken({ node: 'StartEvent_1', label: 'order-42' });   // its child at the start event
```

Throws if a token `(node, label)` already exists, or the scope/host has no token of that label.

### Boundary events

`createToken({ node: boundaryEvent, label })` attaches a **listener token** as a child of the
token at the boundary's host activity. Its lifecycle rides the parent-child tree — no bespoke
cleanup:

- **Non-interrupting** (or a listener that never triggers) — the host stays; the listener is just
  a child, **shed automatically when the activity departs** (invariant W1: a departing token sheds
  its children) or is consumed.
- **Interrupting** — the fire is two existing calls. `advanceToken` the boundary token onto its
  outflow — a departing boundary token **auto-reparents to the enclosing scope**, leaving the
  activity's subtree — then `consumeToken` the (interrupted) activity. The boundary token survives
  and continues.

```javascript
// while the activity is busy, a boundary listener arms
simulation.createToken({ node: 'BoundaryEvent_1', label: 'order-42' });

// interrupting fire:
await simulation.advanceToken({ node: 'BoundaryEvent_1', label: 'order-42', sequenceFlow: 'Flow_err' });
await simulation.consumeToken({ node: 'Activity_1', label: 'order-42' }); // the listener token lives on
```

The interrupting/non-interrupting distinction is the **host's** to act on (the library exposes it
via `classify(element).interrupting`); both kinds spawn the same way.

### `advanceToken({ node, label, sequenceFlow?, position?, bounce? })` → `Promise<token>`

One verb, three forms — chosen by which argument you pass:

- **Along a flow** (`sequenceFlow`) — move the token onto that connected flow and travel it to
  the far node, where it comes to rest **on the same flow**. Advance it again to settle it into
  the node. The flow may be **outgoing** (forward) or **incoming** (reverse / rewind).
- **Into a center node** (no `position`, on an event or pass-through gateway — exclusive, or any
  gateway with a single incoming flow) — anchor the token at the symbol **center**, taking it
  off whatever flow it rested on.
- **Within an activity/container** (`position` — a sweep value) — glide from the token's current
  position to the target, **through every skipped intermediate**. Forward-only. `bounce` applies
  at the target.

```javascript
await simulation.advanceToken({ node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'entry' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'completed', bounce: false });
await simulation.advanceToken({ node: 'EndEvent_1', label: 'order-42' }); // center-anchor
```

### `forkToken({ node, label, sequenceFlow })` → `Promise<token>`

Split a thread at a **diverging** gateway — call once per chosen outgoing flow. All branches
carry the **same instance label** (they rejoin at `joinTokens`). `forkToken` only **places** a
branch *on* the outflow (no travel), so the remaining outflows can be forked too; call
`advanceToken({ sequenceFlow })` afterwards to travel each branch onward. The **first** fork
moves the original onto its flow; **later** forks clone onto theirs.

```javascript
await simulation.forkToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_a' });
await simulation.forkToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_b' });
await simulation.advanceToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_a' });
await simulation.advanceToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_b' });
```

### `joinTokens({ node, label })` → `Promise<token>`

The inverse of `forkToken`: at a **converging** gateway, collapse the branches of `label`
resting on its incoming flows into one token anchored at the gateway **center** (same color /
membership, inheriting any children). Carry it onward with `advanceToken`.

> A converging *exclusive* gateway is an uncontrolled merge, not a join — there each token just
> passes through with `advanceToken` (center-anchor).

### `consumeToken({ node, label })` → `Promise<token[]>`

Remove the **anchored** target token **and its whole subtree** (descendants on flows included).
Resolves with the removed tokens. If the target sits at a **stacked host** (a process /
participant root, or a multi-instance activity instance), the host's instance stack is
decremented — consuming the last process instance removes its box.

The target must be *anchored*; a token in transit on a flow can't be consumed directly (anchor
it first), though descendants on flows **are** torn down by the cascade. Terminating an instance
is `consumeToken` on its root.

### `autoFocus(on = true)`

When on, every call that touches a token **reveals that token's instance** — bringing it to the
front of its stack(s) (animated, via [`moveToFront`](animation-api.md#instance-stacks)) so the
just-touched token is the one on screen. Off by default; global.

### Lookups

| Method | Returns |
| --- | --- |
| `getToken(node, label, sequenceFlow?)` | the token at `(node, label)` — optionally the branch on `sequenceFlow` — or `undefined` |
| `getTokens(node, label)` | every token of instance `label` at `node` (0, 1, or several branches) |
| `getEntry(node, label, sequenceFlow?)` | the internal bookkeeping record (prefer `getToken`) |
| `getChildren(token)` | the token's child tokens (one tree per instance) |

### `clear()`

Reset all simulation state and clear the underlying animation.

## Status

Built and tested today: `createToken` (process / participant / start event / **boundary event**),
`advanceToken` (flow travel / center-anchor / activity sweep), `forkToken` / `joinTokens`,
`consumeToken` (subtree cascade + process stack-decrement), `autoFocus`, and the lookups. Most
node types are covered by composing these (end events = advance-center + consume; tasks = activity
sweep with `bounce`; start = createToken; boundary = createToken + the fire choreography above).

Not yet built: multi-instance fan-out/fan-in, event sub-processes, expanded sub-process entry, and
the prescribed icon cues (throw/catch, send/receive). For those — and for full manual control —
drop down to the [`animation`](animation-api.md) service.
