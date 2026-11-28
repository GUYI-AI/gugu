import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { RunningTokenBar, type RunningToken } from '@/components/RunningTokenBar'
import { ROW_HOVER_CARD_OPEN_DELAY_MS } from '@/components/ui/rowHoverCardController'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

// A running pill's hover card: its top line (who, state, tool calls) opens the agent's session, through the same entry as
// the agent's profile card (onOpenUserChat with the session). The card's content and the session directory are not this
// contract: the card is a stand-in that draws the top line only when it is given something to open, and the lookup finds a
// session for the viewer's own agent only.
vi.mock('@/components/Avatar', () => ({ Avatar: () => <span /> }))
vi.mock('@/components/MessagePreviewCard', () => ({
  MessagePreviewCard: ({ onOpenSession }: { onOpenSession?: () => void }) => <div data-testid="card">
    {onOpenSession ? <button type="button" data-preview-open="" onClick={onOpenSession}>top line</button> : <div>top line</div>}
  </div>,
}))
vi.mock('@/components/session-watch/useAgentSessionRow', () => ({
  useAgentSessionEntry: (id: string | null) => id === 'mine' ? { projectId: 'p1', sessionId: 's1' } : undefined,
}))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))

let harness: ReturnType<typeof createReactHarness> | null = null
const token = (id: string, mine: boolean): RunningToken => ({ id, name: id, avatarUrl: null, avatarSeed: id, stateKey: 'running', toolCount: 11, lastActiveAt: null, mine })
const pill = (id: string) => document.querySelector<HTMLElement>(`.rtb-bar > [data-message-preview-trigger="${id}"]`)!
const park = () => document.querySelector<HTMLElement>('[data-park]')!
const card = () => document.querySelector<HTMLElement>('[data-testid="card"]')

beforeEach(async () => {
  await page.viewport(1000, 700)
  await i18n.changeLanguage('en-US')
})
afterEach(() => {
  vi.useRealTimers()
  harness?.cleanup()
  harness = null
})

async function openCard(id: string) {
  await userEvent.hover(park())
  await until('the card is closed', () => card() === null)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await userEvent.hover(pill(id))
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  vi.useRealTimers()
  await until('the card opens', () => card() !== null)
}

it('opens the own agent\'s session from the card\'s top line, and offers nothing for someone else\'s agent', async () => {
  const onTokenOpen = vi.fn()
  harness = createReactHarness()
  await harness.render(<>
    <div style={{ position: 'fixed', left: 300, top: 500, width: 600 }}>
      <RunningTokenBar tokens={[token('mine', true), token('theirs', false)]} previewChatId="chat-1" onTokenOpen={onTokenOpen} onTokenClick={vi.fn()} />
    </div>
    <div data-park="" style={{ position: 'fixed', right: 0, bottom: 0, width: 80, height: 80 }} />
  </>)
  await until('the pills are laid out', () => pill('theirs')?.getBoundingClientRect().width > 0)

  await openCard('theirs')
  expect(document.querySelector('[data-preview-open]'), 'not the viewer\'s agent: no session to open').toBeNull()

  await openCard('mine')
  document.querySelector<HTMLElement>('[data-preview-open]')!.click()
  expect(onTokenOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'mine', type: 'agent', session: { projectId: 'p1', sessionId: 's1' } }))
  await until('the card closes as the session opens', () => card() === null)
})
