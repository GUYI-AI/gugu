const remedies = {
  invalid: ' is not valid assistant settings. Back up this file, correct it to a JSON object, then retry.',
  read: ' could not be read. Check the file and its permissions, then retry.',
  backup: ' could not be backed up. Check disk space and folder permissions, then retry.',
  write: ' could not be saved. Check disk space and folder permissions, then retry.',
} as const

export type AssistantFileOperation = keyof typeof remedies

/** Only host-authored file failures may disclose a repair path, never the settings content. */
export class AssistantFileError extends Error {
  constructor(readonly path: string, readonly operation: AssistantFileOperation, cause: unknown) {
    super(`Assistant file ${JSON.stringify(path)}${remedies[operation]}`, { cause })
  }
}

/** The same sentence survives Electron's Error serialization and the unified failure outlet. */
export function assistantFileFailure(message: string): { path: string; operation: AssistantFileOperation } | null {
  const text = message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
  if (!text.startsWith('Assistant file ')) return null
  for (const operation of Object.keys(remedies) as AssistantFileOperation[]) {
    const suffix = remedies[operation]
    if (!text.endsWith(suffix)) continue
    try {
      const encoded = text.slice('Assistant file '.length, -suffix.length)
      const path: unknown = JSON.parse(encoded)
      if (typeof path === 'string' && path.length <= 4096 && !/\p{Cc}/u.test(path)
        && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && JSON.stringify(path) === encoded) return { path, operation }
    } catch { /* Other failures retain the ordinary redacted outlet. */ }
  }
  return null
}
