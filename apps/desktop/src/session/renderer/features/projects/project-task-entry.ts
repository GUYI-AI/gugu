import { readChatSummary } from '@/lib/chatSummariesBridge';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import { composerDrafts, projectDraftKey } from '@renderer/features/sessions/composer-drafts';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { accountProjectsStore } from './stores/account-projects-store';
import { carryRunMachine } from './components/main-panel/project-run-machine';

/**
 * 去这个项目里开新任务(gugu-dev#181):侧栏项目行的「+」、新建会话页 / 项目首页托盘里换项目都走这一条,调用方随后进项目块。
 * 写好的话(`carryFrom` 那一格草稿)落进项目块新任务框的草稿;群里已经有消息时框直接是「新任务」、文件夹卡浮出来 ——
 * 还没有消息时项目块就是项目首页,那个框本来就是新任务。
 * `machine`:人在这之前选好的机器(设备 id),项目块里先选它;❌ 记上账号 —— 在它上面真建了任务才记。
 */
export function prepareProjectTask(projectId: string, carryFrom?: string, machine?: string): void {
  if (carryFrom) composerDrafts.moveToEmpty(carryFrom, projectDraftKey(projectId));
  if (machine) carryRunMachine(sidebarStore.rowProjectIdOf(projectId), machine);
  const chatId = accountProjectsStore.projectOfLocal(projectId)?.chatId;
  if (chatId && readChatSummary(chatId)?.hasMessages) setComposerVerb(chatId, 'task');
}
