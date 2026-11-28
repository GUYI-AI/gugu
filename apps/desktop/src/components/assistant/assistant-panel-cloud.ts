import { createAssistantPanelClient, AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { identityDb } from '@/lib/supabase'
import { getRendererSession } from '@/lib/sessionPublication'

const accountId = () => getRendererSession()?.user.id ?? null
export const assistantPanelCloud = createAssistantPanelClient(async (name,args) => {
  const { data,error,status } = await identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
  return { data,error,status }
},accountId)

export function assertAssistantPanelOwner(expectedOwner: string | null): asserts expectedOwner is string {
  if (!expectedOwner || accountId() !== expectedOwner) throw new AssistantPanelError('account-changed','Assistant panel account changed')
}
