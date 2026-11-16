import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import type { SessionCreateAttachmentDraftRequest, SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Real page, Thread, input and creation coordinator. Only account/device and host/upload transport are isolated.
// These captures establish renderer behavior, not native picker, cloud upload or a real host admission.
const fixture = vi.hoisted(() => ({
  owner: 'attachment-page-owner',
  device: { device_id: 'attachment-device', label: 'Test device', hostname: 'fixture', platform: 'linux', status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } },
  legacyCreate: vi.fn(), created: vi.fn(),
  ports: { assertAccount: vi.fn(), describe: vi.fn(), create: vi.fn(), place: vi.fn(), admit: vi.fn() },
}))
vi.mock('@/store/auth', async original => ({ ...(await original<typeof import('@/store/auth')>()), useAuth: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => 'Test device', isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { code = 'fixture' },
  machineRpc: () => { throw new Error('Skills are outside this attachment scenario') },
  fetchCreateOptions: async () => ({ projects: [], lastUsed: null, harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] }] }),
  fetchCreateModels: async () => ({ harness: 'codex', transport: 'acp', selected: 'native-model', selectedEffort: null, efforts: [],
    harnessState: 'ready', harnessAuth: 'signed-in', selectedCredential: 'credentialed', models: [{ id: 'native-model', name: 'Native model', source: 'harness' }] }),
  createSession: fixture.legacyCreate,
  fetchPhoneCreateOptions: vi.fn(), fetchPhoneCreateModels: vi.fn(), createPhoneSession: fixture.legacyCreate,
}))
vi.mock('@/mobile/agent-watch/create-attachment-rpc', () => ({ creationAttachmentPorts: () => fixture.ports }))
let root: Root | null = null, host: HTMLDivElement | null = null, sequence = 0
let receipt: SessionCreateAttachmentDraftResult
beforeEach(() => {
  fixture.owner = `attachment-page-owner-${++sequence}`
  for (const mock of [fixture.created, fixture.legacyCreate, ...Object.values(fixture.ports)]) mock.mockReset()
  fixture.legacyCreate.mockRejectedValue(new Error('The caption-only creation route must not receive attachments'))
  fixture.ports.assertAccount.mockResolvedValue(undefined)
  fixture.ports.describe.mockImplementation(async (file: File) => ({ name: file.name, sizeBytes: file.size, mimeType: file.type, sha256: 'a'.repeat(64) }))
  fixture.ports.create.mockImplementation(async (request: SessionCreateAttachmentDraftRequest) => {
    receipt = { conversationId: 'created-task', projectId: 'actual-project', title: 'Attachment task',
      attachmentTarget: { agentUserId: 'actual-agent', chatId: 'actual-dm' },
      attachmentDraft: { protocol: 1, clientRequestId: request.clientRequestId, initialMessageId: request.initialMessageId, state: 'awaiting-placement' } }
    return receipt
  })
  fixture.ports.place.mockImplementation(async (file: File) => ({ itemId: file.name, version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size }))
  fixture.ports.admit.mockImplementation(async () => ({ ...receipt, attachmentDraft: { ...receipt.attachmentDraft, state: 'admitted' } }))
})
afterEach(() => {
  root?.unmount(); host?.remove(); root = null; host = null
  composerDrafts.discard(mobileCreationDraftKey(fixture.owner))
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})
function render(theme: 'light' | 'dark') {
  root!.render(<LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <CreateSessionPage onCreated={fixture.created} />
  </MessageProvider></SessionUiTheme></LocalizationProvider>)
}
async function mount(theme: 'light' | 'dark') {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); document.documentElement.dataset.theme = theme
  followRendererSession('SIGNED_IN', fixture.owner)
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column'
  root = createRoot(host); render(theme)
  await until('real empty creation input and attachment control', () => !!host?.querySelector('[contenteditable]') && !!host?.querySelector('[data-phone-attachment]'))
}
async function choose(file: File) {
  const picker = host!.querySelector<HTMLInputElement>('input[type="file"]')!
  const selection = new DataTransfer(); selection.items.add(file); picker.files = selection.files
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await until('original file is staged in the real composer', () => !!host?.querySelector('[data-slot="composer-attachment"]'))
}
async function send() {
  await until('real send control ready', () => host?.querySelector<HTMLButtonElement>('[data-phone-send]')?.disabled === false)
  await page.elementLocator(host!.querySelector<HTMLElement>('[data-phone-send]')!).click()
}
it.each(['light', 'dark'] as const)('%s: real empty New task input opens its picker, retains a File and removes it without creating', async theme => {
  await mount(theme)
  const attach = host!.querySelector<HTMLElement>('[data-phone-attachment]')!
  expect(attach.closest('[data-slot="composer"]')).not.toBeNull()
  expect(host!.querySelector('[data-testid="phone-attachment-menu"]')).toBeNull()
  const picker = host!.querySelector<HTMLInputElement>('input[type="file"]')!, click = vi.spyOn(picker, 'click').mockImplementation(() => {})
  await page.elementLocator(attach).click(); expect(click).toHaveBeenCalledTimes(1)
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/A-${theme}-create-empty.png` })
  const file = new File(['original bytes'], 'original.txt', { type: 'text/plain' })
  await choose(file)
  expect(composerDrafts.forKey(mobileCreationDraftKey(fixture.owner)).pending[0]!.file).toBe(file)
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/A-${theme}-create-file-draft.png` })
  await page.elementLocator(host!.querySelector<HTMLElement>('[data-slot="composer-attachment"] button[aria-label]')!).click()
  await until('file removed', () => !host?.querySelector('[data-slot="composer-attachment"]'))
  expect(fixture.ports.create).not.toHaveBeenCalled(); expect(fixture.legacyCreate).not.toHaveBeenCalled()
})
it('retains the original File after placement fails, then retries the same task before first-turn admission', async () => {
  await mount('dark')
  fixture.ports.place.mockRejectedValueOnce(new Error('Upload disconnected'))
  const file = new File(['original bytes'], 'retry.txt', { type: 'text/plain' })
  await choose(file); await send()
  await until('failure and restored original file', () => !!host?.querySelector('[role="alert"]') && !!host?.querySelector('[data-slot="composer-attachment"]'))
  expect(fixture.ports.create).toHaveBeenCalledTimes(1); expect(fixture.ports.admit).not.toHaveBeenCalled()
  expect(composerDrafts.forKey(mobileCreationDraftKey(fixture.owner)).pending[0]!.file).toBe(file)
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/A-create-placement-failed.png' })
  await send()
  await until('same task admitted and handed over', () => fixture.created.mock.calls.length === 1)
  expect(fixture.ports.create).toHaveBeenCalledTimes(1); expect(fixture.ports.admit).toHaveBeenCalledTimes(1)
  expect(fixture.ports.create.mock.calls[0]![0].prompt).toBe('')
  expect(fixture.legacyCreate).not.toHaveBeenCalled()
})
