import { randomUUID } from 'node:crypto'
import { anySignal } from '@gugu/core/shared/anySignal'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import {
  externalImportChannels as channels,
  type ExternalConversation,
  type ExternalImportBatch,
  type ExternalImportScan,
  type ExternalImportSource,
} from '../../src/session/shared/core/session-import/external-conversation-import'
import { readChatGptConversation, readChatGptExport } from './chatgpt'
import type { CursorSelection } from './cursor'
import { runCursorProcess } from './cursor-process'
import { desktopWorkerPath } from '../session/main/worker-manifest'
import { ExternalHistoryStore } from './store'

type Selection = {
  rows: ExternalConversation[]
  failed: number
}

type ImportRun = {
  id: string
  source: ExternalImportSource
  selection: Selection | CursorSelection
  offset: number
  controller: AbortController
  pending?: boolean
}

type Scope = {
  owner: string
  selections: { chatgpt?: Selection; cursor?: CursorSelection }
  pending: boolean
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

  function scope(event: IpcMainInvokeEvent): { window: BrowserWindow; scope: Scope } | null {
    const window = input.getWindow()
    const owner = input.getOwner()
    if (!window || !owner || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) return null
    ownerChanged()
    if (!activeScope) activeScope = { owner, selections: {}, pending: false, controller: new AbortController(), runs: new Map() }
    return { window, scope: activeScope }
  }

  function requireScope(event: IpcMainInvokeEvent) {
    const state = scope(event)
    if (!state) throw new Error('Local import is unavailable')
    return state
  }

  input.ipc.handle(channels.scan, async (event, source: unknown): Promise<ExternalImportScan | null> => {
    const entry = scope(event)
    if (!entry) return null
    const state = entry.scope
    const kind = parseSource(source)
    if (kind === 'cursor') {
      const scan = state.cursorScan ??= runCursorProcess(desktopWorkerPath('cursor-import'), { action: 'scan' }, state.controller.signal)
        .then(reply => { if (reply.action !== 'scan') throw new Error('Invalid Cursor scan response'); return reply.result })
        .finally(() => { state.cursorScan = undefined })
      const selected = await scan
      if (scope(event)?.scope !== state) return null
      state.selections.cursor = selected
      if (!selected.rows.length) return null
    }
    const selected = state.selections[kind]
    const count = selected?.rows.filter(row => !history().has(state.owner, kind, row.sourceId)).length ?? 0
    return { count, pending: kind === 'chatgpt' && state.pending, ...(kind === 'chatgpt' && count === 0 && { needsSource: true }) }
  })

  input.ipc.handle(channels.pick, async event => {
    const { window, scope: state } = requireScope(event)
    if (state.pending) return { status: 'cancelled' } as const
    state.pending = true
    try {
      const picked = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (picked.canceled || scope(event)?.scope !== state) return { status: 'cancelled' } as const
      const rows = new Map<string, ExternalConversation>()
      let failed = 0
      let readableFiles = 0
      for (const path of picked.filePaths) {
        if (scope(event)?.scope !== state) return { status: 'cancelled' } as const
        let exported: unknown[]
        try {
          exported = await readChatGptExport(path)
          readableFiles++
        } catch {
          failed++
          continue
        }
        for (const entry of exported) {
          const row = readChatGptConversation(entry)
          if (row) {
            if (!rows.has(row.sourceId)) rows.set(row.sourceId, row)
          } else {
            failed++
          }
        }
      }
      if (scope(event)?.scope !== state) return { status: 'cancelled' } as const
      if (!readableFiles || (failed && !rows.size)) return { status: 'invalid' } as const
      state.selections.chatgpt = { rows: [...rows.values()], failed }
      return { status: 'selected' } as const
    } finally {
      state.pending = false
    }
  })

  input.ipc.handle(channels.start, (event, source: unknown) => {
    const { scope: state } = requireScope(event)
    const kind = parseSource(source)
    const selection = state.selections[kind]
    if (!selection) throw new Error('No conversation source is selected')
    const id = randomUUID()
    state.runs.set(id, { id, source: kind, selection, offset: 0, controller: new AbortController() })
    return { id, total: selection.rows.length + selection.failed }
  })

  input.ipc.handle(channels.next, async (event, id: string): Promise<ExternalImportBatch> => {
    const { scope: state } = requireScope(event)
    const run = state.runs.get(id)
    if (!run) throw new Error('Import is unavailable')
    const { selection, source } = run
    if (source === 'cursor') {
      if (run.pending) throw new Error('Import batch is already running')
      run.pending = true
      try {
        const reply = await runCursorProcess(desktopWorkerPath('cursor-import'), {
          action: 'import', owner: state.owner, directory: historyDirectory(), selection,
          offset: run.offset, size: BATCH_SIZE,
        }, anySignal([state.controller.signal, run.controller.signal]))
        if (reply.action !== 'import' || scope(event)?.scope !== state || !state.runs.has(id)) throw new Error('Import is unavailable')
        run.offset += BATCH_SIZE
        if (reply.result.done === reply.result.total) state.runs.delete(id)
        return reply.result
      } finally { run.pending = false }
    }
    const result: ExternalImportBatch = {
      imported: [],
      alreadyImported: 0,
      failed: run.offset === 0 ? selection.failed : 0,
      done: Math.min(run.offset + BATCH_SIZE, selection.rows.length) + selection.failed,
      total: selection.rows.length + selection.failed,
    }
    for (const row of selection.rows.slice(run.offset, run.offset + BATCH_SIZE)) {
      try {
        const added = history().import(state.owner, source, row as ExternalConversation)
        if (added) result.imported.push(added)
        else result.alreadyImported++
      } catch {
        result.failed++
      }
    }
    run.offset += BATCH_SIZE
    if (result.done === result.total) state.runs.delete(run.id)
    return result
  })

  input.ipc.handle(channels.cancel, (event, id: string) => {
    const state = scope(event)?.scope
    state?.runs.get(id)?.controller.abort()
    state?.runs.delete(id)
  })

  input.ipc.handle(channels.list, (event, source: unknown) => {
    const state = scope(event)
    return state ? history().list(state.scope.owner, parseSource(source)) : []
  })

  input.ipc.handle(channels.read, (event, id: unknown, offset: unknown) => {
    const { scope: state } = requireScope(event)
    if (typeof id !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
    return history().read(state.owner, id, offset)
  })

  app.on('will-quit', () => {
    activeScope?.controller.abort()
    store?.close()
  })
  return { ownerChanged }
}
