import type { GuguMcpContext } from '../acp-engine-utils'
import type { PasswordRequestView } from '@gugu/core/shared/passwordBetaProtocol'
import { PASSWORD_REQUEST_PREFIX } from '@gugu/core/shared/passwordBetaProtocol'

/** Reuses the native owner-notification commit. No generic question/Settlement or host-wait entry. */
export async function postPasswordRequest(context: GuguMcpContext, view: PasswordRequestView): Promise<void> {
  if (context.kind !== 'social' || !context.runHostAction) throw new Error('password_notification_unavailable')
  const receipt = await context.runHostAction({ action: 'owner-notify', request_id: view.requestId,
    agent_user_id: context.agentId, text: PASSWORD_REQUEST_PREFIX + JSON.stringify(view) }) as { status?: string; message_id?: string }
  if (receipt?.status !== 'sent' || receipt.message_id !== view.requestId) throw new Error('password_notification_unavailable')
}
