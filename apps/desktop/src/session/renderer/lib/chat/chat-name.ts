import { groupDisplayName } from '@gugu/core/shared/ui/chatModels';
import { readChatSummary, resolveChatId } from '@/lib/chatSummariesBridge';

/**
 * 群名只以壳的聊天列表为准(备注优先)。同一个群可绑多个本地文件夹，❌ 拿某个文件夹的项目名顶替。
 * 认不出来 = null，调用方只说「来自群聊」。
 */
export function chatDisplayName(chatId: string): string | null {
  chatId = resolveChatId(chatId) ?? chatId;
  const summary = readChatSummary(chatId);
  return summary?.name ? groupDisplayName({ name: summary.name, alias: summary.alias }) : null;
}
