import { describe, expect, it, vi } from 'vitest'
import { assemble } from '../../../../apps/desktop/src/lib/chatProjectionAlgebra'
import { decodeAccountSnapshot } from '../../../../apps/desktop/src/lib/accountSyncSnapshot'
import { chatPreviewText } from '../../../../apps/desktop/src/lib/systemNoticeText'
import { i18n } from '../../../../apps/desktop/src/i18n'

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {}, identityDb: {}, dataClient: {} }))

const at = '2026-11-10T00:00:00Z'
const person = (id: string, display_name: string) => ({ id, type: 'human', display_name, avatar: null, gugu_number: null, bio: null,
  owner_user_id: null, agent_public: null, desired_status: null, device_id: null, category: null, is_official: null, local_path: null,
  created_at: null, updated_at: null })
const snapshot = (sender: string, alias: string | null = null) => ({
  account_id: 'me', revision: '9', presence: {},
  chats: [{ id: 'g', public_id: null, kind: 'group', status: 'active', name: 'Group', avatar_url: null, created_at: at,
    next_message_seq: 4, pinned_message_id: null, source_chat_id: null, source_message_id: null }],
  memberships: ['me', 'peer'].map((user_id) => ({ chat_id: 'g', user_id, last_read_seq: 3, is_marked_unread: false, version: 1,
    notification_level: 'all', is_pinned: false, updated_at: at, joined_at: at, inbox_published_at: at, role: 'member' })),
  identities: [person('me', 'Me'), person('peer', 'Peer')],
  // The server's one preview definition: a recalled latest message previews as '[Recalled]', retracted_at marks it.
  previews: [{ chat_id: 'g', id: 'm3', created_at: at, preview: '[Recalled]', seq: 3, content_type: 'text', sender_user_id: sender,
    client_message_id: 'm3', preview_source: null, retracted_at: at }],
  unread: [],
  overrides: alias ? [{ target_kind: 'contact', contact_user_id: 'peer', alias }] : [],
})
const listLine = (value: ReturnType<typeof snapshot>) => {
  const row = assemble(decodeAccountSnapshot(value, 'me').cells, 'me').find((chat) => chat.id === 'g')!
  return chatPreviewText(row)
}

describe('a recalled latest message in the chat list', () => {
  it('says who recalled it, in the reader\'s language, never the placeholder or what it said', () => {
    expect(listLine(snapshot('peer'))).toBe(i18n.t('chatList.recalled', { ns: 'messaging', name: 'Peer' }))
    expect(listLine(snapshot('peer', 'My friend'))).toBe(i18n.t('chatList.recalled', { ns: 'messaging', name: 'My friend' }))
    expect(listLine(snapshot('me'))).toBe(i18n.t('chatList.recalledByMe', { ns: 'messaging' }))
    expect(listLine(snapshot('peer'))).not.toContain('[Recalled]')
    expect(listLine(snapshot('peer'))).toContain('Peer')
  })
})
