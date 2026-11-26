import './PanelToggleIcon.css'

/**
 * @@@panel-toggle-icon — every sidebar / side-panel open-close button draws this one glyph (owner 11-26 picked
 * lucide's panel-left-close ⇄ panel-left-open). The state is in the arrow, not in a highlight: open points the
 * way the panel folds ("‹" for a left panel), folded points the way it opens.
 *
 * Geometry is lucide's PanelLeftClose, verbatim (scripts/icons/solar-icons.json). The arrow does not rotate: it is
 * mirrored about x=15 (scaleX 1 → −1), which turns the close chevron (x 13–16) into lucide's open chevron (x 14–17)
 * exactly; half-way it is a short vertical stroke, never a skewed shape. `side="right"` mirrors the whole glyph,
 * which is lucide's PanelRightClose / PanelRightOpen.
 */
export function PanelToggleIcon({ open, side = 'left', className }: { open: boolean; side?: 'left' | 'right'; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      data-panel-toggle-icon={side}
      data-open={open ? '' : undefined}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" data-panel-toggle-arrow="" />
    </svg>
  )
}
