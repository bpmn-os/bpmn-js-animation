# Animation

This module animates tokens on a BPMN diagram. Beyond rendering tokens, the module visualizes multiple instances of a process or activity as stacked shapes, one for each instance. The module does not create or move tokens by itself, but expects the respective function to be called. Each function plays one step a token takes, and the module decides how that step looks but never when it happens, so a token moves only when a function is called. 

The functions live on the `animation` object, which a bpmn-js viewer exposes once `AnimationModule` is added:

```javascript
const animation = viewer.get('animation');
```

Recording and replaying token flow are separate tools. The simulator records the steps as they happen, and the animator replays a recorded [execution log](execution-log.md).

## The token model

Every token belongs to a process instance and is addressed by the node it sits on together with a label that names the instance, such as `"order-42"`. It is assumed that a `(node, label)` pair identifies exactly one token, so a node never carries two tokens with the same label at the same time. Any model without race conditions meets this.

The node is any element id, including a process id. In a collaboration that draws the process as a pool, a process id resolves to the pool.

A token is created explicitly when an instance starts and each time a path reaches a new node. It is removed explicitly only when it reaches an end of its own, such as an end event or a finished activity. Every other ending follows from the model and is performed by the module: an interrupting boundary event or event sub-process clears the work it cancels, an event-based gateway clears the branches that did not win, and a finishing scope clears anything still waiting inside it. Removing a token also removes everything created from it, so removing an instance's first token removes the whole instance.

## Lifecycle positions

Within an activity a token moves left to right along the top edge through three named positions. Events and gateways use a single center point instead.

| Position | Where, on an activity |
| --- | --- |
| `entry` | top-left corner |
| `busy` | top-center |
| `completion` | top-right corner |
| `center` | the symbol center, for an event or a gateway |

`advanceToken` glides through every position between the current one and the target, so the path is always shown. The names are fixed. What each one means, such as arrived, running, or done, is a matter of convention.

## `createToken`

`createToken({ node, label, animate? }) → Token`

