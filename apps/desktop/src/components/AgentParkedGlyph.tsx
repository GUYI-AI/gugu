/**
 * The background-running marker (base status `working`, detail `parked`): two upright bars, like a pause sign, in the
 * parked tone. A shape, not a dot, so it never reads as the red error dot. Every surface that draws this state uses
 * it: the avatar badge, the session page row, the contact row and detail, and the agent settings header.
 *
 * The bars sit on whole pixels (width w, gap w, height size − 2⌊size/5⌋, integer offsets, crisp edges), so at the list
 * badge size (10) they are 2 + 2 + 2 px by 6 px and stay two separate bars on 1× and 2× screens.
 */
export function AgentParkedGlyph({ size = 8, className }: { size?: number; className?: string }) {
  const w = Math.max(2, Math.floor(size / 5))
  const h = size - 2 * Math.floor(size / 5)
  const x = Math.floor((size - 3 * w) / 2)
  const y = Math.floor((size - h) / 2)
  return (
    <svg aria-hidden="true" data-agent-status-glyph="parked" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges" className={`shrink-0 text-[var(--agent-tone-parked)] ${className ?? ''}`.trim()}>
      <rect x={x} y={y} width={w} height={h} fill="currentColor" />
      <rect x={x + 2 * w} y={y} width={w} height={h} fill="currentColor" />
    </svg>
  )
}
