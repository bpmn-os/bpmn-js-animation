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

const ABOVE_TOP = -15;   // voffset: floats above the top edge (outside the box)
const BELOW_TOP = 10;    // voffset: just inside, below the top edge
const EDGE_INSET = 10;   // hoffset: inward from a left/right edge

const ACTIVITY_POSITIONS = {
  ready:     { left: 0,   top: 0, hoffset: 0,           voffset: ABOVE_TOP },
  entry:     { left: 0,   top: 0, hoffset: EDGE_INSET,  voffset: BELOW_TOP },
  busy:      { left: 0.5, top: 0, hoffset: 0,           voffset: BELOW_TOP },
  completed: { left: 1,   top: 0, hoffset: -EDGE_INSET, voffset: BELOW_TOP },
  exit:      { left: 1,   top: 0, hoffset: 0,           voffset: ABOVE_TOP }
};

/** The `{ left, top, hoffset, voffset }` for a named lifecycle position (activity sweep). */
export function positionFor(name) {
  const p = ACTIVITY_POSITIONS[name];
  if (!p) {
    throw new Error(`positionFor: unknown position "${name}"`);
  }
  return { ...p };
}

export { ABOVE_TOP, BELOW_TOP, EDGE_INSET };
