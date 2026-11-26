import fs from 'node:fs'

/**
 * 进程还活着吗。`kill(pid, 0)` 对**僵尸进程**也返回成功:进程已经退出、只是父进程还没收尸。
 * 容器里 PID 1 常常是 `sleep infinity` 这类不收尸的东西,脱离终端启动的 server 退出后就一直是僵尸 ——
 * 只看 kill(0) 会把它当成「还在跑」:`gugu-server stop` 等满超时、升级后的新版本等旧进程等满 60 秒、
 * 单实例锁不敢接管。Linux 上多看一眼 /proc/<pid>/stat 的状态位,Z = 已经退出。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // 格式:pid (comm) state …;comm 里可能有空格和括号,所以从最后一个 ')' 往后取。
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

export function readProcCmdline(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return null
  }
}