Creates a token and returns it. What it creates depends on the node type: on a process or participant it starts a new instance, a fresh root with a new color, and for a pool-less process it also draws the [process box](primitives.md#implicit-process-box); on a start event or an activity inside a scope it seeds a child of the enclosing instance; on a link catch event it places the token that the matching link throw consumed; on a boundary event it arms a listener on the host activity; on a multi-instance activity it spawns one sub-instance; on an event sub-process start event it fires the event sub-process. The token plays an entrance as it appears, and its first departure waits for that entrance to finish.

| Parameter | Type | Description |
| --- | --- | --- |
| `node` | `string` | The element to create the token at. |
| `label` | `string` | The instance label. |
| `animate` | `string`, optional | A looping cue on the resting token, such as `'bounce'`. |

**Returns** `Token`, the created token.

**Throws** if a token already exists at `(node, label)`, if the enclosing scope has no token of that label, or if the node is not a kind that can hold a created token.

```javascript
animation.createToken({ node: 'Process_1', label: 'order-42' });    // instance root
animation.createToken({ node: 'StartEvent_1', label: 'order-42' }); // its child at the start event
```

## `advanceToken`

`advanceToken({ node, label, sequenceFlow?, position?, animate? }) → Promise<Token>`

Moves a token one step and resolves with it. The form is chosen by the argument given and the node the token is on:

- Along a flow (`sequenceFlow`): the token moves onto that flow and travels to the far node, where it rests on the same flow. The flow may be outgoing (forward) or incoming (a rewind).
- Firing a boundary (`sequenceFlow`, when the token is on a boundary event): a fresh token continues along the outflow, and an interrupting boundary also cancels the host activity and its whole subtree as part of this call.
- Into a center node (no `position`, on an event or a gateway): the token anchors at the symbol center.
- Through an activity (`position`): the token glides to the target position, passing through every position in between. Forward only, except that a standard-loop activity may glide back for another iteration.

The node's own icon flies automatically, derived from the node type. An interrupting event sub-process firing and an event-based gateway resolution also cancel within this call, not as separate ones.

| Parameter | Type | Description |
| --- | --- | --- |
| `node` | `string` | The token's current node. |
| `label` | `string` | The instance label. |
| `sequenceFlow` | `string`, optional | The flow to travel along, or to fire a boundary along. |
| `position` | `'entry' \| 'busy' \| 'completion' \| 'center'`, optional | The position to glide to within an activity. |
| `animate` | `string`, optional | A looping cue applied at the target. |

**Returns** `Promise<Token>`, the moved token.

**Throws** if no token of `label` is at `node`, if the flow is not connected to the node, if `position` is unknown or would move backward, or if the node is not a flow node.

```javascript
await animation.advanceToken({ node: 'StartEvent_1', label: 'order-42', sequenceFlow: 'Flow_1' });
await animation.advanceToken({ node: 'Task_1', label: 'order-42', position: 'busy', animate: 'pulse' });
```

## `forkToken`

`forkToken({ node, label, sequenceFlow }) → Promise<Token>`

Splits a thread at a diverging gateway, one branch per call on a chosen outgoing flow. Every branch carries the same instance label, and they rejoin at `joinTokens`. A fork only places a branch on its outflow without travelling, so the remaining outflows can be forked too, and each branch then travels onward through `advanceToken`. The first fork moves the original token onto its flow, and later forks clone onto theirs.

| Parameter | Type | Description |
| --- | --- | --- |
| `node` | `string` | The diverging gateway. |
| `label` | `string` | The instance label. |
| `sequenceFlow` | `string` | The chosen outgoing flow. |

**Returns** `Promise<Token>`, the branch token, resting on the flow.

**Throws** if the node is not a gateway, the flow is not one of its outflows, or no token of `label` is at the node.

```javascript
await animation.forkToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_a' });
await animation.forkToken({ node: 'Gateway_1', label: 'order-42', sequenceFlow: 'Flow_b' });
```

## `joinTokens`

`joinTokens({ node, label }) → Promise<Token>`

The inverse of `forkToken`. At a converging gateway it collapses the branches of `label` resting on the incoming flows into one token anchored at the gateway center, keeping the color, the membership, and any children. The merged token then travels onward through `advanceToken`. A converging exclusive gateway is an uncontrolled merge rather than a join, so there each token passes through with `advanceToken` instead.

| Parameter | Type | Description |
| --- | --- | --- |
| `node` | `string` | The converging gateway. |
| `label` | `string` | The instance label. |

**Returns** `Promise<Token>`, the merged token, at the gateway center.

**Throws** if the node is not a gateway, or no branches of `label` are at the node.

## `consumeToken`

`consumeToken({ node, label, sequenceFlow? }) → Promise<Token[]>`

Removes the target token and its whole subtree, and resolves with the removed tokens. A token is consumed explicitly only when it reaches its own end. Structural removal (an interrupting cancel, an event-based gateway's losing branches, a scope's untriggered waiters) is derived and is not a separate call. The model updates synchronously, so every token in the subtree is gone the moment the call is made, before the returned promise settles. Each removed token then flips and fades out. Consuming a stacked instance decrements its stack, and consuming the last process instance removes its box.

By default the target is the token anchored at the node. A token in transit on a flow is not consumed directly, though descendants on flows are torn down by the cascade. A `sequenceFlow` argument instead targets a token resting on that flow, such as a parked multi-instance outer token when its scope is interrupted.

| Parameter | Type | Description |
| --- | --- | --- |
| `node` | `string` | The token's node. |
| `label` | `string` | The instance label. |
| `sequenceFlow` | `string`, optional | The flow whose resting token is consumed instead of the anchored one. |

**Returns** `Promise<Token[]>`, the removed tokens, the target first.

**Throws** if no matching token is at the node, or if the target is in transit on a flow and no `sequenceFlow` was given.

```javascript
await animation.consumeToken({ node: 'EndEvent_1', label: 'order-42' });
```

## `autoFocus`

`autoFocus(on = true) → void`

Turns auto-focus on or off. While on, every function that touches a token brings that token's instance to the front, so the just-touched token is the visible one. It is off by default. When several instances run at once a stacked node shows only its front instance's tokens, so this keeps the active instance in view. While a reveal is animating, `advanceToken` waits for it, so a move never overlaps a reveal.

| Parameter | Type | Description |
| --- | --- | --- |
| `on` | `boolean`, optional | `true` to follow the active instance (the default), `false` to stop. |

## `focusToken`

`focusToken(token) → Promise`

Brings a token into view, which is two things: the plane it rests on is drilled to, and its instance and the stacked ancestors in its scope are brought to the front. It resolves once the reveal has settled. It is the manual counterpart to `autoFocus`, and the [animator](../README.md#animator) uses it to follow the active instance during replay. The drill is a no-op when the token is already on the plane shown, as the front move is when nothing in its chain is stacked, so revealing a token that is already visible does nothing.

| Parameter | Type | Description |
| --- | --- | --- |
| `token` | `Token` | The token whose instance to reveal. |

**Returns** `Promise`, resolved when the reveal arc settles.

## `whenFocused`

`whenFocused() → Promise`

Resolves once any in-flight reveal has settled, which lets later work be sequenced after a reveal. Resolves immediately when nothing is animating.

**Returns** `Promise`.

## `getToken`

`getToken(node, label, sequenceFlow?) → Token | undefined`

The token at `(node, label)`, optionally the branch resting on `sequenceFlow`, or `undefined` if there is none.

## `getTokens`

`getTokens(node, label) → Token[]`

Every token of instance `label` currently at `node`, in arrival order.

## `getEntry`

`getEntry(node, label, sequenceFlow?) → object | undefined`

The record the module keeps for a token, or `undefined`. `getToken` returns the token itself and is usually the better choice.

## `getChildren`

`getChildren(token) → Token[]`

The child tokens of `token`.

## `getParent`

`getParent(token) → Token | null`

The parent of `token`, its enclosing scope, or `null` for an instance root.

## `clear`

`clear() → void`

Removes every token and resets the module.
