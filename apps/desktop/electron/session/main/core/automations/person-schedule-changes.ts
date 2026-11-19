import type { UpdateAutomationSettingsPatch } from '@shared/core/automations/automation';
import { log } from '@main/lib/logger';
import { tellAgentScheduleChanged, type AgentScheduleChange } from './agent-schedules';
import { automationsService } from './automations-service';
import { getAutomation } from './repo';

/**
 * 人那条路上对「已安排」的改动(「已安排」页、任务页的托盘、手机经控制器;#1928 起还有人授权的 App 经 app-agent-schedules.ts):
 * 改的是 agent 排的那条,就告诉它(owner 10-19 B)。通知没存进去不回滚人的操作 —— 那一下已经做成了,响亮记日志。
 * 从 controller.ts 原样搬来,两条入口共用这一份,❌ 各写一遍。
 */
export async function tellAgent(change: AgentScheduleChange): Promise<void> {
  try {
    await tellAgentScheduleChanged(change);
  } catch (error) {
    log.error('automations: could not tell the agent its schedule changed', {
      automationId: change.automation.id,
      kind: change.kind,
      error: String(error),
    });
  }
}

/** 人停掉 / 重新打开 agent 排的那条:与取消、改时间同一个道理,它要知道这条还会不会回来。 */
export async function setEnabledAndTell(id: string, enabled: boolean): Promise<void> {
  const before = await getAutomation(id);
  await automationsService.setAutomationEnabled(id, enabled);
  if (!before?.agentSessionId || before.enabled === enabled) return;
  const automation = await getAutomation(id);
  if (!automation) return;
  const next = enabled ? await automationsService.getNextScheduledRun(id) : null;
  await tellAgent(enabled ? { kind: 'resumed', automation, nextRunAt: next?.scheduledAt ?? null } : { kind: 'paused', automation });
}

export async function updateSettingsAndTell(id: string, patch: UpdateAutomationSettingsPatch) {
  const before = await getAutomation(id);
  const automation = await automationsService.updateAutomationSettings(id, patch);
  // 真改了、而且它还开着才说:原样保存不算改;停着的那条它本来就不指望回来,重新开的时候再说(见上)。
  const moved = JSON.stringify(before?.triggerConfig ?? null) !== JSON.stringify(automation.triggerConfig ?? null);
  if (automation.agentSessionId && automation.enabled && moved) {
    const next = await automationsService.getNextScheduledRun(id);
    await tellAgent({ kind: 'rescheduled', automation, nextRunAt: next?.scheduledAt ?? null });
  }
  return automation;
}

export async function deleteAndTell(id: string): Promise<void> {
  const automation = await getAutomation(id);
  // 只有本来还会响的那条才要告诉它:过了点、没送到的那条点「不用了」,它那边本来就不会再回来。
  const pending =
    automation?.agentSessionId && automation.enabled ? await automationsService.getNextScheduledRun(id) : null;
  await automationsService.deleteAutomation(id);
  if (automation && pending) await tellAgent({ kind: 'cancelled', automation });
}
