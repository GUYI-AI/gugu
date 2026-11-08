// @vitest-environment jsdom
// A file a session's timeline names on the phone — a link in a reply (`[add.ts](src/add.ts)`), a file it edited — opens from
// that session's working copy on its machine, through the Files App's own read (`filesRead`). Before, both went to the
// ledger of files the session had opened itself and said 「这条会话还没打开过这个文件」 for a file the Files App opens fine.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useOpenedOutputOpener } from '../../../apps/desktop/src/mobile/agent-watch/opened-output-opener'
import { sessionWorkingCopyReader } from '../../../apps/desktop/src/components/appSlot/phone-working-copy-file'
import { ToastContext } from '../../../apps/desktop/src/components/toastContext'
import { createNode, createReactHarness } from '../../support/testHarness'

const m = vi.hoisted(() => ({ ledger: vi.fn(), workingCopy: vi.fn(), call: vi.fn(), toast: vi.fn() }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { kind: 'capacitor', saveFile: vi.fn() } }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  readOpenedFileChunk: m.ledger,
  SessionpageRpcError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
}))
vi.mock('../../../apps/desktop/src/components/appSlot/phoneProgramCall', () => ({ callOnComputer: m.call }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { manifestFor: (id: string) => (id === 'workspace' ? { id: 'workspace', name: '文件', version: '0.2.75' } : undefined) },
}))

let h: ReturnType<typeof createReactHarness>
// "abc"
const chunk = { size: 3, etag: 'e1', data: 'YWJj' }
let open: (path: string, source?: 'diff' | 'file-op' | 'resource-link' | 'prose-link') => void
beforeEach(() => {
  vi.clearAllMocks()
  m.ledger.mockResolvedValue(chunk)
  m.workingCopy.mockResolvedValue(chunk)
  h = createReactHarness()
})
afterEach(() => h.cleanup())

function Fixture() {
  const { openFile, panel } = useOpenedOutputOpener({ deviceId: 'desktop-1', sessionId: 'task-1', onQuote: vi.fn(), readWorkingCopy: m.workingCopy })
  open = openFile
  return createNode('div', {}, panel)
}
async function render() { await h.render(createNode(ToastContext.Provider, { value: { toast: m.toast } }, createNode(Fixture))) }
const panel = () => document.querySelector('[data-testid="message-file-preview-panel"]')

it.each(['prose-link', 'resource-link', 'diff'] as const)('a %s opens from the working copy, never the opened-file ledger', async (source) => {
  await render()
  await vi.waitFor(() => expect(open).toBeTypeOf('function'))
  open('src/add.ts', source)
  await vi.waitFor(() => expect(m.workingCopy).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'task-1', path: 'src/add.ts', offset: 0 })))
  expect(m.ledger).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(panel()?.textContent ?? '').not.toContain('正在从那台电脑取'))
  expect(panel()?.textContent ?? '').not.toContain('还没打开过这个文件')
})

it('a file the session itself put out (a file operation card) still reads its ledger', async () => {
  await render()
  open('report.txt', 'file-op')
  await vi.waitFor(() => expect(m.ledger).toHaveBeenCalled())
  expect(m.workingCopy).not.toHaveBeenCalled()
})

it('the working-copy read is the Files App\'s filesRead on the session\'s machine, named by the session\'s working copy', async () => {
  m.call.mockResolvedValue(chunk)
  const read = sessionWorkingCopyReader({ id: 'task-1', deviceId: 'desktop-1' })
  expect(await read({ conversationId: 'task-1', path: 'src/add.ts', offset: 0, length: 1024 })).toEqual(chunk)
  expect(m.call).toHaveBeenCalledExactlyOnceWith(
    { extensionId: 'workspace', extensionName: '文件', version: '0.2.75' },
    { id: 'task-1', deviceId: 'desktop-1', deviceLabel: null },
    'filesRead',
    { ref: { workspace: 'session:task-1', name: 'src/add.ts' }, offset: 0, length: 1024 },
  )
})
