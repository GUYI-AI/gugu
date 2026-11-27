import { createLogger } from '../lib/logger'

/**
 * 「这条会话的 gugu MCP 已经被引擎列过工具」—— 首句走 local-session 的终端腿的启动门
 * (`EmdashPtyCommandOverride.startupGate`)。事实来源与 claude TUI 的投递就绪同一个:宿主为这条会话的
 * grant 送出 `tools/list` 应答(`GuguMcpHost.onToolsListed`,#4896)。
 *
 * 为什么要等:Antigravity `agy` 在工具列出之前收到的那一轮,模型请求里没有咕咕的工具
 * (2026-09-24 实测,`impl/antigravity/index.ts` 的 `prompt`)。
 *
 * ⚠️ 预算只是「一直没就绪」的兜底边界,❌ 不是延时:正常路径上门在 `tools/list` 那一刻就开。
 *    到点仍没来 ⇒ 记一条警告、照样开门 —— 消息照送(那一轮没有咕咕工具),❌ 不让用户的消息卡死在门外。
 *    MCP 起不来本身另有报告(能力加载报告里的 mcp 单元)。
 */
export const MCP_READY_GATE_BUDGET_MS = 60_000

export interface ToolsListedSource {
  onToolsListed(key: string, listener: () => void): () => void
}

export function guguMcpToolsListedGate(
  host: ToolsListedSource,
  grantKey: string,
  sessionId: string,
  budgetMs: number = MCP_READY_GATE_BUDGET_MS,
): Promise<void> {
  return watchToolsListed(host, grantKey, sessionId, budgetMs)()
}

/**
 * 现在就订阅,预算从**第一次调返回的函数**起算:订阅要赶在引擎进程起来之前,而「等多久算等不到」只能从真正
 * 开始等算 —— 中间隔着起进程、开会话、回放旧会话,哪一段都可能比预算长。
 */
function watchToolsListed(host: ToolsListedSource, grantKey: string, sessionId: string, budgetMs: number): () => Promise<void> {
  let markListed!: () => void
  const listed = new Promise<void>((resolve) => { markListed = resolve })
  const unsubscribe = host.onToolsListed(grantKey, () => {
    unsubscribe()
    markListed()
  })
  let waiting: Promise<void> | undefined
  return () => waiting ??= new Promise<void>((resolve) => {
    const budget = setTimeout(() => {
      createLogger('sessionpage').warn(
        { sessionId, budgetMs, grantKey },
        'MCP tools/list did not arrive within the startup budget; opening the startup gate anyway',
      )
      unsubscribe()
      resolve()
    }, budgetMs)
    void listed.then(() => {
      clearTimeout(budget)
      resolve()
    })
  })
}

/** 咕咕自己那台之外的托管 server(集成、App)等这么久:它们起不来时,首句不该陪着等满一分钟。 */
export const HOSTED_MCP_READY_GATE_BUDGET_MS = 15_000

export interface HostedToolsListedSource extends ToolsListedSource {
  grantKeyFor(url: string): string | undefined
}

/**
 * 聊天面板腿的首句门(引擎先连上 MCP 才有工具的那几家,Antigravity `agy acp`):等这条会话里**由咕咕托管**的每一台
 * 都送出过 `tools/list` —— 咕咕那台、集成、App(浏览器等,实测比首句晚到近 1 秒)。别处的地址(资源库里的远端
 * server)看不见它的应答,不等。调用即订阅;返回的函数才开始等、开始计预算。
 */
export function hostedMcpToolsListedGate(
  hosts: ReadonlyArray<HostedToolsListedSource | null | undefined>,
  servers: ReadonlyArray<{ url?: string; owner?: string }>,
  sessionId: string,
): () => Promise<void> {
  const watched = servers.flatMap(({ url, owner }) => {
    if (url === undefined) return []
    for (const host of hosts) {
      const key = host?.grantKeyFor(url)
      if (host && key !== undefined) {
        return [watchToolsListed(host, key, sessionId,
          owner === 'gugu' ? MCP_READY_GATE_BUDGET_MS : HOSTED_MCP_READY_GATE_BUDGET_MS)]
      }
    }
    return []
  })
  return async () => { await Promise.all(watched.map((wait) => wait())) }
}
