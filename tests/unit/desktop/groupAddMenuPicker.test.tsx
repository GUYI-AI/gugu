// @vitest-environment jsdom
//
// A group's 「+」 → 「添加成员」 draws the member picker in the shell, under the shell's contacts: the inner column's 「+」
// lives in the task page's own React root, which has no contacts provider, and a picker mounted beside it listed nobody
// (owner 11-14: Recent 0, People 0, "No contacts" in a project group and an ordinary group alike).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contact, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getGroupCollab: vi.fn(async () => ({ snapshot: { humans: [{ id: 'user-1', role: 'owner', type: 'human', account_status: null }], agents: [] }, identities: [] })),
    getGroupChatSettings: vi.fn(async () => ({ id: 'g1', name: 'Planning', my_role: 'owner', can_manage: true, allow_member_invite: false, invite_link_enabled: false, join_token: null })),
    listMyAgentJoinRequests: vi.fn(async () => new Map()),
    inviteGroupMember: vi.fn(),
  },
  GroupCollabEmptyError: class GroupCollabEmptyError extends Error {},
}))
vi.mock('../../../apps/desktop/src/lib/groupMemberPermissions', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isProjectGroupChat: () => false,
}))

const { GroupAddMenu } = await import('../../../apps/desktop/src/components/chat/GroupAddMenu')
const { GroupAddMembersHost } = await import('../../../apps/desktop/src/components/chat/GroupAddMembersSheet')

let shell: ReturnType<typeof createReactHarness>
let taskPage: ReturnType<typeof createReactHarness>
beforeEach(() => { shell = createReactHarness(); taskPage = createReactHarness() })
afterEach(() => { taskPage.cleanup(); shell.cleanup() })

const click = (el: Element | null) => act(async () => { (el as HTMLElement).click() })
const picker = () => document.querySelector<HTMLElement>('[role="dialog"]')

describe('a group 「+」 in a root without the shell providers', () => {
  it('「添加成员」 opens the shell\'s picker, which lists the friends and own agents', async () => {
    await renderWithAppProviders(shell, createNode(GroupAddMembersHost), {
      contacts: { contacts: [contact({ id: 'friend-1', display_name: 'Ada Friend' }), contact({ id: 'agent-1', display_name: 'Scout Agent', type: 'agent', owner_user_id: 'user-1' })] },
    })
    // The task page's root: no contacts, no auth, nothing of the shell.
    await taskPage.render(createNode(GroupAddMenu, { chatId: 'g1', canAddMembers: true }))
    await click(taskPage.container.querySelector('[data-group-add-menu]'))
    await waitForCondition(() => document.querySelector('[data-testid="group-add-members"]') !== null, 'the menu is open')
    await click(document.querySelector('[data-testid="group-add-members"]'))
    await waitForCondition(() => picker()?.textContent?.includes('Ada Friend') === true, 'the picker lists the friend')
    // Its sources count both: the friend under 个人, the own agent under its own heading.
    expect(picker()!.textContent).toMatch(/个人1/)
    expect(picker()!.textContent).toMatch(/Agent1/)
  })
})
