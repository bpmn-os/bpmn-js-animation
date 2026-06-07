/**
 * Prescribed token resting positions for the activity/container profile (process box,
 * pool, tasks, sub-processes): a left-to-right sweep across the **top edge** —
 * entry → busy → completion (each sits on the top edge, `voffset: 0`).
 *
 * Offsets are named constants — the only layout knobs, tuned by visual inspection.
 * `position` is `{ left, top, hoffset, voffset }` in the animation model's terms
 * (`x = left*w + hoffset`, fractions may exceed 0..1).
 *
 * (Other profiles — the event/gateway center point — get added when a function needs them.)
 */

const CENTER_SHIFT = 5;   // event/gateway: small nudge right/down off the symbol center

/** The named lifecycle positions (JS has no enum — a frozen object of constants). */
export const Position = Object.freeze({
  ENTRY: 'entry',
  BUSY: 'busy',
  COMPLETION: 'completion',
  CENTER: 'center' // events/gateways — a single point (not part of the sweep)
});

/** The activity top-edge sweep, in order. */
export const SWEEP = [ Position.ENTRY, Position.BUSY, Position.COMPLETION ];

const POSITIONS = {
  [Position.ENTRY]:      { left: 0,   top: 0,   hoffset: 0,  voffset: 0 },
  [Position.BUSY]:       { left: 0.5, top: 0,   hoffset: 0,  voffset: 0 },
  [Position.COMPLETION]: { left: 1,   top: 0,   hoffset: 0,  voffset: 0 },
  [Position.CENTER]:     { left: 0.5, top: 0.5, hoffset: CENTER_SHIFT, voffset: CENTER_SHIFT }
};

/** The `{ left, top, hoffset, voffset }` for a named position. */
export function positionFor(name) {
  const p = POSITIONS[name];
  if (!p) {
    throw new Error(`positionFor: unknown position "${name}"`);
  }
  return { ...p };
}

export { CENTER_SHIFT };
