import { createListEntry } from 'bpmn-js-side-panel';
import createTokenEntry from './TokenEntry';

/**
 * createTokenList — a live, keyed list of {@link createTokenEntry}s, built on the side panel's
 * {@link createListEntry}. It is the reusable replacement for the token panel's hand-diffed `<ul>`:
 * one keyed reconcile that adds, removes and updates token rows in place as a run advances, never
 * rebuilding the list (so selection highlight, scroll and any expanded detail survive).
 *
 * Tokens are keyed by `key(token)` (default `token.label`, the panel's former row key). All the
 * per-entry options (detail renderer, click/advance handlers, the display/visibility helpers) are set
 * once here and applied to every entry the list creates, so a consumer composes a whole token list by
 * describing one entry. The list itself owns no filter/selection policy — a consumer drives it with
 * `sync`/`add`/`remove`/`update`, and can hold several (e.g. a "selected" list and an "at node" list).
 *
 * @param {Object} [options]
 * @param {Function} [options.key]          (token) => string key; defaults to `token.label`
 * @param {boolean}  [options.separators]   hairline between rows (see createListEntry); default off
 * @param {Function} [options.renderDetail] passed to every entry; makes the entries expandable
 * @param {Function} [options.onClick]      passed to every entry (select/reveal)
 * @param {Function} [options.onDblClick]   passed to every entry (advance)
 * @param {Function} [options.displayNode]  passed to every entry
 * @param {Function} [options.isVisible]    passed to every entry
 * @return {{
 *   element: HTMLElement,
 *   add: (function(Object, number=): Object),
 *   remove: (function(Object): void),
 *   update: (function(Object): void),
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
    key = (token) => token.label,
    separators,
    renderDetail,
    onClick,
    onDblClick,
    displayNode,
    isVisible
  } = options;

  const list = createListEntry({ separators });
  const entries = new Map();   // key -> tokenEntry handle

  const entryOptions = { renderDetail, onClick, onDblClick, displayNode, isVisible };

  const add = (token, index) => {
    const k = key(token);
    if (entries.has(k)) {
      entries.get(k).update(token);
      return entries.get(k);
    }
    const entry = createTokenEntry(token, entryOptions);
    entries.set(k, entry);
    list.add(k, entry.element, index);
    return entry;
  };

  const remove = (token) => {
    const k = key(token);
    list.remove(k);
    entries.delete(k);
  };

  const update = (token) => {
    const entry = entries.get(key(token));
    if (entry) {
      entry.update(token);
    }
  };

  // Reconcile the list to exactly `tokens`: drop rows no longer wanted, update the ones that stay,
  // append the new ones (in the given order). In-place, so nothing already shown is rebuilt.
  const sync = (tokens) => {
    const wanted = new Set(tokens.map(key));
    for (const k of Array.from(entries.keys())) {
      if (!wanted.has(k)) {
        list.remove(k);
        entries.delete(k);
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
    entries.forEach((entry) => entry.update(entry.token()));
  };

  const clear = () => {
    entries.clear();
    list.clear();
  };

  return {
    element: list.element,
    add,
    remove,
    update,
    sync,
    refresh,
    has: (token) => entries.has(key(token)),
    get: (token) => entries.get(key(token)),
    setSeparators: list.setSeparators,
    keys: () => list.keys(),
    clear
  };
}
