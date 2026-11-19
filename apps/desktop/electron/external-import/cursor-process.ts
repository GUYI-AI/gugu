import { fork } from '@gugu/core/local/childProcess'
import type { ExternalImportBatch } from '../../src/session/shared/core/session-import/external-conversation-import'
import type { CursorSelection } from './cursor'

export type CursorRequest = { action: 'scan' } | {
  action: 'import'
  owner: string
  directory: string
  selection: CursorSelection
  offset: number
  size: number
}
export type CursorResponse = { action: 'scan'; result: CursorSelection } | { action: 'import'; result: ExternalImportBatch }
type Reply = CursorResponse | { error: string }

/** One operation per child: native SQLite and conversation bodies never enter the UI process. */
export function runCursorProcess(entry: string, request: CursorRequest, signal: AbortSignal): Promise<CursorResponse> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    })
    let reply: Reply | undefined
    let failure: unknown
    // Drain stderr without copying source paths or message contents into the parent.
    child.stderr?.resume()
    child.stderr?.on('error', error => { failure = error })
    const abort = () => { failure = signal.reason ?? new Error('Cursor import cancelled'); child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => { failure = error })
    child.on('message', message => { reply = message as Reply })
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || !reply) reject(new Error(`Cursor import process exited (${exitSignal ?? code})`))
      else if ('error' in reply) reject(new Error(reply.error))
      else if (reply.action !== request.action) reject(new Error('Invalid Cursor import response'))
      else resolve(reply)
    })
    try { child.send(request, error => { if (error) { failure = error; child.kill('SIGKILL') } }) }
    catch (error) { failure = error; child.kill('SIGKILL') }
    if (signal.aborted) abort()
  })
}
