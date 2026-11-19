import type { Device } from '@gugu/core/shared/types/chat'
import { platform } from '@/platform'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { machineRpc } from '@/components/session-watch/sessionpage-rpc'
import { routeRemoteSettings } from '@/session/renderer/features/settings/app-settings-client'

/** 问一台机器上的项目:手机经那台机器的会话页管道;窄窗口的桌面问自己走本机,问别的机器同电脑那一条(同 useAssistantWorkrooms)。 */
// The phone reaches another machine's settings the way it reaches its projects (one route per shell, set as this loads).
if (!platform.capabilities.agentRuntime) routeRemoteSettings((host) => machineRpc(host) as unknown as ReturnType<typeof rpcOn>)

export function projectRpcOn(device: Pick<Device, 'device_id' | 'is_current_device'>) {
  return platform.capabilities.agentRuntime ? rpcOn(device.is_current_device ? null : device.device_id) : machineRpc(device.device_id)
}
