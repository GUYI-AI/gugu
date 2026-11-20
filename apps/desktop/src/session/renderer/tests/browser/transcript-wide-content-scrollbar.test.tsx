import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { i18n } from '@/i18n'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import type { TranscriptTurn } from '@gugu/session-chat-ui'
import '@/i18n/registerSettingsCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

// Every cell caps at 24em (markdown.css), so the table's width is set by its column count, not by how wide the
// runner's fonts draw the text: eight columns of long text are wider than any desktop transcript.
const CELL = '运行在服务器上，负责理解问题、决定调用哪些工具、组织回答，看不到自己的权重'
const COLUMNS = 8
const REPLY = [
  '三层能看到的程度各不相同：',
  '',
  `| ${Array.from({ length: COLUMNS }, (_, i) => `列 ${i + 1}`).join(' | ')} |`,
  `| ${Array.from({ length: COLUMNS }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: COLUMNS }, () => CELL).join(' | ')} |`,
  '',
  '```powershell',
  `Get-ChildItem -Path "C:\\Users\\me\\AppData\\Local\\Programs\\gugu\\resources\\app\\node_modules\\${'deep\\'.repeat(20)}dist" -Recurse`,
  '```',
].join('\n')

// A table or a long code line scrolls sideways inside its own box. A mouse wheel cannot move that box, so on a pointer
// device the box carries the app's themed scrollbar: it takes layout space and its thumb is painted at rest. A system
// scrollbar there is an overlay on Windows — never painted at rest, so the clipped columns could not be reached.
it('leaves every sideways-scrolling box in a transcript reply to the themed scrollbar', async () => {
  await page.viewport(900, 800)
  await i18n.changeLanguage('zh-CN')
  const turns: TranscriptTurn[] = [{ id: 'wide-turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'wide-prompt', seq: 0, role: 'user', text: '能看到自己的代码吗' },
    { kind: 'message', id: 'wide-reply', seq: 1, role: 'assistant', text: REPLY },
  ] }]
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'height:760px;width:876px;padding:12px;display:flex;flex-direction:column;box-sizing:content-box;background:var(--bg)'
  await renderWithAppProviders(harness, <ThemeProvider theme="light"><SessionLocalizationProvider>
    <SessionTranscriptView uri="wide-content-scrollbar" turns={turns} mobile={false} />
  </SessionLocalizationProvider></ThemeProvider>)
  await until('the reply table and code line are drawn', () => !!harness.container.querySelector('.gg-md-table-scroll') && harness.container.textContent!.includes('Get-ChildItem'))

  const root = harness.container.querySelector<HTMLElement>('[data-chat-root]')!
  const table = root.querySelector<HTMLElement>('.gg-md-table-scroll')!
  const code = root.querySelector<HTMLElement>('[class*="codeWrapper"]')!
  const sideways = [...root.querySelectorAll<HTMLElement>('*')].filter(el => getComputedStyle(el).overflowX === 'auto' && el.scrollWidth > el.clientWidth)
  expect(sideways, 'the table box and the code box each overflow sideways').toEqual(expect.arrayContaining([table, code]))
  // Headless Chromium hides every scrollbar (0px), so the paint is proven natively; this pins the cause: any
  // `scrollbar-width` / `scrollbar-color` on the box switches the themed ::-webkit-scrollbar off.
  for (const box of sideways) {
    const style = getComputedStyle(box)
    expect([style.scrollbarWidth, style.scrollbarColor], 'a system scrollbar setting would disable the themed one').toEqual(['auto', 'auto'])
    // The box itself scrolls to its far edge: the clipped columns are reachable.
    box.scrollLeft = box.scrollWidth
    expect(box.scrollLeft + box.clientWidth, 'the box scrolls to its last column').toBeGreaterThanOrEqual(box.scrollWidth - 1)
  }
})
