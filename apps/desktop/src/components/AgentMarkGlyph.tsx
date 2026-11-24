/**
 * The status marks that are a shape rather than the running glyph (owner 11-24 design sheet): one family of solid
 * shapes with a sign knocked out of them, no backing behind them.
 *   warn    = triangle with "!" — an agent needs you; the same triangle says a host is too old (AgentHostStaleBadge).
 *   error   = circle with "×".
 *   offline = circle with "−".
 * Colours come from `--agent-mark-<kind>` / `--agent-mark-<kind>-ink` (tokens.css), one pair per theme.
 * Every surface that draws one of these states draws it through this component.
 */
export type AgentMarkKind = 'warn' | 'error' | 'offline'

export function AgentMarkGlyph({ kind, size = 10, className }: { kind: AgentMarkKind; size?: number; className?: string }) {
  const fill = `var(--agent-mark-${kind})`
  const ink = `var(--agent-mark-${kind}-ink)`
  return (
    <svg aria-hidden="true" data-agent-mark={kind} width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className ?? ''}`.trim()}>
      {kind === 'warn' ? (
        <>
          <path d="M6.6 1.9a1.6 1.6 0 0 1 2.8 0l6.1 10.9a1.6 1.6 0 0 1-1.4 2.4H1.9a1.6 1.6 0 0 1-1.4-2.4z" fill={fill} />
          <path d="M8 5.6v4.2" stroke={ink} strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="8" cy="12.4" r="1.05" fill={ink} />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="7.5" fill={fill} />
          <path d={kind === 'error' ? 'M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2' : 'M4.8 8h6.4'} stroke={ink} strokeWidth={kind === 'error' ? 1.9 : 2} strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}
