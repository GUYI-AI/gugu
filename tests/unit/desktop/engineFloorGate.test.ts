// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_APIS, ENGINE_FLOOR, ENGINE_FLOOR_BUILD_TARGET } from '../../../scripts/build/engine-floor.mts'

/**
 * @@@engine-floor (apps/desktop/index.html): an engine below ENGINE_FLOOR never loads the app; it gets one plain page.
 * Runs the real inline script from the shipped HTML against a stubbed CSS.supports / Capacitor bridge.
 */
const html = readFileSync(resolve(process.cwd(), 'apps/desktop/index.html'), 'utf8')
const gate = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('<plaintext hidden>'))
if (!gate) throw new Error('engine-floor gate script not found in index.html')

function run(options: { supported: boolean; language: string; android: boolean }) {
  document.body.innerHTML = ''
  const write = vi.spyOn(document, 'write').mockImplementation(() => {})
  // The page builds itself once parsing ends; call that listener directly so no test leaves one behind.
  const loaded: (() => void)[] = []
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'DOMContentLoaded') loaded.push(listener as () => void)
  })
  // The gate reads the floor API's probe (window.CSSLayerBlockRule), which jsdom does not have.
  vi.stubGlobal('CSSLayerBlockRule', options.supported ? class CSSLayerBlockRule {} : undefined)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(options.language)
  const nativePromise = vi.fn((_plugin: string, method: string) =>
    Promise.resolve(method === 'startupContext' ? { enabled: true, attemptId: 'attempt-1' } : undefined))
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = options.android
    ? { getPlatform: () => 'android', nativePromise }
    : undefined
  new Function(gate!)()
  loaded.forEach(listener => listener())
  return { write, nativePromise }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as unknown as { Capacitor?: unknown }).Capacitor
})

describe('engine floor gate', () => {
  it('lets an engine at the floor load the app untouched', () => {
    const { write, nativePromise } = run({ supported: true, language: 'zh-CN', android: true })
    expect(write).not.toHaveBeenCalled()
    expect(nativePromise).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })

  it('stops an old Android WebView, explains the update, and hands the native splash a content frame', async () => {
    const { write, nativePromise } = run({ supported: false, language: 'zh-CN', android: true })
    expect(write).toHaveBeenCalledWith('<plaintext hidden>')
    expect(document.querySelector('h1')?.textContent).toBe('需要更新 Android System WebView')
    expect(document.querySelector('a')?.getAttribute('href'))
      .toBe('https://play.google.com/store/apps/details?id=com.google.android.webview')
    await vi.waitFor(() => expect(nativePromise).toHaveBeenCalledTimes(2))
    expect(nativePromise.mock.calls[1]).toEqual(['GuguShellChrome', 'startupContentReady', { attemptId: 'attempt-1' }])
  })

  it('tells an old browser elsewhere to update, in English, without a store link', () => {
    const { write } = run({ supported: false, language: 'en-US', android: false })
    expect(write).toHaveBeenCalledWith('<plaintext hidden>')
    expect(document.querySelector('h1')?.textContent).toBe('Update your browser')
    expect(document.querySelector('a')).toBeNull()
  })

  it('probes the API that sets ENGINE_FLOOR, and the renderer build targets the same floor', () => {
    const probed = Object.values(ENGINE_APIS).filter(api => api.probe && gate!.includes(api.probe))
    expect(probed.length).toBeGreaterThan(0)
    expect(Math.max(...probed.map(api => api.chrome))).toBe(ENGINE_FLOOR.chrome)
    expect(Math.max(...probed.map(api => api.safari))).toBe(ENGINE_FLOOR.safari)
    expect(ENGINE_FLOOR_BUILD_TARGET).toEqual([`chrome${ENGINE_FLOOR.chrome}`, `safari${ENGINE_FLOOR.safari}`])
    expect(readFileSync(resolve(process.cwd(), 'vite.config.mts'), 'utf8')).toContain('target: ENGINE_FLOOR_BUILD_TARGET,')
  })

  it('loads exactly the polyfill modules the floor table names, first in every entry', () => {
    const imported = [...readFileSync(resolve(process.cwd(), 'apps/desktop/src/lib/engine-polyfills.ts'), 'utf8')
      .matchAll(/^import '(.+?)'/gm)].map(m => m[1]).sort()
    expect(imported).toEqual([...new Set(Object.values(ENGINE_APIS).flatMap(api => api.polyfill ?? []))].sort())
    const moduleScripts = (entry: string) => [...readFileSync(resolve(process.cwd(), entry), 'utf8')
      .matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map(match => match[1])
    expect(moduleScripts('apps/desktop/index.html')[0]).toMatch(/src\/lib\/engine-polyfills\.ts$/)
    expect(moduleScripts('apps/desktop/session-embedded.html')).toEqual(['./src/session/renderer/embedded.tsx'])
    const embeddedEntry = readFileSync(resolve(process.cwd(), 'apps/desktop/src/session/renderer/embedded.tsx'), 'utf8')
    expect(embeddedEntry).toMatch(/^import '@\/lib\/engine-polyfills';/)
  })
})
