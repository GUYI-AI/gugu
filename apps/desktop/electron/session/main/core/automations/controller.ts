import { createRPCController } from '@shared/lib/ipc/rpc';
import type { UpdateAutomationSettingsPatch } from '@shared/core/automations/automation';
import {
  restoreAgentSchedules,
  type AgentScheduleCaller,
  type RestorableSchedule,
} from './agent-schedules';
import { automationsService } from './automations-service';
import { listSessionSchedules } from './repo';
import { deleteAndTell, setEnabledAndTell, updateSettingsAndTell } from './person-schedule-changes';

/**
 * 这个控制器是**人**那条路(「已安排」页、任务页的托盘、手机);agent 自己的 schedule_* 走会话分派器,不经过这里。
 * 所以人动了 agent 排的那条(取消、改时间、停掉 / 重新打开),要告诉它(owner 10-19 B):见 person-schedule-changes.ts,
 * 人授权的 App(#1928)也走那一份。
 */
export const automationsController = createRPCController({
  listAutomations: automationsService.listAutomations.bind(automationsService),
  createAutomation: automationsService.createAutomation.bind(automationsService),
  updateAutomationSettings: (id: string, patch: UpdateAutomationSettingsPatch) => updateSettingsAndTell(id, patch),
  renameAutomation: automationsService.renameAutomation.bind(automationsService),
  setAutomationEnabled: (id: string, enabled: boolean) => setEnabledAndTell(id, enabled),
  toggleAutomationEnabled: (id: string, enabled: boolean) => setEnabledAndTell(id, enabled),
  listAutomationRuns: automationsService.listAutomationRuns.bind(automationsService),
  countAutomationRunsByStatus:
    automationsService.countAutomationRunsByStatus.bind(automationsService),
  getLatestRun: automationsService.getLatestRun.bind(automationsService),
  getNextScheduledRun: automationsService.getNextScheduledRun.bind(automationsService),
  runAutomation: automationsService.runAutomation.bind(automationsService),
  stopRun: automationsService.stopRun.bind(automationsService),
  getRun: automationsService.getRun.bind(automationsService),
  deleteAutomation: (id: string) => deleteAndTell(id),
  /** 这台机器上每条会话给自己排的定时里,任务页要给人看的那些(行上的时钟、输入框上方的托盘)。 */
  listSessionSchedules: async () => listSessionSchedules(),

  /**
   * #7199 助理搬家:把旧家那台上它给自己排的「已安排」在这台机器、它这条会话上重排。
   * 幂等(同一条已在就不再排),一次性且已过点的不排并如实回报。
   */
  restoreAgentSchedules: async (target: AgentScheduleCaller, schedules: RestorableSchedule[]) =>
    restoreAgentSchedules(target, schedules),
});
