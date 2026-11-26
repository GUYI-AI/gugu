export type AgentRunningStateKey = 'reading' | 'searching' | 'editing' | 'executing' | 'thinking' | 'running'

// @@@1696 ACP semantic kind only derives a stable state key. The visible verb is translated by the
// display component for the current locale, so product copy never flows back into orchestration.
export function kindToRunningState(kind: string | null | undefined): AgentRunningStateKey {
  switch ((kind ?? '').toLowerCase()) {
    case 'read':
      return 'reading'
    case 'search':
    case 'fetch':
      return 'searching'
    case 'edit':
      return 'editing'
    case 'execute':
      return 'executing'
    case 'think':
      return 'thinking'
    default:
      return 'running'
  }
}
