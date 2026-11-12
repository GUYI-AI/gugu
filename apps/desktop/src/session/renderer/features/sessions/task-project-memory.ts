import type { AccountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';

/**
 * 选择器选中的那一行(项目的代表本地项目)记成哪台机器上的哪个本地项目:那台 = 它所在的机器(machineOf;这台电脑 = null)。
 * ❌ 一律记成这台电脑:别的机器上的项目会被记成「这台 + 那台的 id」,读回来对不上,还盖掉这台电脑最近选的项目。
 * 不选项目 = 这台电脑上清掉。
 */
export function taskProjectChoice(
  rowId: string | undefined,
  localDeviceId: string,
  machineOf: (projectId: string) => string | null,
): { deviceId: string; projectId: string | null } {
  return rowId ? { deviceId: machineOf(rowId) ?? localDeviceId, projectId: rowId } : { deviceId: localDeviceId, projectId: null };
}

/** 记着的(机器, 本地项目)认回账号上的项目,选它此刻的代表(与侧栏、项目块同一个身份);归档了 / 认不出 = undefined。 */
export function rememberedTaskRow(
  choice: { deviceId: string; projectId: string },
  accounts: Pick<AccountProjectsStore, 'projectOfLocal' | 'representativeOf'>,
): string | undefined {
  const account = accounts.projectOfLocal(choice.projectId, choice.deviceId);
  return account && !account.archived ? accounts.representativeOf(account.chatId) : undefined;
}
