import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { browserUseAppInstalled, buildSessionBundle, loadCodexAppServerCapabilities, setBrowserUseApp } from '../../../../apps/desktop/electron/capability-bundle'

const hosts: DesktopGuguMcpHost[] = []
afterEach(async () => {
  setBrowserUseApp(null)
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
})

describe('#7199 这台机器装没装 Browser Use', () => {
  const app = (extensionId: string, outdated?: true) => ({ extensionId, ...(outdated ? { outdated } : {}) })
  const programs = (installed: ReturnType<typeof app>[], refusals: Record<string, string> = {}) =>
    ({ installed: () => installed, agentToolsRefusal: (id: string) => refusals[id] ?? null })

  it('the Browser Use App running its own program counts, by its id, whatever its program is called', () => {
    expect(browserUseAppInstalled(programs([]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('computer-use'), app('plain')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('plain'), app('browser-use')]))).toBe(true)
  })

  it('switched off or no longer allowed to give agents tools: it does not count', () => {
    expect(browserUseAppInstalled(programs([app('browser-use')], { 'browser-use': 'Extension browser-use is turned off' }))).toBe(false)
    expect(browserUseAppInstalled(programs([app('browser-use')], { 'browser-use': 'Extension browser-use may no longer give agents tools' }))).toBe(false)
  })

  it('an outdated version (a program gugu once hosted) runs nothing, so it does not count', () => {
    expect(browserUseAppInstalled(programs([app('browser-use', true)]))).toBe(false)
  })
})

describe('#2401 Browser Use on a Gugu server follows the installed App, as on a desktop', () => {
  async function bundleFor(personalAssistant?: true) {
    const host = createDesktopGuguMcpHost()
    hosts.push(host)
    return buildSessionBundle({
      runtime: {
        authProvider: { getAuth: async () => ({ accessToken: 'token', userId: randomUUID() }) },
        env: { GUGU_HOME: '/tmp/gugu-browser-availability' },
      },
      agentUserId: randomUUID(),
      threadRootId: null,
      autonomy: null,
      socialBridgeDeps: { host, grantKey: `taskpage:${randomUUID()}`, getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon-key',
        ...(personalAssistant ? { personalAssistant, runSessionAction: async () => ({}) } : {}) },
    })
  }
  const ctx = { cwd: '/tmp/gugu-browser-availability', lifecycle: 'fresh' as const }
  it.each([true, false])('a server offers Browser Use exactly when its App is installed, never a ban (%s)', async installed => {
    for (const personalAssistant of [undefined, true] as const) {
      setBrowserUseApp({ server: true, installed: () => installed })
      const bundle = await bundleFor(personalAssistant)
      expect(bundle.browserUse).toBe(installed ? true : undefined)
      expect(bundle.disableNativeBrowser).toBe(true)
      const materialized = loadCodexAppServerCapabilities(bundle, ctx)
      expect(materialized.extraArgs).toEqual(expect.arrayContaining([
        'plugins.browser@openai-bundled.enabled=false', 'plugins.chrome@openai-bundled.enabled=false',
      ]))
      const text = materialized.developerInstructions ?? ''
      expect(text).not.toContain('Browser Use is not available')
      expect(text).not.toContain('Do not launch a replacement browser')
    }
  })

  it('a server whose App list cannot be read offers no Browser Use and still no ban', async () => {
    setBrowserUseApp({ server: true, installed: () => { throw new Error('unreadable') } })
    const bundle = await bundleFor()
    expect(bundle.browserUse).toBeUndefined()
    expect(bundle.disableNativeBrowser).toBe(true)
  })

  it.each([true, false])('keeps local App discovery and the Codex browser flag (%s)', async installed => {
    setBrowserUseApp({ server: false, installed: () => installed })
    const bundle = await bundleFor()
    expect(bundle.browserUse).toBe(installed ? true : undefined)
    expect(bundle.disableNativeBrowser).toBeUndefined()
    expect(loadCodexAppServerCapabilities(bundle, ctx).developerInstructions).not.toContain('Browser Use is not available')
  })
})
