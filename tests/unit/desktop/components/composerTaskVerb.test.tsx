// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the composer's 「新任务」 button: where the task page's one-list sidebar is mounted (the desktop) it reads
// 「新智能体」 with the pen of 创建智能体 (mock v33 派智能体); where it is not (the phone) it stays 「新任务」. Same action.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComposerVerbs } from '../../../../apps/desktop/src/components/chat/ComposerVerbs'
import { SquarePen, Zap } from '../../../../apps/desktop/src/lib/icons'
import { publishSidebarChatView } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { readComposerVerbChat, setComposerVerb, takeComposerCarry, useComposerVerb } from '../../../../apps/desktop/src/lib/composerVerbBridge'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  publishSidebarChatView({ focusedChatId: null, groups: [] })
  setComposerVerb('chat', null)
  takeComposerCarry('chat')
})

let verb: string | null = null
function Verb() { verb = useComposerVerb('chat'); return null }
const button = () => harness.container.querySelector<HTMLElement>('[data-testid="composer-verb-task"]')!
/** The glyph an icon draws (its path body), read back through the same DOM serializer as the button's. */
function glyph(markup: string): string {
  const probe = document.createElement('div')
  probe.innerHTML = markup
  return probe.querySelector('svg')!.innerHTML
}
async function renderVerbs() {
  await renderWithAppProviders(harness, (
    <InChatSlot.Provider value={{ projectName: null }}>
      <Verb />
      <ComposerVerbs chatId="chat" isGroupChat draft={() => ''} onCarried={() => {}} />
    </InChatSlot.Provider>
  ))
}

describe('ComposerVerbs task button', () => {
  it('reads 新任务 with the lightning where no one-list sidebar is mounted (the phone)', async () => {
    await renderVerbs()
    expect(button().textContent).toBe('新任务')
    expect(button().getAttribute('aria-label')).toBe('新任务')
    expect(button().querySelector('svg')!.innerHTML).toBe(glyph(renderToStaticMarkup(<Zap size={14} />)))
  })

  it('reads 新智能体 with the pen when the sidebar is one list, and still opens the new-task box', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    await renderVerbs()
    expect(button().textContent).toBe('新智能体')
    expect(button().getAttribute('aria-label')).toBe('新智能体')
    expect(button().querySelector('svg')!.innerHTML).toBe(glyph(renderToStaticMarkup(<SquarePen size={14} />)))
    expect(glyph(renderToStaticMarkup(<SquarePen size={14} />))).not.toBe(glyph(renderToStaticMarkup(<Zap size={14} />)))
    await clickElement(button())
    expect(verb).toBe('task')
    expect(readComposerVerbChat('chat')).toEqual({ name: '', joinable: false })
  })
})
