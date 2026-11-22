import type { PasswordBetaUi, PasswordRequestView, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { createPasswordCardKey, openPasswordCard, PASSWORD_SAVE_CARD_RPC, sealPasswordCard } from '@gugu/core/shared/passwordCardCipher'
import { callDeviceRpc } from './deviceRpc'

type Call = (deviceId: string, payload: { requestId: string; sealed: string }) => Promise<{ sealed: string }>
/** A card keeps its draft in the person's UI. Neither proposal nor typed values enter a message or relay plaintext. */
export function remotePasswordSaveCard(request: PasswordRequestView, local: PasswordBetaUi | undefined, call: Call): PasswordBetaUi | undefined {
  if (request.kind !== 'save' || !request.saveKey) return local
  let route: Promise<'local' | 'remote'> | undefined, disposed = false
  const key = createPasswordCardKey()
  const select = () => route ??= (async () => {
    if (local) { const reply = await local.invoke({ type: 'snapshot' }); if (reply.ok && reply.snapshot.saves.some(value => value.requestId === request.requestId)) return 'local' as const }
    return 'remote' as const
  })()
  const invoke = async (command: PasswordUiCommand): Promise<PasswordUiReply> => {
    if (disposed) return { ok: false, code: 'UNAVAILABLE' }
    if (await select() === 'local') return local!.invoke(command)
    if (!['snapshot', 'save-draft', 'save', 'reject-save'].includes(command.type)) return { ok: false, code: 'UNAVAILABLE' }
    const pair = await key, nonce = crypto.randomUUID()
    const sealed = await sealPasswordCard(request.saveKey!, { requestId: request.requestId, replyKey: pair.publicKey, nonce, command })
    const reply = await call(request.deviceId, { requestId: request.requestId, sealed })
    const opened = await openPasswordCard(pair, reply.sealed) as { requestId?: string; nonce?: string; reply?: PasswordUiReply }
    if (opened.requestId !== request.requestId || opened.nonce !== nonce || !opened.reply || disposed) throw new Error('password_card_unavailable')
    return opened.reply
  }
  return { invoke, subscribe(listener) {
    const close = local?.subscribe(listener), timer = setInterval(listener, 5000)
    return () => { disposed = true; close?.(); clearInterval(timer); void key.then(pair => pair.privateKey.fill(0)) }
  } }
}

declare global { interface Window { passwordSaveCards?: { forRequest(request: PasswordRequestView): PasswordBetaUi | undefined } } }
/** The renderer's entry installs the remote save card once (main.tsx). */
export function installPasswordSaveCards(): void {
  window.passwordSaveCards = { forRequest: request => remotePasswordSaveCard(request, window.passwordVaultBeta, async (deviceId, payload) => {
    const reply = await callDeviceRpc<{ sealed: string }>(deviceId, PASSWORD_SAVE_CARD_RPC, payload, { timeoutMs: 15000 })
    if (!reply.result?.sealed || reply.error) throw new Error('password_card_unavailable')
    return reply.result
  }) }
}
