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
- **Homogeneous queue (FIFO).** When concurrent **same-instance** paths converge at one node (e.g. a
  non-interrupting boundary fired twice), the tokens sharing an identity form a **FIFO queue** —
  rendered as a stack of dots (a `+k` marker past `maxVisible`). `getEntry`/`getToken(node, label)`
  return the **head**, so a trigger/advance acts on the first-arrived. *Limitation:* queued tokens are
  interchangeable — no individual selection/targeting and no scrolling; advancing always takes the head.

## Lifecycle positions

Within an activity/container a token sweeps **left → right along the top edge** through three
named positions; events and gateways use a single **center** point. You name the target;
`advanceToken` glides through every skipped intermediate so the path is shown.

| position | where (activity) |
| --- | --- |
| `entry` | top-left corner (on the edge) |
| `busy` | top-center (on the edge) |
| `completion` | top-right corner (on the edge) |
| `center` | events & gateways — the symbol center (one point for the whole lifecycle) |

These names are **prescribed**, not configurable. What each *means* in your engine (arrived /
entered / running / done) is your convention.

## API

### `createToken({ node, label, animate? })` → `token`

Create a token. Four cases, by node kind:

- **Process / Participant** — start a new instance: bump the node's instance stack and create
  the **root** token at `entry` with a fresh distinct color. For a pool-less `bpmn:Process`
  this also draws the [implicit process box](animation-api.md#implicit-process-box).
- **Start event** of a Process / SubProcess (not an event sub-process) — create a **child** of
  the token at the enclosing scope, with the **same label** and color, at `center`.
- **Boundary event** — create a **child** of the token at the **attached activity**, cloned
  from it (same label/color), at `center`. See [Boundary events](#boundary-events) below.
- **MI activity** — create a **sub-instance** (`label` = the sub's id), a child of the outer
  thread token resting on the activity's incoming flow, **stacked** at the node and inheriting its
  color, at `entry`. See [MI activities](#mi-activities) below.
- **Event sub-process start event** — fire the event sub-process (`label` = the firing id): a
  child of the enclosing scope's on-screen instance token, **stacked** on the event-sub node and
  inheriting its color, at `center`. See [Event sub-processes](#event-sub-processes) below.

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

### MI activities

A multi-instance activity renders as a **stack of its own instances**. The outer thread's token
**arrives but never enters** — it rests on the activity's **incoming flow** (assume one in / one
out) — and from there fans out into *N* sub-instances:

- **Fan-out** — `createToken({ node: MIactivity, label: subLabel })` per sub: a child of the outer
  thread token, **stacked** at the node, inheriting its color, at `entry`.
- **Park / spawn window** — as soon as the **first** sub starts running (leaves `entry`), the outer thread
  token is **parked** (`state.hidden`, CSS-hidden) and **no more subs may be spawned** (further
  `createToken` is rejected). One color per instance; subs differ by stack position, not hue.
- **Run** each sub independently with `advanceToken({ node, label: subLabel, position })`.
- **Fan-in** — `consumeToken({ node, label: subLabel })` per sub (from `completion`). The decrement drops
  that sub's stack key; when the **last** sub is consumed, the parent is **un-parked onto the
  outgoing flow**, ready to travel.

```javascript
// outer thread "I1" rests on the MI activity's incoming flow (advanceToken'd there)
simulation.createToken({ node: 'MI_1', label: 'I1#1' });   // fan out
simulation.createToken({ node: 'MI_1', label: 'I1#2' });
await simulation.advanceToken({ node: 'MI_1', label: 'I1#1', position: 'busy' }); // sub runs → parks "I1", closes the window

// ... run each sub to completion, then collapse:
for (const sub of [ 'I1#1', 'I1#2' ]) {
  await simulation.advanceToken({ node: 'MI_1', label: sub, position: 'completion' });
  await simulation.consumeToken({ node: 'MI_1', label: sub });
}
// "I1" is now un-parked on the outgoing flow:
await simulation.advanceToken({ node: 'MI_1', label: 'I1', sequenceFlow: 'Flow_out' });
```

### Event sub-processes

An event sub-process is triggered by an **event** (no incoming flow), so its instances are created
**lazily** — a *firing* per trigger. Each firing is `createToken({ node: evtspStartEvent, label })`:
a child of the **enclosing scope's on-screen instance** token, **stacked** on the event-sub node
(key = the firing id), inheriting its color, at `center`.

- **Non-interrupting** firings **coexist** — they stack, so the event-sub box scrolls through
  concurrent firings; the enclosing scope keeps running.
- A firing's key is dropped when **its last token is consumed** — `consumeToken` does a
  surviving-token check (no remaining token carries that firing key → drop it). The enclosing scope
  is untouched.

```javascript
simulation.createToken({ node: 'Process_1', label: 'I1' });        // scope instance
simulation.createToken({ node: 'EvtStart_1', label: 'I1.e1' });    // firing 1 (stacked)
simulation.createToken({ node: 'EvtStart_1', label: 'I1.e2' });    // firing 2 (concurrent)
// run each firing's internal flow, then end it:
await simulation.consumeToken({ node: 'EvtStart_1', label: 'I1.e1' }); // drops the e1 firing key
```

> Interrupting event sub-processes (replace the parent scope's other tokens) are a follow-up; the
> built case is non-interrupting.

### `advanceToken({ node, label, sequenceFlow?, position?, animate? })` → `Promise<token>`

One verb, three forms — chosen by which argument you pass:

- **Along a flow** (`sequenceFlow`) — move the token onto that connected flow and travel it to
  the far node, where it comes to rest **on the same flow**. Advance it again to settle it into
  the node. The flow may be **outgoing** (forward) or **incoming** (reverse / rewind).
- **Into a center node** (no `position`, on an event or **any gateway**) — anchor the token at the
  symbol **center**, taking it off whatever flow it rested on. At a converging gateway this anchors
  a single arrived branch; [`joinTokens`](#jointokens-node-label--promisetoken) collapses several.
- **Within an activity/container** (`position` — a sweep value) — glide from the token's current
  position to the target, **through every skipped intermediate**. Forward-only. `animate` (a motion
  cue, e.g. `'bounce'`/`'pulse'`) applies at the target.

```javascript
await simulation.advanceToken({ node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'entry' });
await simulation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'completion', animate: 'pulse' });
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

### `consumeToken({ node, label, gesture? })` → `Promise<token[]>`

Remove the **anchored** target token **and its whole subtree** (descendants on flows included).
Resolves with the removed tokens. If the target sits at a **stacked host** (a process /
participant root, or a multi-instance activity instance), the host's instance stack is
decremented — consuming the last process instance removes its box.

The target must be *anchored*; a token in transit on a flow can't be consumed directly (anchor
it first), though descendants on flows **are** torn down by the cascade. Terminating an instance
is `consumeToken` on its root.

The **model removal is synchronous** — every token in the subtree is gone from the bookkeeping the
moment this is called (don't await it to observe the removal). Pass `gesture: true` to flip-fade each
removed dot on the way out: the whole subtree gestures **simultaneously** on **detached "ghost"
clones** that play out and self-remove independently of the model — so the gesture survives any
concurrent re-render. A **stacked** consume (a process root, an MI sub) **waits for the flip-fade to
finish before collapsing its container** — the implicit-process box / instance stack / `moveToBack`
arc all run after the dot has faded, so the box never vanishes out from under a still-fading dot.
The returned Promise resolves once that visual teardown is done.

### `autoFocus(on = true)`

When on, every call that touches a token **reveals that token's instance** — bringing it to the
front of its stack(s) (animated, via [`moveToFront`](animation-api.md#instance-stacks)) so the
just-touched token is the one on screen. Off by default; global. While a reveal arc is playing,
`advanceToken` **waits for it** before moving, so an advance never overlaps the reveal gesture.

### `setFocusContext(stackIndices | null)`

Scope `autoFocus` to a single **instance** — the one the host last interacted with. While set, a
token is brought to the front of a stacked node only when the context hasn't claimed that node for a
*different* instance (nodes the context doesn't mention still focus). So a burst of concurrently
auto-advancing instances — e.g. rapidly spawned process instances — no longer thrash which one is
shown; the last-interacted instance keeps the front. Pass `null` to clear (focus every touch again).

### `setCue(node, label, animate, selector?)`

Set a token's motion cue (`state.animate`) **without moving it** — e.g. `pulse-pause` while a
user picks an outflow, or `bounce-pause` for an MI parent idling on its flow. `animate` is an
effect name or `null` to clear. The optional `selector` (`{ sequenceFlow?, stackIndices? }`)
disambiguates a branch/instance; omit to use the single token there.

### `playTokenEffect(node, label, effect, selector?)` → `Promise`

Play a **one-shot** dot gesture on a resting token (delegates to [`animation.playTokenEffect`](animation-api.md))
— e.g. a `flip` when an event triggers, or a `fade-out` sequenced before `consumeToken`. Resolves
when the gesture ends.

### `setFlowDimmed(flowId, on = true)`

Dim / undim a **sequence flow** (semi-transparent line + arrowhead; reverts cleanly) — delegates to
[`animation.setFlowDimmed`](animation-api.md). Used to fade a diverging gateway's unchosen outflows
while the user picks. `clear` undims any left dimmed.

### `whenFocused()` → `Promise`

Resolves once any in-flight auto-focus **reveal arc** has settled (resolves immediately when nothing
is animating). Lets you sequence *after* the reveal — e.g. create a child token only once its
instance has scrolled to the front. `consumeToken` also plays the reveal arc in reverse
(`moveToBack`) when it drops a stacked instance, so the removed copy scrolls out.

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

Built and tested today: `createToken` (process / participant / start event / **boundary event** /
**MI activity** / **event-sub firing**), `advanceToken` (flow travel / center-anchor / activity
sweep), `forkToken` / `joinTokens`, `consumeToken` (subtree cascade + the **surviving-token**
stack-decrement covering process roots, MI subs, **and event-sub firings**), `autoFocus`, and the
lookups. Most node types are covered by composing these (end events = advance-center + consume;
tasks = activity sweep with an `animate` cue; start = createToken; boundary / MI / event-sub = createToken
+ the choreographies above).

Not yet built: **interrupting** event sub-processes, expanded sub-process entry, and the prescribed
icon cues (throw/catch, send/receive). For those — and for full manual control — drop down to the
[`animation`](animation-api.md) service.
