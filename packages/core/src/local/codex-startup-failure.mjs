export const CODEX_STARTUP_KINDS = ['version', 'missing', 'permission', 'configuration', 'protocol', 'exited', 'timeout', 'unknown']
const known = value => CODEX_STARTUP_KINDS.includes(value) ? value : null

/** Typed facts win; legacy bridge diagnostics remain recognizable across mixed client versions. */
export function codexStartupKind(value, native = false, depth = 0) {
  if (depth > 5 || value == null) return null
  if (typeof value === 'object') {
    const tagged = known(value.startupReason) ?? known(value.data?.codexStartupKind)
    if (tagged) return tagged
    if (value.code === 'runtime-version-unsupported' && (native || value.data?.providerId === 'codex')) return 'version'
    for (const nested of [value.runtimeError, value.cause]) {
      const kind = codexStartupKind(nested, false, depth + 1)
      if (kind) return kind
    }
    if (native && (value.code === 'ENOENT' || value.probe?.errno === 'ENOENT')) return 'missing'
    if (native && (['EACCES', 'EPERM'].includes(value.code) || ['EACCES', 'EPERM'].includes(value.probe?.errno))) return 'permission'
    if (native && value.code === 'runtime-version-probe-timeout') return 'timeout'
    value = value.message ?? value.detail ?? value.reason ?? ''
  }
  if (typeof value !== 'string') return native ? 'unknown' : null
  if (/local Codex app-server exited \(code=/.test(value)) return 'exited'
  if (/local Codex app-server \S+ timed out after \d+ms/.test(value)) return 'timeout'
  if (value.includes('Invalid JSONL from Codex app-server stdout:')) return 'protocol'
  if (value.startsWith('GUGU_PLATFORM_MODELS:')) return 'configuration'
  if (/本机 Codex 无法启动 app-server|codex debug models --bundled/.test(value)) return 'unknown'
  return native ? 'unknown' : null
}

/** Preserve the diagnostic and errno; attach only a bounded, public reason code. */
export function tagCodexStartupFailure(value, kind) {
  const error = value instanceof Error ? value : new Error(String(value))
  error.data = { ...(error.data && typeof error.data === 'object' ? error.data : {}), codexStartupKind: kind ?? codexStartupKind(error, true) }
  return error
}
