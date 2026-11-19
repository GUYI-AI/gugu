import { groupDisplayName } from '@gugu/core/shared/ui/chatModels';
import { readChatSummary, resolveChatId } from '@/lib/chatSummariesBridge';

/** 群名以壳的聊天列表为准。认不出来 = null，调用方只说「来自群聊」。 */
export function chatDisplayName(chatId: string): string | null {
  chatId = resolveChatId(chatId) ?? chatId;
  const summary = readChatSummary(chatId);
  const name = summary?.name ?? null;
  return name ? groupDisplayName({ name, alias: summary?.alias }) : null;
}
