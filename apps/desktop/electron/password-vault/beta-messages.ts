import type { PasswordRequestView } from '@gugu/core/shared/passwordBetaProtocol'
import { PASSWORD_ASK_OPEN, PASSWORD_ASK_SOURCE } from '@gugu/core/shared/passwordBetaProtocol'

/**
 * A pending password request (password_fill's approval, password_save's form) is an Ask of its Agent's session (source
 * `password`, asks/index.ts): the same chain an App install asks through, so it waits above the composer, on the chat's band,
 * the phone and the attention dot, never inside the turn that made the call. Its card (the form) is drawn from the Ask's
 * payload. The vault settles the request, not an answer to the Ask: the Ask ends when the outcome is delivered
 * (`endPasswordRequest`), and an option pressed on a surface that cannot show the card is refused with where to answer.
 */
const open = new Map<string, AbortController>()

export async function openPasswordRequest(view: PasswordRequestView): Promise<void> {
  const [{ ask }, { readSessionRow }] = await Promise.all([import('../session/main/core/asks'), import('../session/main/core/session-timeline/service')])
  if (!readSessionRow(view.sessionId)) throw new Error('password_notification_unavailable')
  const controller = new AbortController()
  open.get(view.requestId)?.abort()
  open.set(view.requestId, controller)
  const host = (() => { try { return new URL(view.origin).host } catch { return view.origin } })()
  void ask(view.sessionId, {
    itemId: view.requestId,
    kind: 'permission',
    // What a surface that does not know this source shows; those that do draw the card from the payload.
    title: view.kind === 'save' ? `${view.agentName} asks you to save a credential for ${host}` : `${view.agentName} asks to fill your ${host} credential`,
    ...(view.kind === 'save' && view.hint ? { detail: view.hint } : {}),
    options: [{ optionId: PASSWORD_ASK_OPEN, name: 'Open', kind: 'allow_once' }],
    origin: { source: PASSWORD_ASK_SOURCE, payload: view },
  }, { signal: controller.signal, refuse: () => 'Answer this on the card in the session on a computer' })
    .finally(() => { if (open.get(view.requestId) === controller) open.delete(view.requestId) })
}

/** The request has its outcome (or ended): its Ask leaves every surface. */
export function endPasswordRequest(requestId: string): void {
  open.get(requestId)?.abort()
}
