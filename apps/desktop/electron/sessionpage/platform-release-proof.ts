import type { EmdashPlatformClosureAck } from '../session/main/core/acp/emdash-platform-injector'
import { rm } from 'node:fs/promises'

/** Actual native cleanup records this before removing the live entry. Ordinary
 * callers may tolerate errors; the exact generation's evidence still fails. */
export class PlatformClosureReleaseProofs {
  private readonly outcomes = new Map<string, Promise<void>>()
  begin(sessionId: string, generation: string) {
    const outcome = Promise.withResolvers<void>()
    this.outcomes.set(JSON.stringify([sessionId, generation]), outcome.promise)
    void outcome.promise.catch(() => undefined)
    return { complete: () => outcome.resolve(), fail: () => outcome.reject(new Error('Platform release is unconfirmed')) }
  }
  async require(sessionId: string, generation: string): Promise<EmdashPlatformClosureAck> {
    const outcome = this.outcomes.get(JSON.stringify([sessionId, generation]))
    if (!outcome || !generation) throw new Error('Platform release is unconfirmed')
    await outcome
    return { status: 'settled', sessionId, generation }
  }
}

interface HeldRelease {
  accessSessionId: string; surface: string; renewTimer?: ReturnType<typeof setTimeout> | null
  settingsPath?: string | null; credentialConfigPath?: string | null; helperPath?: string | null
}
interface ReleasePorts {
  detachLive(): void
  detachRoute(): void
  revoke(): Promise<void>
  log: { info(fields: object, message: string): void; error(fields: object, message: string): void }
}
/** Interactive stop keeps its existing error policy. The additional receipt
 * records every native file failure as well as the actual revoke rejection. */
export async function performPlatformRelease(proofs: PlatformClosureReleaseProofs, sessionId: string,
  held: HeldRelease, ports: ReleasePorts, guarded: boolean): Promise<void> {
  const proof = proofs.begin(sessionId, held.accessSessionId)
  try {
    ports.log.info({ sessionId, accessSessionId: held.accessSessionId, surface: held.surface, guarded }, '平台令牌结清:撤销这条会话手里那一份')
    if (held.renewTimer) clearTimeout(held.renewTimer)
    ports.detachLive()
    if (held.settingsPath) await rm(held.settingsPath, { force: true }).catch(error => {
      proof.fail(); ports.log.error({ sessionId, file: held.settingsPath, err: error }, '删除会话 platform settings 文件失败')
    })
    for (const file of [held.credentialConfigPath, held.helperPath]) {
      if (!file) continue
      await rm(file, { force: true }).catch(error => {
        proof.fail(); ports.log.error({ sessionId, file, err: error }, '删除会话 platform credential 文件失败')
      })
    }
    ports.detachRoute()
    await ports.revoke().catch(error => {
      ports.log.error({ sessionId, accessSessionId: held.accessSessionId, err: error }, '平台令牌撤销失败:账本保留这张票,下次启动结清')
      throw error
    })
    proof.complete()
  } catch (error) { proof.fail(); throw error }
}
