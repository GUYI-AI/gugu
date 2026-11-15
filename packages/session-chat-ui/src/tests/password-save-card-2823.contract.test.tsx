/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { page } from 'vitest/browser'
import { PasswordRequestCard } from '../components/rows/message/PasswordRequestCard'
import type { PasswordBetaUi, PasswordSaveRequest } from '@gugu/core/shared/passwordBetaProtocol'
vi.mock('@gugu/core/shared/passwordBeta', () => ({ PASSWORD_BETA_ENABLED: true }))
const request: PasswordSaveRequest = { kind: 'save', requestId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://example.com', agent: 'agent', agentName: '研究助理', sessionTitle: '研究助理', sessionId: 'session', deviceId: 'desktop',
  expiresAt: Date.now() + 100000, inputs: [{ key: 'phone', name: '手机号', secret: false }] }
let dispose: (() => void) | undefined, host: HTMLDivElement
const scope = window as unknown as { passwordVaultBeta?: PasswordBetaUi }
afterEach(() => { dispose?.(); host?.remove(); delete scope.passwordVaultBeta })
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
