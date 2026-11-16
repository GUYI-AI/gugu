import { platform } from '../platform'
import { replica } from './replica'

declare const __APP_VERSION__: string | undefined

// Vite replaces it at build time. Read when asked, never at module load (tests stub it later; without it: no ReferenceError).
function buildVersion(): string | undefined {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined
}

/** The running app's version: live `app.getVersion()`, else the build constant (`local`, the first frame). ❌ persisted: with `fresh: Infinity` it would outlive an upgrade. */
export const appVersion = replica({
  name: 'appVersion',
  scope: 'device',
  read: async (): Promise<string> => {
    if (platform.capabilities.appVersion) return platform.getAppVersion()
    const built = buildVersion()
    if (built === undefined) throw new Error('This build carries no app version')
    return built
  },
  local: () => buildVersion(),
  fresh: Infinity,
})
