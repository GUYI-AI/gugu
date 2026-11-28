// One identity, one face: every surface that draws a face — React rows, headers, bubbles and mentions (`<Avatar>`) and the
// image-only ones (delivery cards, App pages, notifications, the share poster) — shows the string `identityFace` +
// `faceImageUrl` give for it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Avatar } from '@/components/Avatar'
import { lookObjectPath } from '@/components/assistantFigure/look'
import { installAssistantShellBridge, publishAssistantShell } from '@/lib/assistantShellBridge'
import { faceImageUrl, identityFace } from '@/lib/identityFace'
import { installIdentityDirectoryBridge, publishIdentityDirectory, readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { memberFace } from '@/lib/memberFaces'
import { senderAvatarUrl } from '@renderer/lib/chat/sender-avatar'
import { displayIdentity } from '../../../../../../../tests/support/testHarness'
import '@/styles/tokens.css'

const LOOK = `https://example.supabase.co/storage/v1/object/public/avatars/${lookObjectPath(3)}?rest=happy`
const people = [
  { id: 'agent-plain', type: 'agent' as const, avatar: null },
  { id: 'agent-with-look', type: 'agent' as const, avatar: LOOK },
  { id: 'agent-assistant', type: 'agent' as const, avatar: null },
  { id: 'human-plain', type: 'human' as const, avatar: null },
  { id: 'human-with-look', type: 'human' as const, avatar: LOOK },
]
const face = (id: string) => {
  const who = people.find((p) => p.id === id)!
  return faceImageUrl(identityFace({ id, avatar: who.avatar, type: who.type }), 'test')
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  installIdentityDirectoryBridge()
  publishIdentityDirectory(Object.fromEntries(people.map((p) => [p.id, displayIdentity(p.id, { type: p.type, display_name: p.id, avatar: p.avatar })])), null)
  installAssistantShellBridge()
  publishAssistantShell({ cloudAvailable: false, canHostHere: true, cloud: null, loadError: null,
    assistant: { id: 'agent-assistant', display_name: 'assistant', avatar: null, created_at: null },
    assistantState: 'found', ownerName: 'U', chatId: null, home: null, setup: null, member: false, preparing: false } as never)
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function drawn(node: React.ReactNode): Promise<HTMLImageElement | null> {
  await act(async () => root.render(node))
  return host.querySelector('img')
}

describe('an ordinary agent', () => {
  it('row, header, bubble (caller knows it is an agent): the same beam as the image path, at 19px', async () => {
    const img = await drawn(<Avatar name="a" seed="agent-plain" isAgent size={19} />)
    expect(img?.dataset.face).toBe('agent')
    expect(img?.getAttribute('src')).toBe(face('agent-plain'))
  })

  it('mention and group tile (caller passes only the id): the directory says agent, same beam', async () => {
    const img = await drawn(<Avatar name="a" seed="agent-plain" size={19} />)
    expect(img?.getAttribute('src')).toBe(face('agent-plain'))
  })

  it('a stored look address still draws the beam, never the bird', async () => {
    const img = await drawn(<Avatar name="a" seed="agent-with-look" avatarUrl={LOOK} isAgent size={32} />)
    expect(host.querySelector('canvas')).toBeNull()
    expect(img?.getAttribute('src')).toBe(face('agent-with-look'))
    expect(face('agent-with-look')).toBe(faceImageUrl(identityFace({ id: 'agent-with-look', avatar: null, type: 'agent' }), 'test'))
  })

  it('delivery card, both address forms: the same string', () => {
    const bridge = readIdentityDirectoryBridge()!
    expect(senderAvatarUrl('user:agent-plain', bridge)).toBe(face('agent-plain'))
    expect(senderAvatarUrl('session:s1', bridge, () => 'agent-plain')).toBe(face('agent-plain'))
  })

  it('App page member, OS notification and phone tab (memberFace): the same string', async () => {
    expect(await memberFace('agent-plain', null)).toBe(face('agent-plain'))
  })
})

describe('the assistant', () => {
  it('is the one identity that animates; its still poster is the image-path string', async () => {
    await drawn(<Avatar name="a" seed="agent-assistant" isAgent size={40} />)
    expect(host.querySelector('canvas[data-assistant-figure]')).not.toBeNull()
    const still = await drawn(<Avatar name="a" seed="agent-assistant" isAgent size={19} still />)
    expect(still?.getAttribute('src')).toBe(face('agent-assistant'))
  })
})

describe('a human', () => {
  it('default face: the same Notionists string on every path', async () => {
    const img = await drawn(<Avatar name="h" seed="human-plain" isAgent={false} size={19} />)
    expect(img?.dataset.face).toBe('human')
    expect(img?.getAttribute('src')).toBe(face('human-plain'))
    expect(senderAvatarUrl('user:human-plain', readIdentityDirectoryBridge()!)).toBe(face('human-plain'))
  })

  it('a look address on a human is just a picture', async () => {
    const img = await drawn(<Avatar name="h" seed="human-with-look" avatarUrl={LOOK} isAgent={false} size={32} />)
    expect(img?.dataset.face).toBe('picture')
    expect(img?.getAttribute('src')).toBe(LOOK)
    expect(face('human-with-look')).toBe(LOOK)
  })
})

it('a dirty sentinel avatar is the unavailable state on every path, never a stand-in face', async () => {
  await drawn(<Avatar name="x" seed="agent-plain" avatarUrl="undefined" isAgent size={32} />)
  expect(host.querySelector('[data-avatar-error]')).not.toBeNull()
  expect(faceImageUrl(identityFace({ id: 'agent-plain', avatar: 'undefined', type: 'agent' }), 'test')).toBeNull()
})
