/**
 * The background-running marker (base status `working`, detail `parked`): the product's running glyph held still
 * (running-glyph.css, `gg-running-glyph--still`), in the same ink. Turning says it is working; held still, that it
 * is running out of sight. Every surface that draws this state uses it: the avatar corner, the session page row, the
 * contact row and detail, and the agent settings header. `size` sets its font size; without it, the glyph takes the
 * text size around it.
 */
export function AgentParkedGlyph({ size, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden="true" data-agent-status-glyph="parked" className={`gg-running-glyph gg-running-glyph--still ${className ?? ''}`.trim()}
      style={size === undefined ? undefined : { fontSize: size, lineHeight: 1 }}>
      <span className="gg-running-glyph__strip" />
    </span>
  )
}
