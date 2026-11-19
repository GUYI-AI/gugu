import type { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'

type Client = Pick<Awaited<ReturnType<typeof getAgentConfigRuntimeClient>>, 'refreshAuthStatus' | 'removeConnection'>

/**
 * 「添加连接 → 账号」那一趟没登成功（失败或者点了取消），就把这条新连接拿掉
 * （owner 2026-11-12 选 A：「从没登上的连接没有用处，只会越积越多，想重试再点一次『添加连接』就行」）。
 *
 * 判据是这条连接**此刻的登录读数**，❌ 看登录窗口是怎么关的：窗口关掉和登录成功谁先到没有保证，
 * 用户也可能在网页上点完同意才关窗。读到「未登录」才删；已登录、读不出（读失败 / unknown）一律留着 ——
 * 判不准的东西不删。
 */
export async function dropIfNeverSignedIn(
  client: Client,
  input: { providerId: string; connectionId: string }
): Promise<'removed' | 'kept'> {
  const status = await client.refreshAuthStatus(input)
  if (!status.success || status.data.kind !== 'unauthenticated') return 'kept'
  const removed = await client.removeConnection(input)
  if (!removed.success) throw new Error(`could not remove the unsigned connection ${input.connectionId}`)
  return 'removed'
}
