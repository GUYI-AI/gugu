// @@@backend-recovered — 「后端又能用了」在每个进程里只有一个读数、一条边:
//   · 渲染层:账号同步节拍的那一拉(`sync_since`;账号还没有游标时是 `sync_snapshot`,列表的读失败态也出自这一拉);
//   · 宿主(桌面主进程 / 咕咕 server / 云电脑,有没有窗口都一样):设备运行宿主的心跳(30 s)。
// 它失败过、又答上了,就是后端恢复;这个进程里别处失败的写(发送、已读、起任务要票、项目发布、建项目群)都在这一刻
// 自己重来,❌ 各自再认 window `online`(网络通而后端不通时它不会响)、❌ 各自起重试定时器。
// 认证的退避不在这里:令牌被拒是另一种失败,归会话协调器。
//
// 只认「失败 → 答上」这条边:后端一直通着时,一条因别的原因失败的写不会被反复重投(那是死循环,不是恢复)。
// 一条写失败时请本进程的节拍立刻再拉一次(probe):后端真断着,这一拉也失败,边就挂上了 —— 比一个节拍短的中断也看得见。

type Listener = () => void

const listeners = new Set<Listener>()
let answering = true
let probe: (() => void) | null = null

/** 这个进程的读数(同步那一拉 / 宿主心跳)。中止(换号 / 停止)不算读数。 */
export function noteBackendAnswer(ok: boolean): void {
  const recovered = ok && !answering
  answering = ok
  if (recovered) for (const listener of [...listeners]) listener()
}

/** 「失败 → 答上」那一刻叫一次;后端一直通着不叫。 */
export function subscribeBackendRecovered(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 一次后端请求(读或写)失败了:请节拍现在就拉一次,好知道后端是不是断了。 */
export function noteBackendRequestFailed(): void {
  probe?.()
}

/** 节拍的主人接上「现在拉一次」;撤掉时(换号 / 宿主停)回到「后端可达」的初值。 */
export function bindBackendProbe(pull: () => void): () => void {
  probe = pull
  return () => {
    if (probe === pull) probe = null
    answering = true
  }
}
