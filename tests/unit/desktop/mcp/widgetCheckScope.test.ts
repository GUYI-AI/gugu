import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — injected MCP host is an untyped ESM module.
import { widgetCheckScopeOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const messageId = '44444444-4444-4444-8444-444444444444'
const widgetId = 'registered:widget/one'
const agentId = 'agent-1', chatId = 'chat-1'
const context = { agentId, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' }
const content = JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', data: { file: 'poll.json' } })
function source(overrides: Record<string, unknown> = {}, visible = true, members = [agentId], registered = true) {
  const restGet = vi.fn(async () => [])
  const restRpc = vi.fn(async (name: string, args: unknown) => {
    if (name === 'widget_origin') {
      return registered && (args as { p_widget_id: string }).p_widget_id === widgetId
        ? [{ widget_id: widgetId, origin_message_id: messageId, is_retracted: false }] : []
    }
    // The server reads as the agent: hidden from it, or a chat it is not in, there is no row.
    expect(name).toBe('messages_by_id_as')
    const { p_as, p_id } = args as Record<string, string>
    if (p_as !== agentId || p_id !== messageId || !visible || !members.includes(agentId)) return []
    return [{ id: messageId, chat_id: chatId, sender_user_id: 'sender-1', content_type: 'widget', content, retracted_at: null, deleted_for_me: false, ...overrides }]
  })
  return { restGet, restRpc }
}

describe('widget checks resolve the registry origin before using immutable input', () => {
  it('uses a text widget id while retaining the original sender and message', async () => {
    const deps = source()
    await expect(widgetCheckScopeOf(context, widgetId, deps)).resolves.toEqual({
      tabKind: 'vote.poll', chatId, widget: { id: widgetId, originMessageId: messageId, messageId, senderId: 'sender-1', text: 'Dinner', data: { file: 'poll.json' } },
    })
    expect(deps.restGet).not.toHaveBeenCalled()
    expect(deps.restRpc).toHaveBeenCalledWith('widget_origin', { p_widget_id: widgetId, p_as: agentId })
    expect(deps.restRpc.mock.calls.map(([name]) => name)).toEqual(['widget_origin', 'messages_by_id_as'])
  })
  it('preserves the original message height in the checked widget scope', async () => {
    const deps = source({ content: JSON.stringify({ ...JSON.parse(content), height: 360 }) })
    expect((await widgetCheckScopeOf(context, widgetId, deps)).widget.height).toBe(360)
  })
  it.each([9999, 1.5])('omits invalid message height %s', async height => {
    const deps = source({ content: JSON.stringify({ ...JSON.parse(content), height }) })
    expect((await widgetCheckScopeOf(context, widgetId, deps)).widget).not.toHaveProperty('height')
  })
  it.each([
    ['missing registry', {}, true, [agentId], false],
    ['hidden whisper or before joining', {}, false, [agentId], true],
    ['not a member', {}, true, ['other'], true],
    ['ordinary origin', { content_type: 'text' }, true, [agentId], true],
    ['retracted origin', { retracted_at: '2026-11-03' }, true, [agentId], true],
    ['deleted for this agent', { deleted_for_me: true }, true, [agentId], true],
  ] as const)('%s reveals no widget information', async (_name, overrides, visible, members, registered) => {
    const deps = source(overrides, visible, [...members], registered)
    await expect(widgetCheckScopeOf(context, widgetId, deps)).rejects.toThrow(`app_check: there is no widget message ${widgetId} you can read`)
  })
  it('ignores a forged historical body wid instead of claiming another widget', async () => {
    const deps = source({ content: JSON.stringify({ ...JSON.parse(content), wid: 'someone-elses-widget' }) })
    expect((await widgetCheckScopeOf(context, widgetId, deps)).widget.id).toBe(widgetId)
  })
  it.each([null, '', '\0bad'])('rejects invalid text id %s before querying', async id => {
    const deps = source()
    await expect(widgetCheckScopeOf(context, id, deps)).rejects.toThrow(`app_check: there is no widget message ${id} you can read`)
    expect(deps.restGet).not.toHaveBeenCalled()
    expect(deps.restRpc).not.toHaveBeenCalled()
  })
  it('explains a reference-message id through the shared AST only after permission checks', async () => {
    const text = 'gugu-widget://legacy\n\ngugu-widget://other'
    await expect(widgetCheckScopeOf(context, messageId, source({ content: text }, true, [agentId], false))).rejects.toThrow('pass its widget_id')
    await expect(widgetCheckScopeOf(context, messageId, source({ content: text }, false, [agentId], false))).rejects.toThrow(`there is no widget message ${messageId} you can read`)
    await expect(widgetCheckScopeOf(context, messageId, source({ content: '> gugu-widget://legacy' }, true, [agentId], false))).rejects.toThrow(`there is no widget message ${messageId} you can read`)
  })
})
