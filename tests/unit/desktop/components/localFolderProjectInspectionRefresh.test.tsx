// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * 「从本地文件夹新建项目」: the picked folder's inspection read before (the 「不是 git 仓库」 hint), a read again when the
 * same folder is picked again failing — said, ❌ the old hint shown as current.
 */
const host = vi.hoisted(() => ({ fail: false, inspect: vi.fn() }))
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ app: { getHomeDirectory: async () => '/home/me' }, projects: { inspectProjectPath: host.inspect } }),
  rpc: {},
  events: { on: () => () => undefined },
}))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/ui/modal-layout', () => ({ ModalLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@renderer/features/projects/components/add-project-modal/directory-browser/directory-tree', () => ({
  DirectoryTree: ({ onChange }: { onChange: (path: string) => void }) => (
    <>
      <button type="button" data-testid="pick-plain" onClick={() => onChange('/home/me/plain')}>plain</button>
      <button type="button" data-testid="pick-other" onClick={() => onChange('/home/me/other')}>other</button>
    </>
  ),
}))

const { followRendererSession } = await import('../../../../apps/desktop/src/lib/replica')
const { LocalFolderProjectModal } = await import('../../../../apps/desktop/src/session/renderer/features/projects/components/local-folder-project-modal')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  followRendererSession('SIGNED_IN', 'local-folder-owner')
  h = createReactHarness()
  host.fail = false
  host.inspect.mockReset().mockImplementation(async () => {
    if (host.fail) throw new Error('machine unreachable')
    return { isDirectory: true, isGitRepo: false }
  })
})
afterEach(() => h.cleanup())

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const click = (testId: string) => act(async () => { (h.container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click() })
const text = () => h.container.textContent ?? ''

it('the folder picked again, its read again failing is said beside the hint read before', async () => {
  await h.render(<LocalFolderProjectModal onClose={() => undefined} onSuccess={() => undefined} />)
  await settle()
  await click('pick-plain')
  await settle()
  expect(text()).toContain('projects.dirTree.notAGitRepo')
  expect(text()).not.toContain('machine unreachable')
  host.fail = true
  await click('pick-other')
  await settle()
  await click('pick-plain')
  await settle()
  expect(host.inspect).toHaveBeenCalledTimes(3)
  expect(text()).toContain('projects.dirTree.notAGitRepo')
  expect(text()).toContain('machine unreachable')
})
