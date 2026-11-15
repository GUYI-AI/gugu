// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '../../../../packages/core/src/shared/types/chat'
import { DirectMessageQuote, MessageQuote } from '../../../../apps/desktop/src/components/chat/MessageQuote'
import { MessageQuoteSourceContext } from '../../../../apps/desktop/src/components/chat/messageQuoteSource'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  setLocalePreference('zh-CN')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  setLocalePreference('zh-CN')
})

const source = { ...message({
  id: 'source', content_type: 'system', content: '这条消息没有迁移',
  client_message_id: 'migration-placeholder:120-135', sender_user_id: null,
}), sender_name: '未知用户' }
const reply = { ...message({
  reply_to_message_id: source.id, reply_to_sender_user_id: null,
  reply_to_content: source.content,
}), reply_to_sender_name: '未知用户' }

describe.each([['group', MessageQuote], ['direct', DirectMessageQuote]] as const)('%s reply to a message without a sender', (_kind, Component) => {
  async function render(msg: MessageItem = reply, loaded: MessageItem[] = []) {
    await renderWithAppProviders(harness, createElement(MessageQuoteSourceContext.Provider, {
      value: new Map(loaded.map(row => [row.id, row])),
    }, createElement(Component, { msg, quoterIsAgent: false, memberProfiles: {} })))
  }

  it.each([null, ''])('omits the sender and separator without reporting an error (sender=%s)', async sender => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ ...reply, reply_to_sender_user_id: sender })
    expect(harness.container.textContent).toBe('这条消息没有迁移')
    expect(harness.container.querySelector('.font-semibold')).toBeNull()
    expect([...harness.container.querySelectorAll<HTMLElement>('*')].some(node => node.style.fontWeight === '600')).toBe(false)
    expect(error).not.toHaveBeenCalled()
  })

  it('still reports a known sender whose profile is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ ...reply, reply_to_sender_user_id: 'known-sender' })
    expect(error).toHaveBeenCalledWith('[resolve-fail #1624] unresolved reply sender source')
  })

  it.each([
    ['en-US', 'This message was not migrated.'],
    ['zh-CN', '这条消息没有迁移'],
  ] as const)('localizes a loaded marked source in %s', async (locale, expected) => {
    setLocalePreference(locale)
    await render(reply, [source])
    expect(harness.container.textContent).toBe(_kind === 'direct' && locale === 'en-US' ? 'This message was not mig…' : expected)
  })

  it('keeps the preview when the source is not loaded', async () => {
    setLocalePreference('en-US')
    await render()
    expect(harness.container.textContent).toBe('这条消息没有迁移')
  })

  it('does not recognize an unmarked sentence or a source from another chat', async () => {
    setLocalePreference('en-US')
    await render(reply, [{ ...source, client_message_id: null }])
    expect(harness.container.textContent).toBe('这条消息没有迁移')
    await render(reply, [{ ...source, chat_id: 'another-chat' }])
    expect(harness.container.textContent).toBe('这条消息没有迁移')
  })

  it('updates a quote when its source arrives and when the interface language changes', async () => {
    setLocalePreference('en-US')
    await render()
    expect(harness.container.textContent).toBe('这条消息没有迁移')
    await render(reply, [source])
    expect(harness.container.textContent).toBe(_kind === 'direct' ? 'This message was not mig…' : 'This message was not migrated.')
    await act(async () => { setLocalePreference('zh-CN') })
    expect(harness.container.textContent).toBe('这条消息没有迁移')
  })
})
