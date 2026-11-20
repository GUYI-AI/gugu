import { replica } from '../../../lib/replica'
import { getRendererSession } from '../../../lib/sessionPublication'
import type { AccountClosureV2Policy } from '../../../platform/accountClosureV2'
import { accountClosureV2Controller } from './accountClosureV2Runtime'

type Controller = NonNullable<ReturnType<typeof accountClosureV2Controller>>
const coded = (code: string) => Object.assign(new Error(code), { code })

/** The flow runs one native command at a time; a read waits for the running one to settle. */
function settled(controller: Controller): Promise<void> {
  return new Promise(resolve => {
    if (!controller.getSnapshot().busy) { resolve(); return }
    const stop = controller.subscribe(() => {
      if (!controller.getSnapshot().busy) { stop(); resolve() }
    })
  })
}

/**
 * @@@client-state-model ① — this account's V2 closure admission, read by trusted native (readPolicy) through the one
 * shared flow. Account-scoped, so an answer read for A never shows for B; not persisted, so admission is read live.
 */
export const accountClosurePolicy = replica({
  name: 'accountClosureV2Policy',
  scope: 'account',
  read: async (owner: string): Promise<AccountClosureV2Policy> => {
    const controller = accountClosureV2Controller()
    if (!controller) throw coded('closure_unavailable')
    for (;;) {
      await settled(controller)
      try { await controller.refresh(); break }
      catch (error) { if ((error as { code?: unknown } | null)?.code !== 'closure_busy') throw error }
    }
    if (getRendererSession()?.user.id !== owner) throw coded('wrong_local_owner')
    const { policy } = controller.getSnapshot()
    if (policy.status !== 'known') throw coded(policy.status === 'failed' ? policy.code : 'closure_unavailable')
    return policy.value
  },
})
