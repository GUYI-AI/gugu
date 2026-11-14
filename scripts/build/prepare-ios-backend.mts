import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertNoLegacyEnvLocal, checkBuildEnv, decodeJwtClaims, envFileOrder, parseEnvFile,
  registryFileFor, resolveBuildEnv, selectTargetEnv,
} from './build-env-preflight.mts'

export interface IOSBackendConfiguration { version: 1; supabaseUrl: string; anonKey: string }

/** Uses the renderer's existing environment precedence; never exports a whole env or Session. */
export function resolveIOSBackend(root: string, env: Record<string, string | undefined>): IOSBackendConfiguration {
  assertNoLegacyEnvLocal(root)
  const read = (name: string) => {
    const file = path.join(root, name)
    return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : null
  }
  const target = env.GUGU_DB_TARGET
  const selection = target ? selectTargetEnv({ target, registryValues: read(registryFileFor(target)), shellEnv: env })
    : { injected: {}, errors: [] }
  if (selection.errors.length) throw new Error('iOS backend environment selection failed; run build-env-preflight for diagnostics')
  const resolved = resolveBuildEnv({
    processEnv: { ...env, ...selection.injected },
    envFiles: envFileOrder(env.GUGU_BUILD_MODE || 'production').map(name => ({ name, values: read(name) ?? {} })),
  })
  if (checkBuildEnv({ ...resolved, target }).errors.length) {
    throw new Error('iOS backend does not match the renderer environment; run build-env-preflight for diagnostics')
  }
  const supabaseUrl = resolved.renderer.url.value
  const anonKey = resolved.renderer.anonKey.value
  const url = new URL(supabaseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || anonKey.length > 16384 || /[\r\n]/.test(anonKey)) throw new Error('Invalid packaged iOS backend configuration')
  // These bytes ship to every device. A service-role or human access token must never enter the App.
  if (!anonKey.startsWith('sb_publishable_') && decodeJwtClaims(anonKey)?.role !== 'anon') {
    throw new Error('iOS backend requires a public anon or publishable key')
  }
  return { version: 1, supabaseUrl, anonKey }
}

export function writeIOSBackend(root: string, env: Record<string, string | undefined>): void {
  const directory = path.join(root, 'apps/mobile/ios/App/App/HostRuntime')
  const output = path.join(directory, 'GuguBackend.json')
  // A failed rebuild must not leave the previous environment looking current.
  rmSync(output, { force: true })
  const configuration = resolveIOSBackend(root, env)
  mkdirSync(directory, { recursive: true })
  const temporary = output + '.tmp'
  writeFileSync(temporary, JSON.stringify(configuration) + '\n', { mode: 0o644 })
  renameSync(temporary, output)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeIOSBackend(path.resolve(fileURLToPath(new URL('../..', import.meta.url))), process.env)
    console.log('Packaged public iOS backend configuration from the renderer environment')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'iOS backend preparation failed')
    process.exitCode = 1
  }
}
