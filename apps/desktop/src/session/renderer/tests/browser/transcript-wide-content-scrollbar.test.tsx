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

const REPLY = [
  '三层能看到的程度各不相同：',
  '',
  '| 层 | 是什么 | 我能看到什么 |',
  '| --- | --- | --- |',
  '| 模型 | 运行在服务器上，负责理解问题、决定调用哪些工具、组织回答 | 看不到自己的权重，只能看到对话、工具返回的结果和系统提示里的说明文字 |',
  '| 命令行程序 | 在你电脑上执行读文件、跑命令的程序，所有工具调用都经过它 | 是打包好的单文件程序，能找到压缩后的 JavaScript 源码，但没有注释和类型 |',
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
  const sideways = [...root.querySelectorAll<HTMLElement>('*')].filter(el => getComputedStyle(el).overflowX === 'auto' && el.scrollWidth > el.clientWidth)
  expect(sideways.map(el => el.className), 'the table and the code line each overflow sideways').toHaveLength(2)
  // Headless Chromium hides every scrollbar (0px), so the paint is proven natively; this pins the cause: any
  // `scrollbar-width` / `scrollbar-color` on the box switches the themed ::-webkit-scrollbar off.
  for (const box of sideways) {
    const style = getComputedStyle(box)
    expect([style.scrollbarWidth, style.scrollbarColor], 'a system scrollbar setting would disable the themed one').toEqual(['auto', 'auto'])
  }
})
