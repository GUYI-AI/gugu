import { Capacitor } from '@capacitor/core'
import { getRendererSession } from '../../lib/sessionPublication'
import { nativeAgent } from '../local-agent/nativeAgent'

/** Only existing explicit enable controls call this. Reconcile and new session admission never do. */
export async function resumePhoneAfterAccountClosure(ownerId: string, commitChoice: () => void): Promise<void> {
  const sameOwner = () => {
    if (getRendererSession()?.user.id !== ownerId) throw Object.assign(new Error('Current phone owner changed'), { code: 'wrong_local_owner' })
  }
  sameOwner()
  // Older shells cannot have V2 custody. A native failure on a V2 shell never falls through.
  if (Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform()) && Capacitor.isPluginAvailable('GuguAccountClosureV2')) {
    const reply = await nativeAgent.resumeAfterAccountClosure({ ownerId })
    sameOwner()
    if (!reply || reply.resumed !== true || Object.keys(reply).length !== 1) {
      throw Object.assign(new Error('Phone resume was not acknowledged'), { code: 'closure_unavailable' })
    }
  }
  sameOwner(); commitChoice()
}
