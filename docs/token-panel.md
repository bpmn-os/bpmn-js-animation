# Token panel

The token panel is a ready-made user interface for the tokens on the diagram. It adds a **Tokens** tab
to a [`bpmn-js-side-panel`](https://github.com/bpmn-os/bpmn-js-side-panel), listing the running tokens
and hosting the playback controls. The panel is assembled from three factories that this package also
exports on their own, so a host that wants a token list somewhere else, in a panel of its own making,
composes it from the same parts rather than from a copy of them.

Everything here is optional. `TokenPanelModule` is added by the host, and even then the panel renders
only when a `sidePanel` service is present.

```javascript
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import SidePanelModule from 'bpmn-js-side-panel';
import { SimulatorModule, AnimatorModule, TokenPanelModule } from 'bpmn-js-animation';

import 'bpmn-js-side-panel/assets/side-panel.css';
import 'bpmn-js-animation/assets/animation.css';
import 'bpmn-js-animation/assets/token-panel.css';

const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ SimulatorModule, AnimatorModule, SidePanelModule, TokenPanelModule ],
  sidePanel: { parent: '#side-panel' }
});
```

What the tab shows and how it is driven is described in the [README](../README.md#token-panel). This
guide covers what a host configures and what it composes.

## Configuration

The panel reads `config.tokenPanel`.

| Option | Type | Description |
| --- | --- | --- |
| `label` | `string` | The tab label. Defaults to `Tokens`. The panel appends the number of tokens standing to it, so the tab reads `Tokens (5)` while a run is on and `Tokens` while none is; the count is in the name rather than beside it because the name is what a selector shows in one of the side panel's views and a column's resizer shows in the other. |
| `nodeSelection` | `boolean` | Whether the node selection frame is drawn while the panel is present. Defaults to `true`, since the panel inspects the selected node. |
| `modelNote` | `string` or `Node` | Content shown instead of the panel's own contents while the host is in `model` mode, such as a note pointing at the host's mode controls. |
| `renderTokenDetail` | `Function` | Draws the inside of a token row. See below. |

## The body of a token row

A row is a summary the panel owns and a body the host owns. `renderTokenDetail(token, contentEl)` is
called with the token the row stands for and the element to draw into. Supplying it is what makes the
rows expandable: a row without it is a plain row with no caret, and a row with it gains a caret that
discloses the body. The summary click stays free for selecting the token, so only the caret opens the
body.

Expandability belongs to the entry and is settled when the entry is created, by whether that entry was
given a renderer. The two are not one entry in two states but two different side-panel entries: a row
with no renderer is a simple entry, which discloses nothing, so the summary is what the entry holds and
takes the full width, and a row with one is a collapsible entry whose label is that summary, carrying a
caret and a body. An entry a host creates itself
decides for itself; the rows of one list agree with one another because a list passes the options it
was given to every entry it creates.

Expandability does not follow what the body turns out to hold, so a host with nothing to show for a
particular token draws that, a `None` or a sentence saying as much, rather than leaving the body
empty, since an empty body behind a caret reads as a fault.

The function is called again whenever the row updates, which is on every change to its token and on
every hop from one node to the next, so a value that changes while the row stands open is redrawn
without the row being rebuilt around it. The body element itself survives such a redraw, since the
panel clears its children rather than replacing it. The panel neither reads the body nor knows when
what it shows has changed: a host whose values change for reasons of its own keeps them current itself,
by holding the element it drew into and writing into it.

```javascript
const viewer = new NavigatedViewer({
  container: '#canvas',
  additionalModules: [ AnimatorModule, SidePanelModule, TokenPanelModule ],
  sidePanel: { parent: '#side-panel' },
  tokenPanel: {
    renderTokenDetail: (token, contentEl) => myView.render(token.node, token.label, contentEl)
  }
});
```

A token is everything the body needs to identify what it draws, `token.node` and `token.label` being
the pair that identifies it. Nothing further is required of the panel.

## The reusable parts

Three factories are exported. Each is plain DOM built on the side panel's own entry components, and
none of them needs a diagram service, so they are used as readily inside a panel of the host's own as
inside this one.

```javascript
import { createTokenEntry, createTokenList, createPlaybackControlsEntry } from 'bpmn-js-animation';
```

### `createTokenEntry`

`createTokenEntry(token, options) → entry`

One token as a side-panel entry. The summary is the token's colour swatch, carrying the same motion
cue the dot carries on the canvas, its label, the node it rests at, and a badge when the token belongs
to an instance that is not the one on show. Which entry it is follows from `renderDetail`: given one,
the row is a collapsible entry with a caret that opens the body; without one, it is a simple entry, which
discloses nothing and is the summary itself, so no caret is reserved and the summary runs to the reading
inset on either side.

| Option | Type | Description |
| --- | --- | --- |
| `renderDetail` | `Function` | `(token, contentEl) => void`. Draws the body, and its presence makes the entry expandable. |
| `onClick` | `Function` | `(token, event) => void`. A single click on the row, with the DOM event it came from, so that a modifier the reader held is known to whoever answers. A click inside the disclosed body is the body's, so opening a section or filling in a field there neither selects nor advances the token. |
| `onDblClick` | `Function` | `(token, event) => void`. A double click on the row, under the same rule. |
| `displayNode` | `Function` | `(nodeId) => string`. The text the node tag shows. Defaults to the id. |
| `isVisible` | `Function` | `(token) => boolean`. Whether the token is the one on show, which decides the badge. Defaults to always. |
| `controls` | `Node` or `Node[]` | What the row carries beside its label: a button that acts on the token, a pair of arrows that move it in an order. Their clicks do not select or advance the token, the entry's controls slot stopping them. |
| `open` | `boolean` | Whether an expandable entry starts open. Defaults to `false`. |

The entry is `{ element, update, contentEl, controlsEl, token }`, where `update(token)` re-applies the row
from a token, redrawing the body with it, `controlsEl` is the slot the controls are held in, for a caller
that mounts its own later, and `token()` reports the token the row currently stands for.

A token that is selected carries `bjs-token-selected`, and the stylesheet tints the whole entry with it,
the summary and the disclosed body alike, since what a token holds belongs to that token. A row given
`onClick` carries `bjs-token-clickable` and lights up the same region on hover, a click on its summary
being what selects it.

The panel answers a click by revealing the token's stacks and firing `token.click`, carrying the reader's
own event as `originalEvent`. A click therefore behaves in a list as it behaves on the canvas: plain, it
selects that token alone and clears the rest, and clears it too where it was the only one selected; with
shift held, it adds the token to the selection, or takes it out again where it was already in it.

### `createTokenList`

`createTokenList(options) → list`

A live list of token entries, keyed so that a stream of changes is applied to it one row at a time and
the list is never rebuilt. What is listed is the caller's own affair: the list holds no filter and no
selection of its own, and a caller may hold several of them. The per-entry options are given once here
and apply to every row the list creates.

| Option | Type | Description |
| --- | --- | --- |
| `key` | `Function` | `(token) => string`. What identifies a row. Defaults to the pair `` `${node}|${label}` ``. |
| `separators` | `boolean` | Whether a hairline is drawn between rows. Defaults to `false`. |
| `renderDetail`, `onClick`, `onDblClick`, `displayNode`, `isVisible` | `Function` | Passed to every entry the list creates. See `createTokenEntry`. |
| `controls` | `Function` | `(token) => Node|Node[]`. Asked per row for what that row carries. |

| Operation | Description |
| --- | --- |
| `add(token, index?)` | Appends a row, or inserts it at `index`. A token already listed updates its row instead. |
| `remove(token)` | Drops the row of that token. |
| `update(token)` | Re-applies the row from that token. |
| `rekey(previous, token)` | Renames a row's key and updates it from `token`. See below. |
| `sync(tokens)` | Reconciles the list to exactly those tokens, in that order. |
| `refresh()` | Re-applies every row from the token it already holds. |
| `has(token)`, `get(token)` | Whether a token is listed, and its entry. |
| `keys()` | The keys, in display order. |
| `setSeparators(on)`, `clear()` | As on the side panel's list. |
| `element` | The list element, to be placed by the caller. |

The default key is the pair of node and label, which is the identity a token has in this package: no
two tokens rest at one node under the same label. Two concurrent tokens of one instance, a scope token
and a token within it, or two parallel branches, therefore occupy two rows. A caller wanting some other
identity passes `key`, and the label alone is what earlier versions used.

A key made of the node changes when the token hops, and `rekey` is what carries the row across such a
hop. It takes the token as the row was keyed and the token as it is now, renames the key without
touching the document, and updates the row. Nothing about the row is lost, neither the element and the
body drawn into it, nor the focus and the selection inside that body, nor the scroll position of the
list. A row is only renamed, never created: a token the list does not hold under `previous` is left
alone. Where the new key is one the list already holds, which under this package's token model means a
second token of the same identity, the listed row is kept and the renamed one is dropped, as `add`
likewise keeps one row per key.

The `token.moved` event carries what a hop needs, the token and the node it left, so a consumer of the
list re-keys with

```javascript
eventBus.on('token.moved', (e) => list.rekey({ ...e.token, node: e.from }, e.token));
```

### `createPlaybackControlsEntry`

`createPlaybackControlsEntry(options) → controls`

The run and pause button with the speed slider. The button follows the `playback` state machine, going
from play when idle to pause while playing to resume when paused, and disables itself when there is
nothing to start. The slider sets the step duration through `primitives.setAnimationDuration`.

| Option | Type | Description |
| --- | --- | --- |
| `playback` | `Object` | The playback controller service. Required. |
| `primitives` | `Object` | The primitives service, for the speed. Required. |
| `eventBus` | `Object` | When given, the control re-syncs itself on `playback.changed`. |
| `resolveLog` | `Function` | `async () => log`. What an idle start plays, when the log does not come from a registered log source. |
| `canStart` | `Function` | `() => boolean`. Whether the idle button is enabled. Defaults to whether a log source is registered. |
| `minDuration`, `maxDuration` | `number` | The fastest and slowest step duration in milliseconds. Default `100` and `2000`. |

The control is `{ element, update, runButton }`, where `update()` re-syncs the button for a host-side
change the control cannot observe, such as a newly supplied log.

A log may be one that grows. A player that produces a run as it plays it says so through `isStreaming()`,
and while it does an empty log is a run that has produced no record yet rather than nothing to play, so it
is played and the records are drawn as they arrive. Without that a manual run whose first step waits — on a
decision, on an instantiation still to come — would be started and then thrown away. The method is
optional, and a player without it is asked for a log that is complete when it arrives.
