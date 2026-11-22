import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { i18n } from '@/i18n'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { GlobalSearch } from '@renderer/features/global-search/global-search'
import { resetSearchSession } from '@renderer/features/global-search/search-session'
import type { SearchView } from '@renderer/features/global-search/use-global-search'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

const { search } = vi.hoisted(() => ({ search: vi.fn<() => SearchView>() }))
vi.mock('@renderer/features/global-search/use-global-search', async (original) => ({
  ...await original<typeof import('@renderer/features/global-search/use-global-search')>(),
  useGlobalSearch: search,
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  resetSearchSession({ text: 'Wee' })
})
afterEach(() => {
  root.unmount()
  container.remove()
  resetSearchSession()
})

// Control only the read's answer; measure the real panel, translations, Unknown and CSS in Chromium.
function draw(tasks: boolean, counts: SearchView['counts'], capped = false) {
  search.mockReturnValue({ query: 'Wee', scopes: [], unresolved: null, hits: counts === null ? null : [],
    counts, capped, elsewhere: null, loading: counts === null, error: null, stale: false })
  flushSync(() => root.render(<SessionLocalizationProvider><GlobalSearch tasks={tasks} onClose={() => {}} onOpen={() => {}} /></SessionLocalizationProvider>))
  return [...container.querySelectorAll<HTMLElement>('[role=tab]')]
}
const bounds = (tabs: HTMLElement[]) => tabs.map((tab) => {
  const { x, y, width, height } = tab.getBoundingClientRect()
  return { x, y, width, height }
})

for (const language of ['en-US', 'zh-CN']) {
  for (const tasks of [true, false]) {
    it(`${language}/${tasks ? 'desktop' : 'phone'}: keeps filter positions and widths through unknown, zero and capped counts`, async () => {
      await page.viewport(tasks ? 900 : 360, 800)
      container.style.width = tasks ? '672px' : '360px'
      await i18n.changeLanguage(language)
      const unknown = draw(tasks, null)
      await document.fonts.ready
      expect(unknown).toHaveLength(tasks ? 4 : 3)
      expect(unknown.every((tab) => tab.querySelector('[data-unknown]'))).toBe(true)
      const initial = bounds(unknown)
      expect(initial.every((rect) => rect.width > 24 && rect.height > 0)).toBe(true)

      for (const value of [0, null, 1, 12, 99, 100, 0]) {
        const counts = value === null ? null : { all: value, message: value, task: value, file: value }
        const tabs = draw(tasks, counts, value === 100)
        expect(bounds(tabs), `counts=${value}`).toEqual(initial)
        for (const tab of tabs) {
          const slot = tab.lastElementChild as HTMLElement
          expect(slot.scrollWidth).toBeLessThanOrEqual(slot.clientWidth + 1)
          if (value === null) expect(slot.querySelector('[data-unknown]')).not.toBeNull()
          else expect(slot.textContent).toBe(value === 0 ? '' : value === 100 ? '100+' : String(value))
        }
      }
      const row = container.querySelector<HTMLElement>('[role=tablist]')!
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1)
    })
  }
}
