/**
 * Prescribed token resting positions for the activity/container profile (process box,
 * pool, tasks, sub-processes): a left-to-right sweep across the **top edge** —
 * ready → entry → busy → completed → exit.
 *
 * Offsets are named constants — the only layout knobs, tuned by visual inspection.
 * `position` is `{ left, top, hoffset, voffset }` in the animation model's terms
 * (`x = left*w + hoffset`, fractions may exceed 0..1).
 *
 * (Other profiles — the event/gateway center point — get added when a function needs them.)
 */

const ABOVE_TOP = -15;    // voffset: floats above the top edge (outside the box)
const BELOW_TOP = 10;     // voffset: just inside, below the top edge
const EDGE_INSET = 20;    // hoffset: inward from a left/right edge
const CENTER_SHIFT = 5;   // event/gateway: small nudge right/down off the symbol center

/** The named lifecycle positions (JS has no enum — a frozen object of constants). */
export const Position = Object.freeze({
  READY: 'ready',
  ENTRY: 'entry',
  BUSY: 'busy',
  COMPLETED: 'completed',
  EXIT: 'exit',
  CENTER: 'center' // events/gateways — a single point (not part of the sweep)
});

/** The activity top-edge sweep, in order. */
export const SWEEP = [ Position.READY, Position.ENTRY, Position.BUSY, Position.COMPLETED, Position.EXIT ];

const POSITIONS = {
  [Position.READY]:     { left: 0,   top: 0,   hoffset: 0,            voffset: ABOVE_TOP },
  [Position.ENTRY]:     { left: 0,   top: 0,   hoffset: EDGE_INSET,   voffset: BELOW_TOP },
  [Position.BUSY]:      { left: 0.5, top: 0,   hoffset: 0,            voffset: BELOW_TOP },
  [Position.COMPLETED]: { left: 1,   top: 0,   hoffset: -EDGE_INSET,  voffset: BELOW_TOP },
  [Position.EXIT]:      { left: 1,   top: 0,   hoffset: 0,            voffset: ABOVE_TOP },
  [Position.CENTER]:    { left: 0.5, top: 0.5, hoffset: CENTER_SHIFT, voffset: CENTER_SHIFT }
};

/** The `{ left, top, hoffset, voffset }` for a named position. */
export function positionFor(name) {
  const p = POSITIONS[name];
  if (!p) {
    throw new Error(`positionFor: unknown position "${name}"`);
  }
  return { ...p };
}

export { ABOVE_TOP, BELOW_TOP, EDGE_INSET, CENTER_SHIFT };
