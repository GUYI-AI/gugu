// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../support/testHarness'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/notices', () => ({ notify }))
vi.mock('@/components/session-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ isHome: () => false }) }))
vi.mock('../../../apps/desktop/src/components/session-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ isHome: () => false }) }))

const { usePhoneFolderAttach } = await import('../../../apps/desktop/src/mobile/chat/usePhoneFolderAttach')
const { MAX_GROUP_FOLDERS } = await import('../../../apps/desktop/src/session/renderer/features/folders/group-folders')

type Attach = ReturnType<typeof usePhoneFolderAttach>
const folder = (index: number) => ({ id: `w${index}`, chatId: 'g', deviceId: 'mac', path: `/work/f${index}`, offline: false }) as never

function project(count: number) {
  return { chatId: 'g', name: 'gugu', folders: Array.from({ length: count }, (_, index) => folder(index)), homeOf: () => undefined }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); notify.mockClear() })
afterEach(() => { harness.cleanup() })

async function mount(count: number): Promise<{ current: Attach }> {
  const box = {} as { current: Attach }
  function Probe() { box.current = usePhoneFolderAttach(project(count), [], async () => undefined); return null }
  await harness.render(createElement(Probe))
  return box
}

// 同电脑 #629:一个群最多挂 20 个文件夹;挂满了当场说,❌ 先推目录页、挑完才拒。
describe('phone folder attach cap', () => {
  it('refuses at the cap before the folder picker opens', async () => {
    const attach = await mount(MAX_GROUP_FOLDERS)
    act(() => { attach.current.onAttach('mac') })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({ tier: 'error' })
    expect(String(notify.mock.calls[0]![0].title)).toContain(String(MAX_GROUP_FOLDERS))
  })

  it('lets the picker open below the cap', async () => {
    const attach = await mount(MAX_GROUP_FOLDERS - 1)
    act(() => { attach.current.onAttach('mac') })
    expect(notify).not.toHaveBeenCalled()
  })
})
