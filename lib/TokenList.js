import { createListEntry } from 'bpmn-js-side-panel';
import createTokenEntry from './TokenEntry';

/**
 * createTokenList — a live, keyed list of {@link createTokenEntry}s, built on the side panel's
 * {@link createListEntry}. It is the reusable replacement for the token panel's hand-diffed `<ul>`:
 * one keyed reconcile that adds, removes and updates token rows in place as a run advances, never
 * rebuilding the list (so selection highlight, scroll and any expanded detail survive).
 *
 * Tokens are keyed by `key(token)`, which defaults to the pair `node|label` — the library's own
 * uniqueness rule, so two concurrent tokens of one instance (a scope token and its child, two parallel
 * branches) occupy two rows instead of sharing one. A row survives its token's hop from one node to the
 * next through `rekey`, which renames a row's key without touching the DOM, so the row element, its
 * expanded body, the focus inside it and the list's scroll position are all kept. All the
 * per-entry options (detail renderer, click/advance handlers, the display/visibility helpers) are set
 * once here and applied to every entry the list creates, so a consumer composes a whole token list by
 * describing one entry. The list itself owns no filter/selection policy — a consumer drives it with
 * `sync`/`add`/`remove`/`update`/`rekey`, and can hold several (e.g. a "selected" list and an "at node"
 * list).
 *
 * @param {Object} [options]
 * @param {Function} [options.key]          (token) => string key; defaults to `` `${node}|${label}` ``
 * @param {boolean}  [options.separators]   hairline between rows (see createListEntry); default off
 * @param {Function} [options.renderDetail] passed to every entry; makes the entries expandable
 * @param {Function} [options.onClick]      passed to every entry (select/reveal)
 * @param {Function} [options.onDblClick]   passed to every entry (advance)
 * @param {Function} [options.displayNode]  passed to every entry
 * @param {Function} [options.isVisible]    passed to every entry
 * @param {Function} [options.controls]     (token) => Node|Node[]; what each row carries beside its label
 * @return {{
 *   element: HTMLElement,
 *   add: (function(Object, number=): Object),
 *   remove: (function(Object): void),
 *   update: (function(Object): void),
 *   rekey: (function(Object, Object): (Object|undefined)),
 *   sync: (function(Object[]): void),
 *   has: (function(Object): boolean),
 *   get: (function(Object): (Object|undefined)),
 *   setSeparators: (function(boolean): void),
 *   keys: (function(): string[]),
 *   clear: (function(): void)
 * }}
 */
export default function createTokenList(options = {}) {
  const {
    key = (token) => `${token.node}|${token.label}`,
    separators,
    renderDetail,
    onClick,
    onDblClick,
    displayNode,
    isVisible,
    controls
  } = options;

  const list = createListEntry({ separators });

  // key -> { entry, handle }. The token key is ours alone; the underlying list is keyed by an opaque
  // `handle` a row keeps for its whole life, so renaming a key (`rekey`) touches no DOM at all.
  const entries = new Map();
  let handleSeq = 0;

  const entryOptions = { renderDetail, onClick, onDblClick, displayNode, isVisible };

  const add = (token, index) => {
    const k = key(token);
    const present = entries.get(k);
    if (present) {
      present.entry.update(token);
      return present.entry;
    }
    const entry = createTokenEntry(token, {
      ...entryOptions,
      controls: controls && controls(token)
    });
    const handle = `bjs-token-row-${++handleSeq}`;
    entries.set(k, { entry, handle });
    list.add(handle, entry.element, index);
    return entry;
  };

  const removeKey = (k) => {
    const record = entries.get(k);
    if (record) {
      list.remove(record.handle);
      entries.delete(k);
    }
  };

  const remove = (token) => removeKey(key(token));

  const update = (token) => {
    const record = entries.get(key(token));
    if (record) {
      record.entry.update(token);
    }
  };

  // Rename a row's key and update it from its new token, keeping the row itself: `previous` is the
  // token as the row was keyed (for a hop, the moved token with its former node), `token` the token
  // now. Used where a token changes what its key is made of, which for the default key is its node.
  // Nothing is added: a row that is not listed under `previous` is not created here. Should the new key
  // already be listed — several tokens of one identity, which the library holds as an interchangeable
  // queue — the listed row wins and the renamed one is dropped, as `add` also keeps one row per key.
  const rekey = (previous, token) => {
    const from = key(previous);
    const record = entries.get(from);
    if (!record) {
      return undefined;
    }
    const to = key(token);
    if (to !== from) {
      const occupant = entries.get(to);
      if (occupant) {
        list.remove(record.handle);
        entries.delete(from);
        occupant.entry.update(token);
        return occupant.entry;
      }
      entries.delete(from);
      entries.set(to, record);
    }
    record.entry.update(token);
    return record.entry;
  };

  // Reconcile the list to exactly `tokens`: drop rows no longer wanted, update the ones that stay,
  // append the new ones (in the given order). In-place, so nothing already shown is rebuilt.
  const sync = (tokens) => {
    const wanted = new Set(tokens.map(key));
    for (const k of Array.from(entries.keys())) {
      if (!wanted.has(k)) {
        removeKey(k);
      }
    }
    tokens.forEach((token) => {
      if (entries.has(key(token))) {
        update(token);
      } else {
        add(token);
      }
    });
  };

  // Re-apply every present entry from its own current token — for a bulk cue that changed no token
  // membership (e.g. the stack front flipped, so hidden badges / selection highlights need refreshing).
  const refresh = () => {
    entries.forEach(({ entry }) => entry.update(entry.token()));
  };

  const clear = () => {
    entries.clear();
    list.clear();
  };

  // The keys in display order. The list holds handles, so the token keys are read back through them.
  const keys = () => {
    const byHandle = new Map();
    entries.forEach((record, k) => byHandle.set(record.handle, k));
    return list.keys().map((handle) => byHandle.get(handle));
  };

  return {
    element: list.element,
    add,
    remove,
    update,
    rekey,
    sync,
    refresh,
    has: (token) => entries.has(key(token)),
    get: (token) => {
      const record = entries.get(key(token));
      return record && record.entry;
    },
    setSeparators: list.setSeparators,
    keys,
    clear
  };
}
