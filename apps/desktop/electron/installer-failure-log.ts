import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * @@@install-failure-log — the Windows installer's transaction helper (build-resources/nsis/install-transaction.ps1)
 * appends one JSON line per failed install/update to `%ProgramData%\gugu\installer\<exe>.log`, because NSIS shows the
 * reason only in a details pane that vanishes with the window. On the next start the app copies every line it has not
 * reported yet into its own log. "Not reported yet" is tracked by the last reported line itself, not by comparing
 * timestamps: the installer and this process may disagree about the clock.
 */
export function installerFailureLogPath(programData: string, executablePath: string): string {
  // Windows-only file, so Windows path rules on every host (the unit tests run on Linux too).
  return win32.join(programData, 'gugu', 'installer', `${win32.basename(executablePath, win32.extname(executablePath))}.log`)
}

export function unreportedInstallerFailures(lines: readonly string[], lastReported: string | null): string[] {
  const entries = lines.filter((line) => line.trim())
  if (lastReported === null) return entries
  const at = entries.lastIndexOf(lastReported)
  // The reported line was trimmed away by the installer's 50-line cap: everything left is newer.
  return at === -1 ? entries : entries.slice(at + 1)
}

export function reportInstallerFailures(opts: {
  logPath: string
  seenPath: string
  report: (entry: unknown, raw: string) => void
}): number {
  if (!existsSync(opts.logPath)) return 0
  const lines = readFileSync(opts.logPath, 'utf8').split(/\r?\n/)
  const lastReported = existsSync(opts.seenPath) ? readFileSync(opts.seenPath, 'utf8') : null
  const fresh = unreportedInstallerFailures(lines, lastReported)
  for (const raw of fresh) {
    let entry: unknown = raw
    try { entry = JSON.parse(raw) } catch { /* keep the raw line: it is still the installer's own words */ }
    opts.report(entry, raw)
  }
  if (fresh.length) writeFileSync(opts.seenPath, fresh[fresh.length - 1]!, 'utf8')
  return fresh.length
}
