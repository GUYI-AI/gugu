import type { Device } from '@gugu/core/shared/types/chat'
import { queryClient, readModel, readModelAccount } from '../lib/readModel'
/**
 * 这个账号的机器(含手机)—— 读模型(lib/readModel)的一项。
 *
 * 为什么跨重启留一份:机器列表是手机端进 App 看到的**第一页**,冷启动不该从空白 + 转圈开始
 * (owner 2026-09-09:「手机上有些东西不需要每次都重新去请求」)。读模型的快照按账号存、同步读回,第一帧就有。
 *
 * ⚠️ 存的是**上次已知**的状态,不是此刻的事实:在线与否会变。所以它只活到第一次重读返回为止;点进一台其实
 * 已经离线的机器,会话页有现成的离线提示接着。
 *
 * 换账号、登出:读模型只在真登出、或认出另一个人时才清(会话没恢复完、界面不活跃、断网刷不动 token 都不清 ——
 * 那三种都撞过,清一次缓存就没了、而界面看上去只是「又在读取」)。
 */
export const devicesModel = readModel({
  name: 'devices',
  scope: 'account',
  // 读的那一段在 devicesRead.ts,按需载入:这个文件是很多非 React 读者的叶子模块,❌ 把聊天服务拉进它们的依赖。
  read: async (owner) => (await import('./devicesRead')).readDevices(owner),
  persist: true,
})

/** The last known machines of the signed-in account; empty until this device ever read them. For logic outside React. */
export function readCachedDevices(): Device[] {
  const reading = devicesModel.peek()
  return reading.state === 'value' ? [...reading.value] : []
}

/** Whose machines `readCachedDevices` are: the account the read model follows (null = nobody yet). */
export function cachedDevicesAccount(): string | null {
  return readModelAccount().id
}

/** The machines changed (a read, a heartbeat flip folded in, an account switch). */
export function subscribeCachedDevices(listener: () => void): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === devicesModel.name && (event.type === 'updated' || event.type === 'removed')) listener()
  })
}

/** Put rows for the account signed in now (a test or a synchronous writer; after an await use `devicesModel.at()`). */
export function writeCachedDevices(rows: readonly Device[]): void {
  devicesModel.set([], [...rows])
}
