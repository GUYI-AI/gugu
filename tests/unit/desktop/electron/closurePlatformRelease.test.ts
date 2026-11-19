import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformClosureReleaseProofs, performPlatformRelease } from '../../../../apps/desktop/electron/sessionpage/platform-release-proof'
import { releaseEmdashPlatformSession, releaseEmdashPlatformSessionForClosure, setEmdashPlatformRelease, type EmdashPlatformClosureRelease } from '../../../../apps/desktop/electron/session/main/core/acp/emdash-platform-injector'

const roots: string[] = []
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); setEmdashPlatformRelease(null) })
afterEach(async () => { setEmdashPlatformRelease(null); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
async function fixture(revoke: () => Promise<void>, badFile = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'closure-platform-release-')); roots.push(root)
  const file = join(root, 'controlled-settings')
  if (badFile) { await mkdir(file); await writeFile(join(file, 'entry'), 'controlled') } else await writeFile(file, 'controlled')
  const proofs = new PlatformClosureReleaseProofs(), held = { accessSessionId: 'generation-A', surface: 'cui', settingsPath: file }
  const ordinary = () => performPlatformRelease(proofs, 'session-A', held,
    { detachLive() {}, detachRoute() {}, revoke, log: { info() {}, error() {} } }, true)
  setEmdashPlatformRelease(ordinary, (session, generation) => proofs.require(session, generation))
  return { file, proofs }
}
describe('actual native platform settlement evidence', () => {
  it('retains revoke failure even though the ordinary helper deliberately resolves', async () => {
    await fixture(async () => { throw new Error('controlled refusal') })
    await expect(releaseEmdashPlatformSession('session-A', 'generation-A')).resolves.toBeUndefined()
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-A')).rejects.toThrow('unconfirmed')
  })
  it('retains a real native file-removal failure even after token revocation succeeded', async () => {
    const revoke = vi.fn(async () => {}), f = await fixture(revoke, true)
    await releaseEmdashPlatformSession('session-A', 'generation-A')
    expect(revoke).toHaveBeenCalledOnce(); expect(await readFile(join(f.file, 'entry'), 'utf8')).toBe('controlled')
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-A')).rejects.toThrow('unconfirmed')
  })
  it('waits for the actual native attempt before accepting its exact generation', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const f = await fixture(async () => { entered.resolve(); await release.promise })
    const ordinary = releaseEmdashPlatformSession('session-A', 'generation-A'); await entered.promise
    let acknowledged = false
    const strict = releaseEmdashPlatformSessionForClosure('session-A', 'generation-A').then(() => { acknowledged = true })
    await Promise.resolve(); expect(acknowledged).toBe(false)
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve(); await ordinary; await strict; expect(acknowledged).toBe(true)
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-B')).rejects.toThrow('unconfirmed')
  })
  it('does not treat an absent strict handler or a void/wrong-generation result as acknowledgement', async () => {
    setEmdashPlatformRelease(async () => {})
    await releaseEmdashPlatformSession('session-A', 'generation-A')
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-A')).rejects.toThrow('unconfirmed')
    setEmdashPlatformRelease(async () => {}, (async () => undefined) as unknown as EmdashPlatformClosureRelease)
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-A')).rejects.toThrow('unconfirmed')
    setEmdashPlatformRelease(async () => {}, async () => ({ status: 'settled', sessionId: 'session-A', generation: 'other' }))
    await expect(releaseEmdashPlatformSessionForClosure('session-A', 'generation-A')).rejects.toThrow('unconfirmed')
  })
})
