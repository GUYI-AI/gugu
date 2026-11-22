import { createAssistantPanelClient, AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { enqueueAssistantNotice } from '@/lib/outbox/kinds/assistantNotice'
import { identityDb } from '@/lib/supabase'
import { myAssistant } from '@/lib/myAssistant'
import { getRendererSession } from '@/lib/sessionPublication'
import { assistantAppChangeSchema, type AssistantAppChange } from '@/session/shared/extensions/assistant-app'

const accountId = () => getRendererSession()?.user.id ?? null
export const assistantPanelCloud = createAssistantPanelClient(async (name,args) => {
  const { data,error,status } = await identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
  return { data,error,status }
},accountId)

export function assertAssistantPanelOwner(expectedOwner: string | null): asserts expectedOwner is string {
  if (!expectedOwner || accountId() !== expectedOwner) throw new AssistantPanelError('account-changed','Assistant panel account changed')
}

/** The assistant the outbox addresses: the account's `myAssistant` replica, read for the owner the notice belongs to. */
export async function personalAssistant(owner: string): Promise<string | null> {
  assertAssistantPanelOwner(owner)
  const assistant = await myAssistant.fetch()
  assertAssistantPanelOwner(owner)
  return assistant.agentId
}

/** Durable through the outbox (kind `assistantNotice`): the source edit has already saved; telling the assistant follows. */
export async function queueAssistantAppChange(
  change: AssistantAppChange, assistantId: string | undefined, expectedOwnerId: string | null,
): Promise<void> {
  assertAssistantPanelOwner(expectedOwnerId)
  await enqueueAssistantNotice(assistantAppChangeSchema.parse(change), assistantId)
}
