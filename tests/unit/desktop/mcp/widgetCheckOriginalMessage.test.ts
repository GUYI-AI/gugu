import { beforeEach, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSessionpageTools } from '../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'

const io = vi.hoisted(() => ({ restGet: vi.fn(), restRpc: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', async original => {
  const actual = await original<Record<string, (...args: unknown[]) => unknown>>()
  return { ...actual, widgetCheckScopeOf: (context: unknown, target: unknown) => actual.widgetCheckScopeOf!(context, target, io) }
})
const { runAppAction } = await import('../../../../apps/desktop/electron/mcp/app-tool-host')
const { EXTENSION_TOOL_DEFS } = await import('../../../../apps/desktop/electron/mcp/gugu-extension-tool')
const messageId = '44444444-4444-4444-8444-444444444444'
const widgetId = 'registered:widget/one'
const context = { kind: 'social', agentId: 'agent-1', supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' } as Parameters<typeof runAppAction>[1]
let registeredId = widgetId, bodyWid = widgetId, visible = true, member = true, retracted = false, deleted = false
const contentOf = () => JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', wid: bodyWid, data: { file: 'poll.json' } })
beforeEach(() => {
  registeredId = bodyWid = widgetId; visible = member = true; retracted = deleted = false
  io.restGet.mockReset().mockResolvedValue([])
  io.restRpc.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'widget_origin') {
      if (args.p_widget_id === registeredId) return [{ widget_id: registeredId, origin_message_id: messageId, is_retracted: retracted }]
      // Another message's widget, which a forged historical body may name.
      return args.p_widget_id === 'someone-elses-widget' ? [{ widget_id: 'someone-elses-widget', origin_message_id: 'other-message', is_retracted: false }] : []
    }
    // The server reads as the agent: a whisper it is no party to, or a chat it is not in, has no row.
    if (name === 'messages_by_id_as') {
      return visible && member && args.p_as === 'agent-1' && args.p_id === messageId
        ? [{ id: messageId, chat_id: 'chat-1', sender_user_id: 'sender', content_type: 'widget', content: contentOf(), retracted_at: retracted ? '2026-11-03' : null, deleted_for_me: deleted }] : []
    }
    throw new Error(`Unexpected RPC ${name}`)
  })
})

async function check(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'widget-original', version: '1' })
  const register = vi.spyOn(server, 'registerTool'), run = vi.fn(async () => ({ loaded: true }))
  registerSessionpageTools(server, [EXTENSION_TOOL_DEFS.find(tool => tool.name === 'app_check')!], action => runAppAction(action, context, run, undefined), name => name, work => work)
  const callback = register.mock.calls[0]![2] as (args: unknown, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean; content?: unknown }>
  return { result: await callback(args, { signal: new AbortController().signal }), run }
}

it('checks a typed original message when the registered widget has a different id', async () => {
  const { result, run } = await check({ message_id: `msg:${messageId}` })
  expect(result, JSON.stringify(result)).not.toHaveProperty('isError', true)
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ widget: expect.objectContaining({ id: widgetId, originMessageId: messageId, senderId: 'sender' }) }), undefined)
  expect(io.restRpc).toHaveBeenCalledWith('widget_origin', { p_widget_id: widgetId })
  expect(io.restGet).not.toHaveBeenCalled()
})

it('keeps a historical message on its own id when its body names another widget', async () => {
  registeredId = messageId; bodyWid = 'someone-elses-widget'
  const { result, run } = await check({ message_id: `msg:${messageId}` })
  expect(result, JSON.stringify(result)).not.toHaveProperty('isError', true)
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ widget: expect.objectContaining({ id: messageId, originMessageId: messageId }) }), undefined)
})

it('keeps the widget-id entry and legacy message-equals-widget registration', async () => {
  expect((await check({ widget_id: widgetId })).result).not.toHaveProperty('isError', true)
  registeredId = messageId; bodyWid = ''
  const { result, run } = await check({ message_id: `msg:${messageId}` })
  expect(result).not.toHaveProperty('isError', true)
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ widget: expect.objectContaining({ id: messageId, originMessageId: messageId }) }), undefined)
})

it.each(['hidden', 'nonmember', 'retracted', 'personally deleted'])('does not dispatch an original %s message', async state => {
  visible = state !== 'hidden'; member = state !== 'nonmember'; retracted = state === 'retracted'; deleted = state === 'personally deleted'
  const { result, run } = await check({ message_id: `msg:${messageId}` })
  expect(result.isError).toBe(true)
  expect(run).not.toHaveBeenCalled()
})
