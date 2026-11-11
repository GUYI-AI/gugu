import { openAssistantPanelTask, type AssistantPanelTask } from '@/components/assistant/assistant-panel-tasks'
import { showAssistantTaskChat } from '@/lib/assistantTaskChat'

/** The tasks the ledger read last (PhoneAssistantWorkLedger), for `openWork` to find the row it was handed (only the layer's own read). */
let latest: { assistantId: string; tasks: readonly AssistantPanelTask[] } | null = null

export function rememberWorkTasks(assistantId: string, tasks: readonly AssistantPanelTask[]): void {
  latest = { assistantId, tasks }
}

export function forgetWorkTasks(): void {
  latest = null
}

/** What the layer does for `gugu.bindings.openWork` / `closeWork` (API 46): the built-in way a task's conversation opens. */
export const phoneWorkChats = {
  open(assistantId: string, work: { workId: string; sessionId: string } | null): void {
    if (!work) {
      showAssistantTaskChat(null)
      return
    }
    const task = latest?.assistantId === assistantId ? latest.tasks.find((row) => row.workId === work.workId && row.id === work.sessionId) : undefined
    if (task) openAssistantPanelTask({ assistantId }, task)
  },
}
