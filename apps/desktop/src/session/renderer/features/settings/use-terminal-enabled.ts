import { observable, runInAction } from 'mobx';
import { queryClient, useReadModel, type Reading } from '@/lib/readModel';
import { appSettingsModel, getAppSettingValueSnapshot, LOCAL_SETTINGS_HOST_KEY, type SettingsMeta } from './app-settings-client';

/**
 * 设置 → 通用里的「允许以终端（TUI）模式启动 agent」(本机的 `terminal.enabled`)。关着:终端的入口与界面一律
 * 不出现,新任务一律通用;开着:终端入口回来,新任务框里给「终端 | 通用」由人选,默认通用(owner 10-30)。
 * 只管人看不看得到、选不选得到终端 —— ❌ 拿它去拦 agent 自己的 pty 会话,❌ 拿它改已有任务。
 * 读的永远是**本机**这一份(❌ 走 useSettingsHost:机器设置页选了别的机器时,这里仍说本机给不给人看终端)。
 * 还没读到 = unknown:入口不画(与「关」同样不出现),开关画 `<Unknown/>`,❌ 画成「关」。
 */
export function useTerminalEnabled(): Reading<boolean> {
  const reading = useReadModel(appSettingsModel, ['terminal', LOCAL_SETTINGS_HOST_KEY]);
  return reading.state === 'value'
    ? { ...reading, value: (reading.value as SettingsMeta<'terminal'>).value.enabled === true }
    : reading;
}

/** Whether terminal entry points are drawn: only once read and on. */
export const terminalShown = (reading: Reading<boolean>): boolean => reading.state === 'value' && reading.value;

// 同一份读数的 MobX 镜像:命令注册表是 @computed,只认 observable —— 开关一拨,命令面板与快捷键跟着变。
const terminalEnabledBox = observable.box(false);
let mirrorInstalled = false;

function installMirror(): void {
  if (mirrorInstalled) return;
  mirrorInstalled = true;
  const sync = () =>
    runInAction(() => terminalEnabledBox.set(getAppSettingValueSnapshot('terminal')?.enabled === true));
  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === appSettingsModel.name && event.query.queryKey[2] === 'terminal') sync();
  });
  sync();
}

/** 非 React 版本(命令注册表等 MobX 计算里读):终端命令只在读到且开着时出现。 */
export function terminalEnabledSnapshot(): boolean {
  installMirror();
  return terminalEnabledBox.get();
}
