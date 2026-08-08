/**
 * Glyphs for the settings this package owns but does not draw a control for.
 *
 * Auto-focus governs the canvas rather than any panel, so the control belongs wherever a host keeps its own
 * furniture over the canvas, and more than one host wants the same one. The package ships the glyph so that
 * they agree, and nothing here draws it: it is bare markup with no size, stroke or colour of its own, so
 * whatever holds it states all three, exactly as a toolbar states them for its own icons.
 *
 * It is Feather's crosshair with a dot at its centre, which reads as a token held in the sight.
 */
export const AUTO_FOCUS_ICON = '<svg viewBox="0 0 24 24">'
  + '<circle cx="12" cy="12" r="10"/>'
  + '<line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/>'
  + '<line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>'
  + '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>';
