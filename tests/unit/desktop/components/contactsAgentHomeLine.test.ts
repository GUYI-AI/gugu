import type { DragEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHomeLine } from '../../../../apps/desktop/src/components/contacts/contactsAgentTree'
import { hideDropHighlight } from '../../../../apps/desktop/src/session/renderer/lib/drop-highlight'
import { clearDraggedScreenContent, SCREEN_CONTENT_DRAG_TYPE, setDraggedScreenContent } from '../../../../apps/desktop/src/session/renderer/lib/drag-screen-content'

vi.mock('@renderer/lib/drop-highlight', () => ({ hideDropHighlight: vi.fn() }))

// beta 有两条会话:挂在 alpha 下面的那条(拖起的就是它)和一条顶层的。
vi.mock('@renderer/features/sidebar/inner-sidebar-scope', () => {
  const entries = [
    { id: 'alpha-s', projectId: 'p', agentUserId: 'alpha', time: 0 },
    { id: 'beta-s', projectId: 'p', agentUserId: 'beta', parentSessionId: 'alpha-s', time: 0 },
    { id: 'beta-top', projectId: 'p', agentUserId: 'beta', time: 0 },
  ]
  const families = { entries, byId: new Map(entries.map((entry) => [entry.id, entry])), childrenOf: new Map(), topLevelOf: new Map() }
  return { sidebarFamilies: { get: () => families } }
})

function dragOver(sessionId: string) {
  const data = new Map<string, string>()
  const dataTransfer = { types: [SCREEN_CONTENT_DRAG_TYPE], setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'none', dropEffect: 'none' } as unknown as DataTransfer
  setDraggedScreenContent(dataTransfer, { kind: 'session', sessionId, projectId: 'p', title: sessionId })
  return { dataTransfer, stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as DragEvent<HTMLElement> & { stopPropagation: ReturnType<typeof vi.fn>; preventDefault: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  clearDraggedScreenContent()
  vi.mocked(hideDropHighlight).mockClear()
})

// 通讯录大纲里 agent 的那一行是它的原位:拖着它自己在行里(连接线、名字右边的空)松手 = 放回,❌ 冒到外面的「回到顶层」。
describe('agentHomeLine', () => {
  it('keeps a drag of the agent itself on its own row (any of its sessions), accepting nothing', () => {
    for (const sessionId of ['beta-s', 'beta-top']) {
      const event = dragOver(sessionId)
      agentHomeLine('beta').onDragOver(event)
      expect(event.stopPropagation).toHaveBeenCalled()
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(hideDropHighlight).toHaveBeenCalledTimes(2)
  })

  it('lets a drag of another agent through to the surrounding drop area', () => {
    const event = dragOver('beta-s')
    agentHomeLine('alpha').onDragOver(event)
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(hideDropHighlight).not.toHaveBeenCalled()
  })
})
