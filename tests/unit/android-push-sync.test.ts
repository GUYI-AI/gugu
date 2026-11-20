import { describe, expect, it } from 'vitest'
import { AndroidPushSync, type AndroidPushDeps, type PushBinding } from '../../apps/desktop/src/mobile/android-push/androidPushSync'
import { suppressAndroidLocalPushNotification } from '../../apps/desktop/src/mobile/android-push/androidPushState'

const scope = { ownerId: 'owner', sessionId: 'session' }
const prefs = { chatMessages: true, chatSound: true, taskEnabled: true, taskSound: true }
const endpoint: PushBinding = { ownerId: 'owner', installationId: 'installation', deviceId: 'phone-installation-owner',
  provider: 'fcm', environment: 'production', topic: 'app.gugu.chat.beta', allowed: true }
function fixture(overrides: Partial<AndroidPushDeps> = {}) {
  const calls: string[] = []; const authorities: boolean[] = []
  const deps: AndroidPushDeps = {
    status: async () => { calls.push('status'); return endpoint },
    register: async () => { calls.push('token'); return { ...endpoint, token: 'PRIVATE_TOKEN_CANARY' } },
    save: async (_scope, _endpoint, preferences) => { calls.push(`save:${preferences.chatSound}`); return { registration_id: 'registration', generation: 'generation' } },
    revoke: async () => { calls.push('revoke'); return true }, close: async () => { calls.push('close') },
    revokeNative: async () => { calls.push('native-revoke') }, authority: value => authorities.push(value), ...overrides,
  }
  return { runtime: new AndroidPushSync(deps), calls, authorities }
}
describe('Android push synchronization', () => {
  it('takes notification authority only after server acknowledgement and updates sound preferences', async () => {
    const f = fixture(); await f.runtime.synchronize(scope, prefs)
    expect(f.calls).toEqual(['status', 'token', 'save:true']); expect(f.authorities).toEqual([false, true])
    await f.runtime.synchronize(scope, { ...prefs, chatSound: false })
    expect(f.calls).toContain('save:false')
  })
  it('keeps local reception for missing channels, denied permission and failed registration', async () => {
    for (const status of [{ ...endpoint, provider: null }, { ...endpoint, allowed: false }]) {
      const f = fixture({ status: async () => status }); await f.runtime.synchronize(scope, prefs)
      expect(f.calls).not.toContain('token'); expect(f.authorities).not.toContain(true)
    }
    const f = fixture({ save: async () => { throw new Error('unavailable') } })
    await expect(f.runtime.synchronize(scope, prefs)).rejects.toThrow('unavailable')
    expect(f.authorities).toEqual([false])
  })
  it('preference off revokes the exact acknowledged generation', async () => {
    const f = fixture(); await f.runtime.synchronize(scope, prefs)
    await f.runtime.synchronize(scope, { ...prefs, chatMessages: false, taskEnabled: false })
    expect(f.calls).toContain('revoke'); expect(f.authorities.at(-1)).toBe(false)
  })
  it('keeps the acknowledged remote outlet during same-login foreground reconciliation', async () => {
    const f = fixture(); await f.runtime.synchronize(scope, prefs)
    await f.runtime.synchronize(scope, prefs)
    expect(f.authorities).toEqual([false, true, true])
  })
  it('turns chat off without disabling the already-enabled task watcher', async () => {
    const saved: unknown[] = []
    const f = fixture({ save: async (_scope, _endpoint, preferences) => {
      saved.push(preferences); return { registration_id: 'registration', generation: 'new-generation' }
    } })
    await f.runtime.synchronize(scope, { ...prefs, chatMessages: false })
    expect(saved).toEqual([{ ...prefs, chatMessages: false }])
    expect(f.calls).not.toContain('revoke'); expect(f.authorities.at(-1)).toBe(true)
  })
  it('withdraws an old asynchronous token callback before account change can save it', async () => {
    let release!: () => void
    const token = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ register: async () => { await token; return { ...endpoint, token: 'old' } } })
    const first = f.runtime.synchronize(scope, prefs)
    await Promise.resolve(); await Promise.resolve()
    const second = f.runtime.synchronize(null, prefs); release(); await first; await second
    expect(f.calls.filter(call => call.startsWith('save'))).toEqual([])
    expect(f.authorities).not.toContain(true)
  })
  it('drains in-flight registration, fences server scope, then unregisters SDK before logout can clear credentials', async () => {
    let release!: () => void; let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const save = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ save: async () => { started(); await save; return { registration_id: 'late', generation: 'late' } } })
    const first = f.runtime.synchronize(scope, prefs); await entered
    const logout = f.runtime.retire(scope).then(() => f.calls.push('clear-credentials'))
    release(); await first; await logout
    expect(f.calls.slice(-3)).toEqual(['close', 'native-revoke', 'clear-credentials'])
    expect(f.authorities).not.toContain(true)
    await f.runtime.synchronize(scope, prefs)
    expect(f.calls.filter(call => call === 'token')).toHaveLength(1)
  })
  it('failed server cleanup cannot reach SDK or credential deletion', async () => {
    const f = fixture({ close: async () => { throw new Error('network') } })
    await expect(f.runtime.retire(scope)).rejects.toThrow('network')
    expect(f.calls).not.toContain('native-revoke')
  })
  it('suppresses background chat only after confirmation; foreground and non-chat remain on the existing outlet', () => {
    expect(suppressAndroidLocalPushNotification(true, false, 'chat')).toBe(true)
    expect(suppressAndroidLocalPushNotification(true, false, null, 'task_attention')).toBe(true)
    for (const [remote, foreground, chat] of [[false, false, 'chat'], [true, true, 'chat'], [true, false, null]] as const)
      expect(suppressAndroidLocalPushNotification(remote, foreground, chat)).toBe(false)
  })
})
