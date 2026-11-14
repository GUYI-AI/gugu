// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtPanel } from '../../../../apps/desktop/src/components/agentsettings/AgentSharePane'
import { GroupInviteActions } from '../../../../apps/desktop/src/components/chat/GroupInviteShare'
import { GroupInviteQrShare } from '../../../../apps/desktop/src/components/contacts/GroupInvite'
import { MessageLoadFailure } from '../../../../apps/desktop/src/components/chat/MessageLoadFailure'
import { platform } from '../../../../apps/desktop/src/platform'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,cG5n', default: { toDataURL: async () => 'data:image/png;base64,cG5n' } }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {
  getGroupChatSettings: async () => ({ invite_link_enabled: true, public_id: 123, join_token: '0123456789abcdef0123456789abcdef' }),
  getGroupCollab: async () => ({ snapshot: { humans: [], agents: [] }, identities: [] }),
} }))
let harness: ReturnType<typeof createReactHarness>
const error = new Error('Clipboard denied /Users/test/private sk-synthetic-secret\nstack detail')
const reason = 'Clipboard denied [path] [redacted token]'
const writeText = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  writeText.mockReset().mockRejectedValue(error)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

describe('copy actions preserve the refusal', () => {
  it('shows the cause beside the external agent link', async () => {
    await renderWithAppProviders(harness, createNode(ExtPanel, { agent: contact({ id: 'agent', type: 'agent', agent_public: true, gugu_number: 5551234 }) }))
    await clickElement(harness.container.querySelector('[data-testid="agent-share-link"] + button')!)
    expect(writeText).toHaveBeenCalledWith('https://gugu.nextmind.space/j/?5551234')
    expect(harness.container.textContent).toContain(reason)
  })
  it('shows the cause when copying the group invite link', async () => {
    const toast = vi.fn()
    await renderWithAppProviders(harness, createNode(GroupInviteActions, { inviteLink: 'https://gugu.test/j/?123.abc', groupName: 'Group', snapshot: { humans: [], agents: [] } as never }), { toast })
    await clickElement(harness.container.querySelector('[data-testid="group-invite-copy-link"]')!)
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
  })
  it('shows the cause when copying the group link from its contacts page', async () => {
    const toast = vi.fn()
    await renderWithAppProviders(harness, createNode(GroupInviteQrShare, { group: { id: 'group', public_id: 123, kind: 'group', name: 'Group', avatar_url: null, member_count: 1, is_muted: false } }), { toast })
    await waitForCondition(() => harness.container.querySelector('[data-testid="group-invite-copy-link"]') !== null, 'invite link was never ready')
    await clickElement(harness.container.querySelector('[data-testid="group-invite-copy-link"]')!)
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
  })
  it('shows the clipboard refusal when copying message-load details', async () => {
    const toast = vi.fn()
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(error)
    await renderWithAppProviders(harness, createNode(MessageLoadFailure, { error: new Error('history unavailable'), onRetry: async () => {}, inline: false }), { toast })
    await clickElement(harness.container.querySelector('[data-testid="chat-load-details-toggle"]')!)
    await clickElement(harness.container.querySelector('[data-testid="chat-load-details-copy"]')!)
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
  })
})
