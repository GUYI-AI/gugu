import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { ASSISTANT_PROVISION_SELECT, pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';

/**
 * #1925 (API 46) Whether a conversation is the account's private chat with its own assistant — what the binding's `work` and
 * the host's row above the conversation (`conversationSurface.header`) both stand on: the assistant by the account's provision
 * marker, and the chat a `dm` whose members are that account and that assistant, no one else. Read as the account. The caller
 * asks the account and its own choice again after the wait.
 */
const coded = (code: 'denied' | 'failed', message: string) => Object.assign(new Error(message), { code });

/** The account's own assistant, by its provision marker; null: it has none. A marker that cannot be read is not "none". */
async function personalAssistant(token: string, ownerId: string): Promise<string | null> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('agent_provisions').select(ASSISTANT_PROVISION_SELECT).eq('owner_user_id', ownerId).eq('member_key', 'assistant');
  if (error) throw coded('failed', 'Could not verify the personal assistant');
  try {
    return pickAssistant((data ?? []) as AssistantProvisionRow[])?.agentId ?? null;
  } catch {
    throw coded('failed', 'Could not verify the personal assistant');
  }
}

/** What the conversation is, and who is in it now. */
async function conversationOf(token: string, chatId: string): Promise<{ kind: string | null; members: string[] }> {
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const [chat, members] = await Promise.all([
    client.from('chats').select('kind').eq('id', chatId).maybeSingle(),
    client.from('active_members').select('user_id').eq('chat_id', chatId),
  ]);
  if (chat.error || members.error) throw coded('failed', 'Could not verify the chosen conversation');
  return {
    kind: (chat.data as { kind?: string } | null)?.kind ?? null,
    members: ((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id),
  };
}

/** The assistant whose private chat with the account `chatId` is. `denied`: it is not; `failed`: it could not be verified now. */
export async function ownAssistantOfChat(token: string, ownerId: string, chatId: string): Promise<string> {
  const [assistant, conversation] = await Promise.all([personalAssistant(token, ownerId), conversationOf(token, chatId)]);
  if (!assistant) throw coded('denied', 'This account has no assistant of its own');
  const members = new Set(conversation.members);
  if (conversation.kind !== 'dm' || members.size !== 2 || !members.has(ownerId) || !members.has(assistant)) {
    throw coded('denied', 'The chosen conversation is not your private chat with your own assistant');
  }
  return assistant;
}
