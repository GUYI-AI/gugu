/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { page } from 'vitest/browser'
import { PasswordRequestCard } from '../components/rows/message/PasswordRequestCard'
import type { PasswordBetaUi, PasswordSaveRequest, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { createPasswordCardKey, openPasswordCard, sealPasswordCard } from '@gugu/core/shared/passwordCardCipher'
import { remotePasswordSaveCard } from '../../../../apps/desktop/src/lib/passwordSaveCards'
vi.mock('../../../../apps/desktop/src/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
const request: PasswordSaveRequest = { kind: 'save', requestId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://example.com', agent: 'agent', agentName: '研究助理', sessionTitle: '研究助理', sessionId: 'session', deviceId: 'desktop',
  expiresAt: Date.now() + 100000, inputs: [{ key: 'phone', name: '手机号', secret: false }] }
let dispose: (() => void) | undefined, host: HTMLDivElement
const scope = window as unknown as { passwordVaultBeta?: PasswordBetaUi }
afterEach(() => { dispose?.(); host?.remove(); delete scope.passwordVaultBeta; delete window.passwordSaveCards })
async function mount(value = request) {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  dispose = render(() => <PasswordRequestCard request={value} />, host)
}
describe('save card requester label', () => {
  it('shows identical agent and session names only once on a phone-sized card', async () => {
    await mount()
    expect(host.textContent?.match(/研究助理/g)).toHaveLength(1)
    expect(host.textContent).not.toContain('·')
  })
  it('retains both names when the session has a distinct title', async () => {
    await mount({ ...request, sessionTitle: '注册账号' })
    expect(host.textContent).toContain('研究助理 / 注册账号')
  })
})

async function remote(fail = false) {
  const key = await createPasswordCardKey(), commands: PasswordUiCommand[] = [], wire: unknown[] = []
  const field = { id: '22222222-2222-4222-8222-222222222222', name: '手机号', value: '15500000000', secret: false }
  const value: PasswordSaveRequest = { ...request, saveKey: key.publicKey, inputs: [{ key: field.id, name: field.name, secret: false }] }
  let saved = false
  const ui = remotePasswordSaveCard(value, undefined, async (_device, payload) => {
    wire.push(payload)
    const opened = await openPasswordCard(key, payload.sealed) as { nonce: string; replyKey: string; command: PasswordUiCommand }
    commands.push(opened.command)
    if (opened.command.type === 'save' && !fail) saved = true
    const reply: PasswordUiReply = opened.command.type === 'save' && fail ? { ok: false, code: 'STORAGE_FAILED' }
      : { ok: true, snapshot: { items: [], approvals: [], candidates: [], saves: saved ? [] : [value] },
        ...(opened.command.type === 'save-draft' ? { draft: { origin: value.origin, account: '', password: '', fields: [field], agentName: value.agentName } } : {}) }
    return { sealed: await sealPasswordCard(opened.replyKey, { requestId: value.requestId, nonce: opened.nonce, reply }) }
  })!
  window.passwordSaveCards = { forRequest: () => ui }
  await mount(value)
  await expect.poll(() => host.querySelector<HTMLInputElement>('input[aria-label="手机号"]')?.value).toBe(field.value)
  return { commands, wire }
}
// Rendered without a host translator, the card reads the package's English fallback.
describe('mobile save card without an Electron bridge', () => {
  it('shows the supplied non-secret field and saves it through the encrypted remote card', async () => {
    const f = await remote()
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    await expect.poll(() => button.disabled).toBe(false)
    button.click()
    await expect.poll(() => host.querySelector('[role=status]')?.textContent).toBe('Saved')
    expect(f.commands.find(command => command.type === 'save')).toMatchObject({ type: 'save', fields: [{ name: '手机号', value: '15500000000', secret: false }] })
    expect(JSON.stringify(f.wire)).not.toContain('15500000000')
  })
  it('retains the typed value and shows a retryable error when saving fails', async () => {
    await remote(true)
    const input = host.querySelector<HTMLInputElement>('input[aria-label="手机号"]')!
    input.value = '15500000001'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    await expect.poll(() => button.disabled).toBe(false)
    button.click()
    await expect.poll(() => host.querySelector('[role=alert]')?.textContent).toBe('Could not save. Try again.')
    expect(input.value).toBe('15500000001')
    expect(button.disabled).toBe(false)
  })
})
