/** The first desktop source-window slice covers these native record formats. */
export function supportsSourceWindow(harness: unknown): harness is 'claude' | 'codex' {
  return harness === 'claude' || harness === 'codex';
}
