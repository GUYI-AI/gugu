import { randomUUID } from 'node:crypto'
import { anySignal } from '@gugu/core/shared/anySignal'
import { join } from 'node:path'
import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import {
  externalImportChannels as channels,
  type ExternalImportBatch,
  type ExternalImportScan,
  type ExternalImportSource,
} from '../../src/session/shared/core/session-import/external-conversation-import'
import type { CursorSelection } from './cursor'
import { runCursorProcess } from './cursor-process'
import { desktopWorkerPath } from '../session/main/worker-manifest'
import { ExternalHistoryStore } from './store'

type ImportRun = {
  id: string
  selection: CursorSelection
  offset: number
  controller: AbortController
  pending?: boolean
}

type Scope = {
  owner: string
  selection?: CursorSelection
  controller: AbortController
  cursorScan?: Promise<CursorSelection>
  runs: Map<string, ImportRun>
}

const BATCH_SIZE = 10

function parseSource(source: unknown): ExternalImportSource {
  if (source === 'chatgpt' || source === 'cursor') return source
  throw new Error('Unsupported import source')
}

export function registerExternalImportIpc(input: {
  ipc: IpcMain
  getWindow: () => BrowserWindow | null
  getOwner: () => string | null
}): { ownerChanged: () => void } {
  let store: ExternalHistoryStore | undefined
  let activeScope: Scope | undefined

  const historyDirectory = () => join(app.getPath('userData'), 'external-conversation-history')
  const history = () => store ??= new ExternalHistoryStore(historyDirectory())
  const ownerChanged = () => {
    if (!activeScope || activeScope.owner === input.getOwner()) return
    activeScope.controller.abort()
    activeScope = undefined
  }

  function scope(event: IpcMainInvokeEvent): Scope | null {
    const window = input.getWindow()
    const owner = input.getOwner()
    if (!window || !owner || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) return null
    ownerChanged()
    if (!activeScope) activeScope = { owner, controller: new AbortController(), runs: new Map() }
    return activeScope
  }

  function requireScope(event: IpcMainInvokeEvent) {
    const state = scope(event)
    if (!state) throw new Error('Local import is unavailable')
    return state
  }

  input.ipc.handle(channels.scan, async (event): Promise<ExternalImportScan | null> => {
    const state = scope(event)
    if (!state) return null
    const scan = state.cursorScan ??= runCursorProcess(desktopWorkerPath('cursor-import'), { action: 'scan' }, state.controller.signal)
      .then(reply => { if (reply.action !== 'scan') throw new Error('Invalid Cursor scan response'); return reply.result })
      .finally(() => { state.cursorScan = undefined })
    const selected = await scan
    if (scope(event) !== state) return null
    state.selection = selected
    if (!selected.rows.length) return null
    return { count: selected.rows.filter(row => !history().has(state.owner, 'cursor', row.sourceId)).length, pending: false }
  })

  input.ipc.handle(channels.start, event => {
    const state = requireScope(event)
    const selection = state.selection
    if (!selection) throw new Error('No conversation source is selected')
    const id = randomUUID()
    state.runs.set(id, { id, selection, offset: 0, controller: new AbortController() })
    return { id, total: selection.rows.length + selection.failed }
  })

  input.ipc.handle(channels.next, async (event, id: string): Promise<ExternalImportBatch> => {
    const state = requireScope(event)
    const run = state.runs.get(id)
    if (!run) throw new Error('Import is unavailable')
    if (run.pending) throw new Error('Import batch is already running')
    run.pending = true
    try {
      const reply = await runCursorProcess(desktopWorkerPath('cursor-import'), {
        action: 'import', owner: state.owner, directory: historyDirectory(), selection: run.selection,
        offset: run.offset, size: BATCH_SIZE,
      }, anySignal([state.controller.signal, run.controller.signal]))
      if (reply.action !== 'import' || scope(event) !== state || !state.runs.has(id)) throw new Error('Import is unavailable')
      run.offset += BATCH_SIZE
      if (reply.result.done === reply.result.total) state.runs.delete(id)
      return reply.result
    } finally { run.pending = false }
  })

  input.ipc.handle(channels.cancel, (event, id: string) => {
    const state = scope(event)
    state?.runs.get(id)?.controller.abort()
    state?.runs.delete(id)
  })

  input.ipc.handle(channels.list, (event, source: unknown) => {
    const state = scope(event)
    return state ? history().list(state.owner, parseSource(source)) : []
  })

  input.ipc.handle(channels.read, (event, id: unknown, offset: unknown) => {
    const state = requireScope(event)
    if (typeof id !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
    return history().read(state.owner, id, offset)
  })

  app.on('will-quit', () => {
    activeScope?.controller.abort()
    store?.close()
  })
  return { ownerChanged }
}
