import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { followRendererSession } from '@/lib/replica'
import { CreateSessionPage } from '@/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import type { SessionCreateAttachmentDraftRequest, SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/mobile/agent-watch/agent-watch.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// Real page, Thread, input and creation coordinator. Only account/device and host/upload transport are isolated.
// These captures establish renderer behavior, not native picker, cloud upload or a real host admission.
const fixture = vi.hoisted(() => ({
  owner: 'attachment-page-owner',
  device: { device_id: 'attachment-device', label: 'Test device', hostname: 'fixture', platform: 'linux', status: 'online', is_online: true, last_seen_at: '2026-11-17T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } },
  legacyCreate: vi.fn(), created: vi.fn(), skills: vi.fn(),
  ports: { assertAccount: vi.fn(), describe: vi.fn(), create: vi.fn(), place: vi.fn(), admit: vi.fn() },
}))
vi.mock('@/store/auth', async original => ({ ...(await original<typeof import('@/store/auth')>()), useAuth: () => ({ user: { id: fixture.owner } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [fixture.device], phones: [] }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => 'Test device', isHome: () => false }) }))
vi.mock('@/hooks/useWakeCloudComputer', () => ({ useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }) }))
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ rememberRunMachine: vi.fn(), useProjectRunMachine: () => ({ machine: fixture.device.device_id, pick: vi.fn() }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error { code = 'fixture' },
  machineRpc: (deviceId: string) => ({ sessionTimeline: { sessionCreateSkills: (input: unknown) => fixture.skills(deviceId, input) } }),
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
  for (const mock of [fixture.created, fixture.legacyCreate, fixture.skills, ...Object.values(fixture.ports)]) mock.mockReset()
  fixture.skills.mockResolvedValue({ ok: false, error: { code: 'unknown_method', message: "No handler registered for 'sessionTimeline.sessionCreateSkills'" } })
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
  vi.unstubAllGlobals()
})
function render(theme: 'light' | 'dark') {
  root!.render(<ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <CreateSessionPage onCreated={fixture.created} />
    <span hidden data-creation-fixture-owner={fixture.owner} />
  </MessageProvider></SessionUiTheme></LocalizationProvider></ThemeProvider>)
}
async function mount(theme: 'light' | 'dark') {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); writeThemePreference(theme)
  followRendererSession('SIGNED_IN', fixture.owner)
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''; host.dataset.taScope = ''
  // Match MainLayout's phone shell boundary; the production CreateSessionPage/Thread stay real.
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ta-panel-bg)'
  root = createRoot(host); render(theme)
  await until('real empty creation input and attachment control', () => !!host?.querySelector('[contenteditable]') && !!host?.querySelector('[data-phone-attachment]'))
  expect(host!.textContent).toContain('新建任务')
  expect(host!.querySelector('[contenteditable]')?.getAttribute('aria-label')).toBe('第一句话…')
  expect(host!.textContent).not.toContain('agentWatch.')
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
it.each(['light', 'dark'] as const)('%s: real two-line New task input opens its picker, retains a File and removes it without creating', async theme => {
  await mount(theme)
  const attach = host!.querySelector<HTMLElement>('[data-phone-attachment]')!
  expect(attach.closest('[data-slot="composer"]')).not.toBeNull()
  expect(host!.querySelector('[data-testid="phone-attachment-menu"]')).toBeNull()
  expect(getComputedStyle(attach).display).toBe('none')
  const editor = host!.querySelector<HTMLElement>('[contenteditable]')!
  ;(editor as HTMLElement & { editor: { commands: { setContent: (html: string) => void } } }).editor.commands.setContent('<p>第一行</p><p>第二行</p>')
  await until('approved two-line attachment action is visible', () => getComputedStyle(attach).display !== 'none')
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

// Observe the real Page catch -> rendererLogger -> console sink for a phone/web target.
// No logging helper, Page, Thread, ModelChoices or creation coordinator is replaced.
function creationLogCapture() {
  vi.stubGlobal('electronAPI', undefined)
  const sink = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { sink, rows: () => sink.mock.calls.filter(args => args[0] === '[mobile/agent-watch] create session failed') }
}

it('logs only a fixed code from the actual Page catch and retries the original File and creation identities', async () => {
  const logs = creationLogCapture()
  await mount('dark')
  const file = new File(['original private bytes'], 'page.owner@example.invalid.txt', { type: 'text/plain' })
  const failure = Object.assign(new Error('/private/edge-page-sentinel/receipt.json; page.owner@example.invalid'), {
    code: 'attachment_creation_unverified',
  })
  fixture.ports.place.mockRejectedValueOnce(failure)
  await choose(file); await send()
  await until('real Page failure is logged and the File is restored', () => logs.rows().length === 1
    && !!host?.querySelector('[role="alert"]') && !!host?.querySelector('[data-slot="composer-attachment"]'))

  expect(logs.rows()).toEqual([['[mobile/agent-watch] create session failed', { code: 'attachment_creation_unverified' }]])
  expect(JSON.stringify(logs.sink.mock.calls)).not.toMatch(/edge-page-sentinel|page\.owner@example\.invalid|receipt\.json/)
  expect(fixture.ports.create).toHaveBeenCalledTimes(1)
  expect(fixture.ports.admit).not.toHaveBeenCalled()
  expect(composerDrafts.forKey(mobileCreationDraftKey(fixture.owner)).pending[0]!.file).toBe(file)
  const original = fixture.ports.create.mock.calls[0]![0] as SessionCreateAttachmentDraftRequest

  await send()
  await until('the same task first input is admitted after retry', () => fixture.created.mock.calls.length === 1)
  expect(fixture.ports.create).toHaveBeenCalledTimes(1)
  expect(fixture.ports.place).toHaveBeenCalledTimes(2)
  for (const [placed] of fixture.ports.place.mock.calls) expect(placed).toBe(file)
  expect(fixture.ports.admit).toHaveBeenCalledExactlyOnceWith({
    conversationId: receipt.conversationId, clientRequestId: original.clientRequestId,
    initialMessageId: original.initialMessageId,
    placements: [{ attachmentId: original.attachments[0]!.id, file: {
      itemId: file.name, version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size,
    } }],
  })
  expect(fixture.legacyCreate).not.toHaveBeenCalled()
  expect(logs.rows()).toHaveLength(1)
})

it('keeps a late A failure out of logs and B draft, then retries only the original A task', async () => {
  const logs = creationLogCapture()
  await mount('dark')
  const ownerA = fixture.owner, ownerB = `${ownerA}-next`
  const fileA = new File(['account A original bytes'], 'late.owner@example.invalid.txt', { type: 'text/plain' })
  const fileB = new File(['account B draft bytes'], 'account-b-draft.txt', { type: 'text/plain' })
  const pending = Promise.withResolvers<never>()
  let placementStarted = false
  fixture.ports.place.mockImplementationOnce(() => { placementStarted = true; return pending.promise })
  try {
    await choose(fileA); await send()
    await until('A placement is in flight', () => fixture.ports.place.mock.calls.length === 1)
    const original = fixture.ports.create.mock.calls[0]![0] as SessionCreateAttachmentDraftRequest

    fixture.owner = ownerB
    followRendererSession('SIGNED_IN', ownerB); render('dark')
    await until('B owns an empty editor', () => !!host?.querySelector(`[data-creation-fixture-owner="${ownerB}"]`)
      && !!host?.querySelector('[contenteditable]')
      && !host?.querySelector('[data-slot="composer-attachment"]'))
    await choose(fileB)
    pending.reject(Object.assign(new Error('/private/edge-late-sentinel/receipt.json; late.owner@example.invalid'), { code: 'EACCES' }))
    await until('A late failure reaches the actual Page log boundary', () => logs.rows().length === 1)

    expect(logs.rows()).toEqual([['[mobile/agent-watch] create session failed', { code: 'EACCES' }]])
    expect(JSON.stringify(logs.sink.mock.calls)).not.toMatch(/edge-late-sentinel|late\.owner@example\.invalid|receipt\.json/)
    expect(fixture.created).not.toHaveBeenCalled()
    expect(fixture.ports.admit).not.toHaveBeenCalled()
    expect(host!.querySelector('[role="alert"]')).toBeNull()
    expect(composerDrafts.forKey(mobileCreationDraftKey(ownerB)).pending).toHaveLength(1)
    expect(composerDrafts.forKey(mobileCreationDraftKey(ownerB)).pending[0]!.file).toBe(fileB)

    fixture.owner = ownerA
    followRendererSession('SIGNED_IN', ownerA); render('dark')
    await until('the original A File is hydrated into its editor', () => !!host?.querySelector(`[data-creation-fixture-owner="${ownerA}"]`)
      && !!host?.querySelector('[data-slot="composer-attachment"]')
      && !!host?.textContent?.includes(fileA.name))
    expect(composerDrafts.forKey(mobileCreationDraftKey(ownerA)).pending[0]!.file).toBe(fileA)
    await send()
    await until('only original A creation is handed over', () => fixture.created.mock.calls.length === 1)
    expect(fixture.ports.create).toHaveBeenCalledTimes(1)
    expect(fixture.ports.admit).toHaveBeenCalledTimes(1)
    expect(fixture.ports.admit.mock.calls[0]![0]).toMatchObject({
      conversationId: receipt.conversationId, clientRequestId: original.clientRequestId, initialMessageId: original.initialMessageId,
    })
    expect(fixture.ports.place).toHaveBeenCalledTimes(2)
    for (const [placed] of fixture.ports.place.mock.calls) expect(placed).toBe(fileA)
    expect(composerDrafts.forKey(mobileCreationDraftKey(ownerB)).pending[0]!.file).toBe(fileB)
    expect(fixture.legacyCreate).not.toHaveBeenCalled()
  } finally {
    if (placementStarted) pending.reject(new Error('fixture cleanup'))
    composerDrafts.discard(mobileCreationDraftKey(ownerA))
    composerDrafts.discard(mobileCreationDraftKey(ownerB))
  }
})

it('keeps a missing skill method distinct from empty skills and retries the same selected target', async () => {
  await mount('dark')
  await page.getByTestId('agent-watch-create-skills').click()
  await until('host compatibility error is visible', () => document.querySelector('[data-testid="agent-watch-create-skills-error"]')?.getAttribute('data-failure') === 'method-unavailable')
  expect(fixture.skills).toHaveBeenCalledExactlyOnceWith('attachment-device', { harness: 'codex' })
  await expect.element(page.getByRole('alert')).toHaveTextContent('Test device')
  await expect.element(page.getByRole('alert')).toHaveTextContent('检查那台设备的咕咕版本后重试')
  expect(document.body.textContent).not.toContain('没有可用的技能')
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/C-create-unsupported-host.png' })
  fixture.skills.mockResolvedValueOnce({ ok: true, value: { skills: [
    { id: '/native/code/SKILL.md', name: '代码检查', description: '检查所选项目' },
    { id: '/native/notes/SKILL.md', name: '会议记录', description: '整理会议记录' },
  ] } })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await until('selected host catalog is available after retry', () => !!document.querySelector('[data-skill-id="/native/code/SKILL.md"]'))
  expect(fixture.skills.mock.calls[1]).toEqual(fixture.skills.mock.calls[0])
  await page.getByRole('searchbox', { name: '搜索技能' }).fill('检查')
  await expect.element(page.getByRole('checkbox', { name: /代码检查/ })).toBeVisible()
  expect(document.querySelector('[data-skill-id="/native/notes/SKILL.md"]')).toBeNull()
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/C-create-retry-search-transport-fixture.png' })
})
