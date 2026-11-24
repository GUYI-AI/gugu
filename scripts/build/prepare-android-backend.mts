import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveIOSBackend as resolvePackagedBackend } from './prepare-ios-backend.mts'

/** Both native shells use the renderer's environment resolver and public-key checks. */
export function writeAndroidBackend(root: string, env: Record<string, string | undefined>): void {
  const directory = path.join(root, 'apps/mobile/android/app/build/generated/account-closure-backend/assets')
  const output = path.join(directory, 'GuguBackend.json')
  // Never leave the last environment usable after a failed configuration change.
  rmSync(output, { force: true })
  const configuration = resolvePackagedBackend(root, env)
  mkdirSync(directory, { recursive: true })
  const temporary = output + '.tmp'
  writeFileSync(temporary, JSON.stringify(configuration) + '\n', { mode: 0o644 })
  renameSync(temporary, output)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeAndroidBackend(path.resolve(fileURLToPath(new URL('../..', import.meta.url))), process.env)
    console.log('Packaged public Android backend configuration from the renderer environment')
  } catch {
    console.error('Android backend preparation failed; run build-env-preflight for diagnostics')
    process.exitCode = 1
  }
}
