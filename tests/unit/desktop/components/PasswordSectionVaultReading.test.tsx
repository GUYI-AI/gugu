// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasswordItem, PasswordSaveDraft, PasswordSnapshot, PasswordUiCommand, PasswordUiReply } from '../../../../packages/core/src/shared/passwordBetaProtocol'
import { requestPasswordFill } from '../../../../packages/core/src/shared/passwordBetaProtocol'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'
vi.mock('@/lib/notices', async (original) => (await import('../../../support/inlineLiveNotice')).withInlineLiveNotice(await original<object>()))


const item = (id: string, name: string): PasswordItem => ({
  reference: { id, version: 1, epoch: 'e' }, name, origin: `https://${id}.example`, maskedAccount: '', accountSecret: false,
  hasPassword: true, fields: [], grants: [], sites: [],
})
const snapshotOf = (...items: PasswordItem[]): PasswordSnapshot => ({ items, approvals: [], saves: [], candidates: [] })

/** This device's vault as the renderer sees it: answers commands, pushes "changed" to its listeners. */
function fakeVault(answer: (command: PasswordUiCommand) => Promise<PasswordUiReply>) {
  const listeners = new Set<() => void>()
  const invoke = vi.fn(answer)
  window.passwordVaultBeta = { invoke, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { invoke, push: () => act(async () => { for (const listener of listeners) listener() }), listeners }
}
const snapshotReads = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.filter(([command]) => (command as PasswordUiCommand).type === 'snapshot').length

let harness: ReturnType<typeof createReactHarness>
let PasswordSection: typeof import('../../../../apps/desktop/src/components/settings/PasswordSection')['PasswordSection']
beforeEach(async () => {
  harness = createReactHarness()
  ;({ PasswordSection } = await import('../../../../apps/desktop/src/components/settings/PasswordSection'))
})
afterEach(() => { harness.cleanup(); delete window.passwordVaultBeta })

const text = () => harness.container.textContent ?? ''
const render = (node = createNode(PasswordSection)) => renderWithAppProviders(harness, node)

describe('Settings → 密码 reads the vault as a reading fed by its push', () => {
  it('holds the list\'s place until the vault answers, then draws what it holds', async () => {
    let answer!: (reply: PasswordUiReply) => void
    fakeVault(() => new Promise((resolve) => { answer = resolve }))
    await render()
    expect(harness.container.querySelector('[data-unknown]')).not.toBeNull()
    expect(text()).not.toContain('还没有保存密码')
    await act(async () => { answer({ ok: true, snapshot: snapshotOf(item('a', 'GitHub')) }) })
    await waitForCondition(() => text().includes('GitHub'), 'list not drawn')
    expect(harness.container.querySelector('[data-unknown]')).toBeNull()
  })

  it('reads again when the vault says it changed', async () => {
    let state = snapshotOf(item('a', 'GitHub'))
    const vault = fakeVault(async () => ({ ok: true, snapshot: state }))
    await render()
    await waitForCondition(() => text().includes('GitHub'), 'list not drawn')
    state = snapshotOf(item('a', 'GitHub'), item('b', 'Linear'))
    await vault.push()
    await waitForCondition(() => text().includes('Linear'), 'push not followed')
  })

  it('says a vault that cannot be read, and Retry reads again', async () => {
    const vault = fakeVault(vi.fn<(command: PasswordUiCommand) => Promise<PasswordUiReply>>()
      .mockResolvedValueOnce({ ok: false, code: 'SYSTEM_STORAGE_UNAVAILABLE' })
      .mockResolvedValue({ ok: true, snapshot: snapshotOf(item('a', 'GitHub')) }))
    await render()
    await waitForCondition(() => harness.container.querySelector('[data-testid="password-vault-failed"]') !== null, 'failure not said')
    expect(text()).toContain('系统密码存储不可用')
    expect(text()).not.toContain('还没有保存密码')
    const retry = harness.container.querySelector('[data-testid="password-vault-failed"] button') as HTMLButtonElement
    await act(async () => { retry.click() })
    await waitForCondition(() => text().includes('GitHub'), 'retry did not read again')
    expect(snapshotReads(vault.invoke)).toBe(2)
  })

  it('shares one read and one feed with the other surfaces that show the vault', async () => {
    const { usePasswordVault } = await import('../../../../apps/desktop/src/lib/passwordBetaNotifications')
    function Count() { return <span data-testid="count">{usePasswordVault().snapshot?.items.length}</span> }
    const vault = fakeVault(async () => ({ ok: true, snapshot: snapshotOf(item('a', 'GitHub')) }))
    await render(createNode('div', null, createNode(PasswordSection), createNode(Count)))
    await waitForCondition(() => text().includes('GitHub') && harness.container.querySelector('[data-testid="count"]')?.textContent === '1', 'not drawn')
    expect(snapshotReads(vault.invoke)).toBe(1)
    expect(vault.listeners.size).toBe(1)
  })
})

describe('the surfaces that show part of the vault', () => {
  it('a refresh that fails over the snapshot shown is said with a retry, what was read staying (recovery row)', async () => {
    const { PasswordRecoveryGroup } = await import('../../../../apps/desktop/src/components/password/PasswordRecovery')
    const ready: PasswordSnapshot = { ...snapshotOf(item('a', 'GitHub')), sync: { state: 'ready', devices: [], requests: [], recovery: 'set' } }
    let fail = false
    const vault = fakeVault(async () => (fail ? { ok: false, code: 'SYSTEM_STORAGE_UNAVAILABLE' } : { ok: true, snapshot: ready }))
    await render(createNode(PasswordRecoveryGroup))
    await waitForCondition(() => text().includes('恢复码'), 'recovery row not drawn')
    expect(harness.container.querySelector('[data-refresh-failed]')).toBeNull()
    fail = true
    await vault.push()
    await waitForCondition(() => harness.container.querySelector('[data-refresh-failed]') !== null, 'failed refresh not said')
    expect(text()).toContain('重新生成')
    fail = false
    await act(async () => { (harness.container.querySelector('[data-refresh-failed] button') as HTMLButtonElement).click() })
    await waitForCondition(() => harness.container.querySelector('[data-refresh-failed]') === null, 'retry did not read again')
  })
})

describe('the device prompt over a kept vault', () => {
  it('the join card stays when the vault read again fails, the failure said with a retry', async () => {
    const { PasswordDeviceHost } = await import('../../../../apps/desktop/src/components/password/PasswordDeviceHost')
    const joining: PasswordSnapshot = { ...snapshotOf(), sync: { state: 'joining', code: '123456' } }
    let fail = false
    const vault = fakeVault(async () => (fail ? { ok: false, code: 'SYSTEM_STORAGE_UNAVAILABLE' } : { ok: true, snapshot: joining }))
    await render(createNode(PasswordDeviceHost))
    await waitForCondition(() => document.querySelector('[data-testid="password-join-card"]') !== null, 'join card not drawn')
    expect(document.querySelector('[data-testid="password-join-card"] [data-refresh-failed]')).toBeNull()
    fail = true
    await vault.push()
    await waitForCondition(() => document.querySelector('[data-testid="password-join-card"] [data-refresh-failed]') !== null, 'failed refresh not said')
  })
})

describe('「去填写」 opens the form an Agent\'s save request asks for', () => {
  const draft: PasswordSaveDraft = { origin: 'https://new.example', name: 'New', account: 'me@example.test', password: 'proposed', fields: [], agentName: 'Codex 5' }

  it('opens the form pre-filled with what the Agent proposed', async () => {
    fakeVault(async (command) => command.type === 'save-draft'
      ? { ok: true, snapshot: snapshotOf(), draft: command.requestId === 'req-1' ? draft : undefined }
      : { ok: true, snapshot: snapshotOf() })
    await render()
    await act(async () => { requestPasswordFill('req-1') })
    await waitForCondition(() => harness.container.querySelector('[data-testid="password-form"]') !== null, 'form not opened')
    expect(text()).toContain('Codex 5 请你保存这条密码')
    expect((harness.container.querySelector('input[aria-label="账号"]') as HTMLInputElement).value).toBe('me@example.test')
  })

  it('says a request that is no longer waiting instead of doing nothing', async () => {
    fakeVault(async () => ({ ok: true, snapshot: snapshotOf() }))
    await render()
    await act(async () => { requestPasswordFill('req-gone') })
    await waitForCondition(() => text().includes('此保存请求已处理或已过期'), 'not said')
    expect(harness.container.querySelector('[data-testid="password-form"]')).toBeNull()
  })
})
