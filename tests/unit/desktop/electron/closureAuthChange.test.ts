import { describe, expect, it, vi } from 'vitest'
import { sessionLifeOwnerFixture } from '../sessionLife/owner-cases'
import { createDesktopClosureService } from '../../../../apps/desktop/electron/account-closure/service'
import { createClosureAuthChange } from '../../../../apps/desktop/electron/account-closure/auth-change'
import { createHumanAuthSessionIpc, type HumanAuthChangePermit } from '../../../../apps/desktop/electron/runtime-auth-provider'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
async function fixture() {
  let current: string | null = A, generation = 0
  const secrets = new Map<string, string>(), life = sessionLifeOwnerFixture()
  const closure = createDesktopClosureService({ profileBinding: 'controlled-auth-profile', currentOwner: async () => current,
    secrets: { getSecret: async key => secrets.get(key) ?? null, setSecret: async (key, value) => { secrets.set(key, value) } },
    stopOwner: async () => {}, steps: [{ name: 'controlled-erase', run: async () => false }], retained: async () => [] })
  const scope = { ownerId: A, localOperationId: 'opaque' }
  await closure.native.receipt.put(scope, 'controlled-receipt'); await closure.prepare(scope); await closure.native.eraseLocal(scope)
  current = B; generation += 1
  life.session('b', B); life.fork('f', 'b'); await life.owner.signIn(B)
  life.owner.start('b'); life.owner.start('f'); await life.owner.quiescent('b'); await life.owner.quiescent('f')
  let beforeLeave: (() => Promise<void>) | undefined
  const prepareChange = createClosureAuthChange({ ready: async () => {}, fence: () => closure,
    source: () => ({ ownerId: current, generation }), leave: async (source, next, qualify) => {
      await beforeLeave?.(); await life.owner.leaveForAuthChange(source, next, qualify)
    } })
  const persist = vi.fn(async (_mirror: { access_token: string }) => {}), revoke = vi.fn(), changed = vi.fn()
  const enter = vi.fn(async () => { if (current) await life.owner.signIn(current) })
  const set = vi.fn((auth: unknown) => { current = auth && typeof auth === 'object' && 'userId' in auth ? String(auth.userId) : null; generation += 1 })
  const ipc = createHumanAuthSessionIpc({ toAuth: tokens => ({ userId: tokens.accessToken, accessToken: 'controlled' }),
    set, persist, erase: async () => {}, revoke, changed, enter, prepareChange,
    leaveIfChanging: async next => { if (current && current !== next) await life.owner.signOut() },
    mutate: (next, operation) => closure.underAuth(async () => { if (next) await closure.requireAuthWrite(next); return operation() }),
  })
  return { life, closure, ipc, persist, set, revoke, changed, enter, prepareChange,
    beforeLeave: (value: () => Promise<void>) => { beforeLeave = value }, current: () => current,
    replaceNative: async (owner: string) => { await closure.underAuth(async () => { current = owner; generation += 1 }); await life.owner.signIn(owner) } }
}
describe('native closure auth permit with the real lifecycle owner', () => {
  it('rejects fenced late A before stopping active B or removing its temporary side chat', async () => {
    const f = await fixture(), before = [...f.life.trace], active = f.life.active.size
    await expect(f.ipc.write({ access_token: A })).rejects.toMatchObject({ code: 'closure_not_prepared' })
    expect(f.life.trace).toEqual(before); expect(f.life.active.size).toBe(active)
    expect(f.life.owner.read('b').kind).toBe('ready'); expect(f.life.owner.read('f').kind).toBe('ready')
    expect(f.life.removed).toEqual([])
    for (const call of [f.set, f.persist, f.revoke, f.changed, f.enter]) expect(call).not.toHaveBeenCalled()
    await f.life.owner.signOut()
  })
  it('preserves an ordinary permitted B to D account switch', async () => {
    const f = await fixture(); f.life.session('d', D)
    await f.ipc.write({ access_token: D })
    expect(f.current()).toBe(D); expect(f.life.removed).toContain('f')
    expect(f.persist).toHaveBeenCalledExactlyOnceWith({ access_token: D })
    f.life.owner.start('d'); await f.life.owner.quiescent('d'); expect(f.life.owner.read('d').kind).toBe('ready')
    await f.life.owner.signOut()
  })
  it('revalidates before leave after a newer D and its fork became active while the old writer waited', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let calls = 0
    f.beforeLeave(async () => { if (++calls === 1) { entered.resolve(); await release.promise } })
    const old = f.ipc.write({ access_token: C }).catch(error => error)
    await entered.promise
    f.life.session('d', D); f.life.fork('g', 'd'); await f.ipc.write({ access_token: D })
    f.life.owner.start('d'); f.life.owner.start('g'); await f.life.owner.quiescent('d'); await f.life.owner.quiescent('g')
    const trace = [...f.life.trace], active = f.life.active.size
    release.resolve(); expect(await old).toMatchObject({ code: 'scope_conflict' })
    expect(f.life.trace).toEqual(trace); expect(f.life.active.size).toBe(active)
    expect(f.life.owner.read('d').kind).toBe('ready'); expect(f.life.owner.read('g').kind).toBe('ready')
    expect(f.current()).toBe(D); expect(f.persist).toHaveBeenCalledExactlyOnceWith({ access_token: D })
    await f.life.owner.signOut()
  })
  it('revalidates the source generation again before credential mutation', async () => {
    const f = await fixture(), permit: HumanAuthChangePermit = await f.prepareChange(C)
    await permit.leave(); f.life.session('d', D); await f.replaceNative(D)
    f.life.owner.start('d'); await f.life.owner.quiescent('d')
    await expect(permit.mutate(() => f.persist({ access_token: C }))).rejects.toMatchObject({ code: 'scope_conflict' })
    expect(f.persist).not.toHaveBeenCalled(); expect(f.life.owner.read('d').kind).toBe('ready')
    await f.life.owner.signOut()
  })
})
