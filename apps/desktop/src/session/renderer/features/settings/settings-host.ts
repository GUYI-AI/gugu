// #6264 设置里**跟机器走**的那几组(默认 tmux、仓库)看的是哪台机器(owner 2026-09-24:「那是那台机器的行为」)。
// 默认本机:照旧走本机的 `rpc.appSettings` 与全局那份设置缓存。选了别的机器:读写送到那台机器上
// 同一个 `appSettingsController`(界面只把跟机器走的那几组画在机器选择之下);缓存另起一份键,❌ 盖本机的。
// 自动批准、自动起名、界面、浏览器、通知跟着这个窗口,不在这里。
import { createContext, useContext } from 'react';
import { LOCAL_SETTINGS_HOST_KEY } from './app-settings-client';

export type RemoteSettingsKey = 'project' | 'localProject';

export type SettingsRemoteDevice = {
  deviceId: string;
  deviceLabel: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type SettingsHost = {
  /** The app-settings read model's host argument: `local`, or the machine's device id (rpc goes there). */
  key: string;
  /** null = 本机。 */
  remote: SettingsRemoteDevice | null;
};

export const LOCAL_SETTINGS_HOST: SettingsHost = { key: LOCAL_SETTINGS_HOST_KEY, remote: null };

/** 别的机器:同一个 `appSettingsController`,rpc 送到那台机器;读模型里另起一份(主机参数 = 设备 id),❌ 盖本机的。 */
export function createMachineSettingsHost(device: SettingsRemoteDevice): SettingsHost {
  return { key: device.deviceId, remote: device };
}

const SettingsHostContext = createContext<SettingsHost>(LOCAL_SETTINGS_HOST);

export const SettingsHostProvider = SettingsHostContext.Provider;

/** 跟机器走的那几行里 = 选的那台;其余任何地方 = 本机。 */
export function useSettingsHost(): SettingsHost {
  return useContext(SettingsHostContext);
}
