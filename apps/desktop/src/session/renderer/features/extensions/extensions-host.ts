// #6264 资源库 → 扩展看的是**哪一台咕咕**。本机:原样走 `rpc.extensions`;另一台咕咕桌面:经那台机器的会话页宿主调同一个
// `extensionsController`,改动后由那台机器自己的窗口补上 / 撤下 tab(它收到 `extensionsInventoryChangedChannel`)。
// 装着的清单是 `installedExtensions(host.key)`(installed-extensions.ts),按 key 找 API 的只有 `extensionsApiOf`。
// 咕咕 server 没有窗口,扩展在它上面跑不起来 —— 那种机器不走这里(资源库那一格如实说一句)。
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { extensionsApiOf, LOCAL_HOST, remoteHostKey } from './extensions-api';

export type ExtensionsApi = Pick<
  typeof rpc.extensions,
  | 'list'
  | 'switchVariant'
  | 'revoked'
  | 'market'
  | 'marketEntry'
  | 'marketUpdates'
  | 'marketRefresh'
  | 'marketListing'
  | 'marketRead'
  | 'marketHistory'
  | 'installFromMarket'
  | 'installFromFolder'
  | 'setPermissionGranted'
  | 'setEnabled'
  | 'setAutoUpdate'
  | 'setDisclosure'
  | 'appPlaces'
  | 'changeAppPlaces'
  | 'unreadBindingChoices'
  | 'setUnreadBinding'
  | 'uninstall'
  | 'agentStatus'
  | 'agentTools'
  | 'agentSkills'
  | 'appData'
  | 'clearAppData'
  | 'setTabHidden'
  | 'settings'
  | 'setSettings'
>;

export type ExtensionsHost = {
  /** The host key of its replicas (`installedExtensions(key)` …): `local` or `remote:<deviceId>`. */
  key: string;
  api: ExtensionsApi;
  /** 这台机器主进程推的事件(下载进度);别的机器只在那次调用进行中转过来。返回退订。 */
  onEvent<T>(event: { name: string; _data?: T }, listener: (data: T) => void): () => void;
  /** 本机:装 / 卸 / 开关之后要在**这个窗口**里补上 / 撤下 tab。别的机器:它自己的窗口跟进,这里不碰。 */
  local: boolean;
  /** 「从文件夹安装」挑的是哪台机器上的文件夹。 */
  pickFolder(options: { title: string; message: string }): Promise<string | null | undefined>;
};

export const LOCAL_EXTENSIONS_HOST: ExtensionsHost = {
  key: LOCAL_HOST,
  api: extensionsApiOf(LOCAL_HOST),
  // 只听本机推的(下载进度、市场刷新):别的机器的在它自己那一页上按机器订。
  onEvent: (event, listener) => onMachineEvent(null, event, listener),
  local: true,
  pickFolder: (options) => rpc.app.openSelectDirectoryDialog(options),
};

export function createRemoteExtensionsHost(
  deviceId: string,
  pickFolder: (deviceId: string, initialPath: string) => Promise<string | null>
): ExtensionsHost {
  const key = remoteHostKey(deviceId);
  return {
    key,
    api: extensionsApiOf(key),
    onEvent: (event, listener) => onMachineEvent(deviceId, event, listener),
    local: false,
    pickFolder: () => pickFolder(deviceId, '~'),
  };
}
