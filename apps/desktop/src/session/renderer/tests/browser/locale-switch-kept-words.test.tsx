/**
 * Words that are kept across renders (a memo, a memoized row, an `observer`) follow the app's language when it is
 * switched — through the app's own setting, without a reload. Each case draws its surface in English, switches to
 * Chinese, waits for the Chinese words, and switches back.
 */
import { useRef } from 'react'
import { afterEach, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { setLocalePreference } from '@/i18n'
import { formatCalendarDay } from '@/i18n/format'
import { i18n } from '@/i18n'
import { registerSessionLocaleResources } from '@renderer/localization/locale-store'
import { MENTION_ALL_USER_ID } from '@/lib/mention'
import { selectionMenu } from '@/session/shared/extensions/file-selection'
import type { FlowListHandle } from '@/lib/flowList'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

const { FileTextContent } = await import('@/components/preview/FileTextContent')
const { MessageList } = await import('@/components/chat/MessageList')
const { useMentionRender } = await import('@/components/chat/useMentionRender')
const { usePhoneBackgroundTasks } = await import('@/components/session-watch/background-tasks')

registerSessionLocaleResources()
/** A session word in a given language (the session namespace interpolates `{x}`). */
const say = (key: string, locale: 'en-US' | 'zh-CN', values: Record<string, string> = {}) =>
  i18n.t(key, { ns: 'session', lng: locale, ...values, interpolation: { prefix: '{', suffix: '}' } })

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined; document.getSelection()?.removeAllRanges(); setLocalePreference('system') })

/** English drawn, then Chinese without a reload, then English again: `read` must give `words(locale)` each time. */
async function followsTheLanguage(read: () => string | null | undefined, words: (locale: 'en-US' | 'zh-CN') => string) {
  await until('drawn in English', read, (text) => text === words('en-US'))
  setLocalePreference('zh-CN')
  await until('the kept words switch to Chinese', read, (text) => text === words('zh-CN'))
  setLocalePreference('en-US')
  await until('and back to English', read, (text) => text === words('en-US'))
}
const noop = () => {}

it('a file\'s selection menu (its labels are kept for the selection)', async () => {
  setLocalePreference('en-US')
  await page.viewport(1000, 700)
  harness = createReactHarness()
  harness.container.style.cssText = 'width:480px;padding-top:100px'
  const file = { name: 'notes.txt', target: '/home/me/notes.txt' }
  await harness.render(<FileTextContent kind="text" content={'first\nsecond'} selectable={{ conversation: { kind: 'chat', chatId: 'g-1' }, file, cite: noop, sends: false }} />)
  await until('source lines drawn', () => harness!.container.querySelectorAll('.gg-file-source-row').length === 2)
  const range = document.createRange()
  range.selectNodeContents(harness.container.querySelector('[data-file-line="2"]')!)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  const labels = () => [...document.querySelectorAll<HTMLElement>('.gugu-selection-menu button')].map((button) => button.textContent).join('|')
  await followsTheLanguage(labels, (locale) => selectionMenu({ kind: 'chat', chatId: 'g-1' }, true, false, locale).map((item) => item.label).join('|'))
})

it('a chat\'s date divider (a memoized row)', async () => {
  setLocalePreference('en-US')
  await page.viewport(900, 700)
  harness = createReactHarness()
  const at = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  const messages = [message({ id: 'd1', seq: 1, chat_id: 'dated', sender_user_id: 'peer', created_at: at, content: 'hello' })]
  function Conversation() {
    const listRef = useRef<FlowListHandle | null>(null)
    const rows = messages.map((msg) => ({ type: 'message' as const, message: msg }))
    const rowProps = { rows, messages, mobile: false, memberReadSeqs: {}, deliveryWaits: new Map(), recipientFacts: { agentIds: new Set<string>(), wakes: new Map() }, memberProfiles: {},
      isGroupChat: true, onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, selectMode: false,
      selectedIds: new Set<string>(), onToggleSelect: noop, onEnterSelectMode: noop, flashMessageId: null, threeParty: undefined,
      readReceiptHandle: undefined, memberProfileOpener: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
      agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onMentionMember: undefined }
    return <div style={{ height: 500, display: 'flex', flexDirection: 'column' }}>
      <MessageList rows={rows} rowProps={rowProps as never} resetKey="dated" listRef={listRef} followTail />
    </div>
  }
  await renderWithAppProviders(harness, <Conversation />)
  const divider = () => harness!.container.querySelector('[data-msg-id="d1"]')?.closest('[data-msg-id]')?.textContent?.match(new RegExp(escape(formatCalendarDay(at, { withTime: true }, 'en-US')) + '|' + escape(formatCalendarDay(at, { withTime: true }, 'zh-CN'))))?.[0]
  await followsTheLanguage(divider, (locale) => formatCalendarDay(at, { withTime: true }, locale))
})
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

it('a group message\'s @all badge (the mention render is memoized)', async () => {
  setLocalePreference('en-US')
  harness = createReactHarness()
  function Badge() {
    const render = useMentionRender({ to_user_ids: [MENTION_ALL_USER_ID], is_whisper: false, content: 'hi everyone', reply_to_sender_user_id: null }, true, {})
    return <span data-badge>{render.fallbackLabels.join('|')}</span>
  }
  await harness.render(<Badge />)
  await followsTheLanguage(() => harness!.container.querySelector('[data-badge]')?.textContent,
    (locale) => i18n.t('composer.memberType.all', { ns: 'messaging', lng: locale }))
})

it('a phone\'s background roster names an unnamed subagent (the roster is memoized)', async () => {
  setLocalePreference('en-US')
  harness = createReactHarness()
  const turns: TranscriptTurn[] = [{ id: 't', seq: 0, initiator: 'user', startedAt: Date.now() - 1000, items: [
    { kind: 'spawn-subagent-tool-call', id: 'launch', seq: 0, toolCallId: 'launch', title: '', name: '', status: 'done', background: true, agentStatus: 'running', children: [] },
  ] } as unknown as TranscriptTurn]
  // Stable inputs, as the timeline hands them: only the language changes.
  const steps: never[] = []
  function Roster() {
    const tasks = usePhoneBackgroundTasks('device', 'session', turns, 0, true, steps)
    return <span data-roster>{tasks.subagents.map((entry) => entry.name).join('|')}</span>
  }
  await renderWithAppProviders(harness, <Roster />)
  await followsTheLanguage(() => harness!.container.querySelector('[data-roster]')?.textContent,
    (locale) => say('transcript.subagent', locale))
})
