// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const installAttachment = vi.fn()
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: { installAttachment: (args: unknown) => installAttachment(args) } }))

const { openGroupApp } = await import('@/components/chat/GroupAppsHere')

const card = { source: { kind: 'message' }, messageId: 'msg-1' } as never

describe('a group App picked in its group\'s side panel', () => {
  beforeEach(() => installAttachment.mockReset())

  it('opens an App installed here directly', async () => {
    const open = vi.fn()
    await openGroupApp({ extensionId: 'board', name: 'Board', kind: 'board.main', iconDataUrl: null }, 'chat-1', open)
    expect(open).toHaveBeenCalledWith('board')
    expect(installAttachment).not.toHaveBeenCalled()
  })

  it('installs one only shared here from its card — in this group — then opens it', async () => {
    installAttachment.mockResolvedValue({ success: true, data: { outcome: 'confirmed' } })
    const open = vi.fn()
    await openGroupApp({ extensionId: 'board', name: 'Board', kind: '', iconDataUrl: null, card }, 'chat-1', open)
    expect(installAttachment).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1' }))
    expect(open).toHaveBeenCalledWith('board')
  })

  it('opens nothing when the install was refused or failed', async () => {
    const open = vi.fn()
    installAttachment.mockResolvedValueOnce({ success: true, data: { outcome: 'refused', reason: 'declined' } })
    await openGroupApp({ extensionId: 'board', name: 'Board', kind: '', iconDataUrl: null, card }, 'chat-1', open)
    installAttachment.mockResolvedValueOnce({ success: false, error: 'offline' })
    await openGroupApp({ extensionId: 'board', name: 'Board', kind: '', iconDataUrl: null, card }, 'chat-1', open)
    expect(open).not.toHaveBeenCalled()
  })
})
