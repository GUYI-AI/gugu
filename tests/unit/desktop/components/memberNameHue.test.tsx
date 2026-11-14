// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoringAgentAvatar } from '../../../../apps/desktop/src/components/BoringAgentAvatar'
import { BubbleSender } from '../../../../apps/desktop/src/components/chat/MessageBubbleChrome'
import { BODY_COLORS } from '../../../../apps/desktop/src/components/agentAvatar/engine/identity'
import { resolveAgentLook } from '../../../../apps/desktop/src/components/agentAvatar/look'
import { boringAvatarAppearance } from '../../../../apps/desktop/src/lib/agentAvatarPalette'
import { AVATAR_PALETTE, avatarColorIndex } from '@gugu/core/shared/ui/avatarPalette'
import { dicebearAvatarDataUri } from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { memberNameHue } from '../../../../apps/desktop/src/lib/memberNameHue'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/store/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/store/auth')>(),
  useAuth: () => ({ user: null }),
}))
vi.mock('../../../../apps/desktop/src/lib/openMessageSender', () => ({ openMessageSender: vi.fn() }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const agents = ['agent-00000000-demo', 'agent-9e3779b1-demo', 'agent-3c6ef362-demo', 'agent-daa66d13-demo', 'agent-78dde6c4-demo', 'agent-b54cda26-demo', 'agent-8ff34739-demo', 'agent-c17c31a5-demo']
const upload = 'https://images.example/photo.png'
const savedLook = (color: string) => `https://images.example/agent-look/v1/${color}.webp?rest=shy&wear=`
let harness: ReturnType<typeof createReactHarness>
const hue = () => Number(harness.container.querySelector<HTMLElement>('.msg-sender')?.style.getPropertyValue('--member-hue'))
const sender = (id: string, type: 'agent' | 'human' = 'agent', avatar: string | null = null) => createNode(BubbleSender, {
  senderId: id, member: { type, avatar, displayName: 'Name' } as MemberProfileCardModel,
})
beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  installAssistantShellBridge()
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, () => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  harness.cleanup()
  delete document.documentElement.dataset.theme
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
  publishIdentityDirectory(null, null)
})

describe('sender-name avatar hue', () => {
  it.each(agents)('matches the rendered beam body for %s', async (id) => {
    const index = avatarColorIndex(id), body = AVATAR_PALETTE[index].light.body, expectedHue = BODY_COLORS[index].hue
    await harness.render(createNode('div', {}, createNode(BoringAgentAvatar, { id, name: 'Name', size: 32 }), sender(id)))
    expect(harness.container.querySelectorAll('svg g[mask] > rect')[1].getAttribute('fill')).toBe(body)
    expect(boringAvatarAppearance(id).body).toBe(body)
    expect(hue()).toBeCloseTo(expectedHue, 1)
    expect(memberNameHue({ id, isAgent: true })).toBe(hue())
  })

  it('preserves human-photo and custom-image names instead of guessing image colours', async () => {
    for (const type of ['human', 'agent'] as const) {
      await harness.render(sender(agents[0], type, upload))
      expect(hue()).toBe(BODY_COLORS[resolveAgentLook(agents[0], upload).color].hue)
    }
  })

  it.each(['human-ui4-a', 'human-ui4-b', 'human-ui4-c', 'human-ui4-d', 'human-ui4-e', 'abc'])('matches the actual DiceBear default background for human %s', async id => {
    const index = avatarColorIndex(id)
    expect(decodeURIComponent(dicebearAvatarDataUri(id))).toContain(AVATAR_PALETTE[index].light.human)
    await harness.render(sender(id, 'human'))
    expect(hue()).toBe(BODY_COLORS[index].hue)
  })

  it('tracks the assistant saved look through the same directory subscription used by its avatar', async () => {
    const id = agents[0]
    publishAssistantShell({ assistant: { id } } as AssistantShellSnapshot)
    const publishLook = (color: string) => publishIdentityDirectory({ [id]: { id, type: 'agent', avatar: savedLook(color) } as DisplayIdentity }, () => {})
    publishLook('sakura')
    await harness.render(sender(id))
    expect(hue()).toBe(BODY_COLORS[9].hue)
    await act(async () => publishLook('mint'))
    expect(hue()).toBe(BODY_COLORS[3].hue)
    expect(memberNameHue({ id, avatar: savedLook('sakura'), isAgent: true })).toBe(BODY_COLORS[avatarColorIndex(id)].hue)
  })
})
