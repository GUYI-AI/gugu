import { platform } from '../platform'
import { replica } from './replica'

declare const __APP_VERSION__: string | undefined

// Vite replaces it at build time. Read when asked, never at module load: a test that stubs it does so after this module
// loads, and an environment without it (a unit test rendering the app) must not throw a ReferenceError.
function buildVersion(): string | undefined {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined
}

/**
 * The running app's version (this device): the live `app.getVersion()` where the platform has it, else the build-time
 * version. The same for the whole run: read once. The build constant is the first source (`local`), so the first frame
 * has a value (stale until the platform answers, identical in practice). ❌ persisted: with `fresh: Infinity` a kept
 * value would be the version before an upgrade for the whole run.
 */
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
