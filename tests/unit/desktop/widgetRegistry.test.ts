import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const mocks = vi.hoisted(() => ({ registry: new Map<string, unknown>(), rpc: vi.fn(), message: vi.fn(), error: null as { message: string } | null }))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.message } }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {
  rpc: mocks.rpc,
  from: () => ({ select: () => ({ eq: (column: string, value: string) => ({ maybeSingle: async () => ({ data: mocks.registry.get(`${column}:${value}`) ?? null, error: mocks.error }) }) }) }),
} }))
import { readMessageReference, widgetForOriginal } from '../../../apps/desktop/src/lib/widgetRegistry'

const spec = { v: 2, app: 'counter', view: 'main', text: 'Original', data: { count: 1 } }
const message = { id: 'origin', chat_id: 'chat', sender_user_id: 'author', content: JSON.stringify(spec), content_type: 'widget', retracted_at: null } as MessageItem
const registered = { id: 'widget', chat_id: 'chat', message_id: 'origin', created_by: 'author', ...spec }
beforeEach(() => { mocks.registry.clear(); mocks.rpc.mockReset(); mocks.message.mockReset(); mocks.error = null })

describe('registry-authoritative widget reads', () => {
  it('rejects a historical body alias and recovers the row belonging to this message', async () => {
    mocks.registry.set('id:forged', { ...registered, id: 'forged', message_id: 'someone-else', text: 'Secret' })
    mocks.registry.set('message_id:origin', registered)
    expect(await widgetForOriginal({ ...message, content: JSON.stringify({ ...spec, wid: 'forged' }) }))
      .toMatchObject({ id: 'widget', widget: { text: 'Original' }, senderId: 'author' })
  })
  it('shows an original the registry does not bind as text only, never by its forged body id', async () => {
    mocks.registry.set('id:forged', { ...registered, id: 'forged', message_id: 'someone-else' })
    expect(await widgetForOriginal({ ...message, content: JSON.stringify({ ...spec, wid: 'forged' }) })).toBeNull()
  })
  it('uses only the registered origin for a reference, retaining the original author and input', async () => {
    mocks.registry.set('id:widget', registered)
    mocks.message.mockResolvedValue({ ...message, content: JSON.stringify({ ...spec, text: 'Forged body', wid: 'forged' }) })
    expect(await readMessageReference({ kind: 'widget', widgetId: 'widget' }, 'viewer'))
      .toMatchObject({ status: 'readable', widget: { id: 'widget', widget: { text: 'Original' }, senderId: 'author' } })
    expect(mocks.message).toHaveBeenCalledWith('origin', 'viewer')
  })
  it('distinguishes a cold retraction without fetching or caching the hidden specification', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ widget_id: 'widget', origin_message_id: 'origin', is_retracted: true }], error: null })
    expect(await readMessageReference({ kind: 'widget', widgetId: 'widget' }, 'viewer')).toEqual({ status: 'retracted', widget: true })
    expect(mocks.rpc).toHaveBeenCalledWith('widget_origin', { p_widget_id: 'widget' })
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('reveals nothing for missing or differently scoped original messages, and surfaces query errors', async () => {
    mocks.registry.set('id:widget', registered)
    mocks.message.mockResolvedValue(null)
    expect(await readMessageReference({ kind: 'widget', widgetId: 'widget' }, 'viewer')).toEqual({ status: 'unreadable' })
    mocks.message.mockResolvedValue(message)
    expect(await readMessageReference({ kind: 'message', chatId: 'different-chat', messageId: 'origin' }, 'viewer')).toEqual({ status: 'unreadable' })
    mocks.error = { message: 'Offline' }
    await expect(widgetForOriginal(message)).rejects.toThrow('Offline')
  })
})
