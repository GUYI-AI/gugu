import type { EmdashPlatformClosureAck } from '../session/main/core/acp/emdash-platform-injector'
import { rm } from 'node:fs/promises'

interface TicketOutcome { promise: Promise<void>; complete(): void; fail(): void }
interface LeaseLifetime {
  tickets: Map<string, TicketOutcome | undefined>
  pending: Set<Promise<unknown>>
  sealed: boolean
  uncertain: boolean
}
interface RotationProof {
  issued(generation: string): void
  revoke(generation: string, operation: () => Promise<void>): Promise<void>
}
const unconfirmed = () => new Error('Platform release is unconfirmed')

/** Initial and replacement tickets belong to one native lease lifetime. The
 * caller's original generation never becomes authority over a later lifetime. */
export class PlatformClosureReleaseProofs {
  private readonly lifetimes = new Map<string, LeaseLifetime>()
  private key(sessionId: string, generation: string) { return JSON.stringify([sessionId, generation]) }
  open(sessionId: string, generation: string): void {
    const key = this.key(sessionId, generation)
    if (!generation) throw unconfirmed()
    this.lifetimes.set(key, {
      tickets: new Map([[generation, undefined]]), pending: new Set(), sealed: false, uncertain: false,
    })
  }
  private lifetime(sessionId: string, generation: string) {
    const value = this.lifetimes.get(this.key(sessionId, generation))
    if (!value) throw unconfirmed()
    return value
  }
  sameLifetime(sessionId: string, initial: string, current: string): boolean {
    const first = this.lifetimes.get(this.key(sessionId, initial))
    return !!first && first === this.lifetimes.get(this.key(sessionId, current))
  }
  sealAdmission(sessionId: string, generation: string): void { this.lifetime(sessionId, generation).sealed = true }
  /** Registered before issue starts, including a replacement returned after
   * stop. A swallowed native revoke error still leaves its ticket unconfirmed. */
  rotation<T>(sessionId: string, generation: string, work: (proof: RotationProof) => Promise<T>): Promise<T> {
    const life = this.lifetime(sessionId, generation)
    if (life.sealed) return Promise.reject(unconfirmed())
    const pending = Promise.resolve().then(() => work({
      issued: next => {
        const key = this.key(sessionId, next), other = this.lifetimes.get(key)
        if (!next || other && other !== life) throw unconfirmed()
        this.lifetimes.set(key, life)
        if (!life.tickets.has(next)) life.tickets.set(next, undefined)
      },
      revoke: async (next, operation) => {
        if (this.lifetime(sessionId, next) !== life) throw unconfirmed()
        const outcome = this.begin(sessionId, next)
        try { await operation(); outcome.complete() } catch (error) { outcome.fail(); throw error }
      },
    }))
    life.pending.add(pending)
    void pending.then(() => { life.pending.delete(pending) }, () => { life.uncertain = true; life.pending.delete(pending) })
    return pending
  }
  begin(sessionId: string, generation: string): TicketOutcome {
    if (!this.lifetimes.has(this.key(sessionId, generation))) this.open(sessionId, generation)
    const life = this.lifetime(sessionId, generation), prior = life.tickets.get(generation)
    if (prior) return prior
    const outcome = Promise.withResolvers<void>()
    void outcome.promise.catch(() => undefined)
    const result = { promise: outcome.promise, complete: () => outcome.resolve(), fail: () => outcome.reject(unconfirmed()) }
    life.tickets.set(generation, result)
    return result
  }
  async require(sessionId: string, generation: string): Promise<EmdashPlatformClosureAck> {
    const life = this.lifetime(sessionId, generation)
    life.sealed = true
    while (life.pending.size) await Promise.allSettled([...life.pending])
    if (life.uncertain || [...life.tickets.values()].some(ticket => !ticket)) throw unconfirmed()
    await Promise.all([...life.tickets.values()].map(ticket => ticket!.promise))
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
  proofs.sealAdmission(sessionId, held.accessSessionId)
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
