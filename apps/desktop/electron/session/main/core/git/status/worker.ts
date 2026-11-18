import { parentPort } from 'node:worker_threads'
import { createBoundExec } from '@gugu/session-core/exec'
import { readGitStatus } from '@gugu/session-core/git/status-reader'
import type { GitStatusWorkerRequest } from '@gugu/session-core/git/status-worker'

const port = parentPort
if (!port) throw new Error('git-status: must run inside a worker thread')
const active = new Map<number, { abort: AbortController; done: Promise<void> }>()
let closing = false
port.on('message', (request: GitStatusWorkerRequest) => {
  if (request.type === 'dispose') {
    closing = true
    const jobs = [...active.values()]
    for (const job of jobs) job.abort.abort()
    void Promise.allSettled(jobs.map((job) => job.done)).then(() => port.close())
    return
  }
  if (closing) {
    port.postMessage({ id: request.id, error: 'Git status worker disposed' })
    return
  }
  const abort = new AbortController()
  const exec = createBoundExec({ file: request.file, cwd: request.worktree, env: request.env })
  const done = readGitStatus(request.worktree, exec, abort.signal)
    .then(
      (result) => port.postMessage({ id: request.id, result }),
      (error: unknown) => port.postMessage({ id: request.id, error: String(error) })
    )
    .finally(() => {
      active.delete(request.id)
    })
  active.set(request.id, { abort, done })
})
