import type { GitStatusModel } from './models/status'

export type GitStatusRequest = {
  worktree: string
  file: string
  env?: NodeJS.ProcessEnv
}
export type GitStatusWorkerRequest =
  | (GitStatusRequest & { type: 'read'; id: number })
  | { type: 'dispose' }
export type GitStatusWorkerReply =
  | { id: number; result: GitStatusModel }
  | { id: number; error: string }

export type GitStatusWorker = {
  postMessage(message: GitStatusWorkerRequest): void
  on(event: 'message', listener: (message: GitStatusWorkerReply) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

/** 一个 runtime 一个线程。原始 git 输出和逐文件读数留在线程内,主进程只收最终模型。 */
export function createGitStatusClient(spawn: () => GitStatusWorker) {
  type Pending = { resolve: (status: GitStatusModel) => void; reject: (error: Error) => void }
  type Live = { worker: GitStatusWorker; pending: Map<number, Pending> }
  let live: Live | null = null
  let nextId = 1
  let disposed = false
  let disposing: Promise<void> | null = null

  const fail = (target: Live, error: Error) => {
    if (live === target) live = null
    for (const request of target.pending.values()) request.reject(error)
    target.pending.clear()
  }
  const start = (): Live => {
    const target: Live = { worker: spawn(), pending: new Map() }
    target.worker.on('message', (message) => {
      const request = target.pending.get(message.id)
      if (!request) return
      target.pending.delete(message.id)
      if ('error' in message) request.reject(new Error(message.error))
      else request.resolve(message.result)
    })
    target.worker.on('error', (error) => fail(target, error))
    target.worker.on('exit', (code) =>
      fail(target, new Error(`Git status worker exited (code ${code})`))
    )
    return target
  }

  return {
    async read(request: GitStatusRequest): Promise<GitStatusModel> {
      if (disposed) throw new Error('Git status client disposed')
      const target = live ?? (live = start())
      const id = nextId++
      return new Promise((resolve, reject) => {
        target.pending.set(id, { resolve, reject })
        try {
          target.worker.postMessage({ ...request, type: 'read', id })
        } catch (error) {
          target.pending.delete(id)
          reject(error)
        }
      })
    },
    dispose(): Promise<void> {
      if (disposing) return disposing
      disposed = true
      disposing = (async () => {
        const target = live
        if (!target) return
        const exited = new Promise<void>((resolve) => target.worker.on('exit', () => resolve()))
        fail(target, new Error('Git status client disposed'))
        // 先取消 git 子进程并等读数任务结束,不能 terminate 线程把在途 git 留在外面。
        target.worker.postMessage({ type: 'dispose' })
        await exited
      })()
      return disposing
    }
  }
}
