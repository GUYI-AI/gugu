import { rpcOn } from '@renderer/lib/ipc'
import type { CodexTaskScan } from '@shared/core/session-import/codex-tasks'
import {
  ENVIRONMENT_IMPORT_CATEGORIES,
  type EnvironmentImportCategory, type EnvironmentImportScan, type EnvironmentImportSelection,
} from '@shared/core/session-import/environment-import'
import type { ImportProvider, ImportResult, ImportPreparation } from './import-providers'
import { i18n } from '@/i18n/runtime'
import { importError } from '@shared/core/session-import/import-error-code'

const emptyResult = (): ImportResult => ({ imported: [], entities: [], details: [], existing: 0, failed: 0 })

function categoryProvider(category: Exclude<EnvironmentImportCategory, 'tasks'>): ImportProvider {
  let preview: EnvironmentImportScan | undefined
  const provider: ImportProvider = {
    id: `codex:${category}`, label: 'ChatGPT', iconId: 'codex', sourceId: 'codex', sourceLabel: 'ChatGPT', category,
    localOnly: true, supportsAutomaticSync: true,
    async scan(deviceId) {
      if (deviceId) return null
      preview = await rpcOn(null).sessionImport.scanEnvironmentImport(category)
      return { count: preview.count, pending: false }
    },
    capture(seen) {
      // Freeze the preview when queued, rather than importing a later scan.
      const snapshot = preview && (!seen ? preview : { ...preview, items: preview.items.filter(item => !Object.hasOwn(seen, item.localSourceId)) })
      return { ...provider, importAll: (deviceId, progress, signal) => run(snapshot, deviceId, progress, signal) }
    },
    importAll: (deviceId, progress, signal) => run(preview, deviceId, progress, signal),
  }
  async function run(snapshot: EnvironmentImportScan | undefined, deviceId: string | null,
    onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<ImportResult> {
    if (deviceId || !snapshot) throw new Error(i18n.t('settings.dataImport.refreshFirst', { ns: 'main' }))
    signal.throwIfAborted()
    const result = emptyResult()
    const selection: EnvironmentImportSelection[] = snapshot.items.flatMap(item =>
      item.fingerprint && item.status === 'ready' ? [{ localSourceId: item.localSourceId, fingerprint: item.fingerprint }] : [])
    result.existing = snapshot.items.filter(item => item.status === 'existing').length
    result.failed = snapshot.items.filter(item => item.status !== 'ready' && item.status !== 'existing').length
    result.details = snapshot.items.filter(item => item.status !== 'ready').map(item => ({ id: item.localSourceId, title: item.name, category, status: item.status === 'existing' ? 'existing' : item.status === 'conflict' ? 'conflict' : 'skipped', reason: item.reason }))
    onProgress(0, selection.length)
    if (!selection.length) return result
    result.attempts = Object.fromEntries(selection.map(item => [item.localSourceId, item.fingerprint]))
    const requestId = crypto.randomUUID()
    const api = rpcOn(null).sessionImport
    const cancel = () => { void api.cancelEnvironmentImport(requestId).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const read = await api.importEnvironmentCategory({ requestId, category, selection })
      for (const item of read.items) {
        result.details!.push({ id: item.localSourceId, title: item.name, category, status: item.status === 'ready' ? 'failed' : item.status, reason: item.reason })
        if (item.status === 'imported') result.entities!.push({ id: item.localSourceId, title: item.name, category })
        else if (item.status === 'existing') result.existing++
        else result.failed++
      }
      onProgress(selection.length, selection.length)
      return result
    } finally { signal.removeEventListener('abort', cancel) }
  }
  return provider
}

export const codexEnvironmentProviders = ENVIRONMENT_IMPORT_CATEGORIES
  .filter((kind): kind is Exclude<EnvironmentImportCategory, 'tasks'> => kind !== 'tasks').map(categoryProvider)

/** Local Codex uses the complete-lineage task importer; remote hosts retain their existing path. */
export function withCodexTaskImport(transcripts: ImportProvider): ImportProvider {
  let preview: CodexTaskScan | undefined
  const provider: ImportProvider = {
    ...transcripts, sourceId: 'codex', sourceLabel: 'ChatGPT', category: 'tasks',
    async scan(deviceId) {
      if (deviceId) return transcripts.scan(deviceId)
      preview = await rpcOn(null).sessionImport.scanCodexTasks()
      if (preview.status !== 'ready' && preview.reason !== 'missing-index') {
        throw importError('codex-import-index-unreadable')
      }
      return { count: preview.rows.length, pending: false }
    },
    capture(seen) {
      const snapshot = preview && (!seen ? preview : { ...preview, rows: preview.rows.filter(item => !Object.hasOwn(seen, item.id)), blocked: [] })
      return { ...provider, importAll: (deviceId, progress, signal) => run(snapshot, deviceId, progress, signal) }
    },
    importAll: (deviceId, progress, signal) => run(preview, deviceId, progress, signal),
  }
  async function run(snapshot: CodexTaskScan | undefined, deviceId: string | null,
    onProgress: (done: number, total: number, preparation?: ImportPreparation | null) => void, signal: AbortSignal): Promise<ImportResult> {
    if (deviceId) return transcripts.importAll(deviceId, onProgress, signal)
    if (!snapshot) throw new Error(i18n.t('settings.dataImport.refreshFirst', { ns: 'main' }))
    signal.throwIfAborted()
    const api = rpcOn(null).sessionImport
    const result = emptyResult()
    const cancel = () => { void api.cancelCodexTaskImport().catch(() => {}) }
    result.attempts = Object.fromEntries(snapshot.rows.map(row => [row.id, row.revision]))
    result.details = snapshot.blocked.map(item => ({ id: item.id, title: item.id, category: 'tasks', status: 'skipped', reason: item.reason }))
    const titles = new Map(snapshot.rows.map(row => [row.id, row.title]))
    onProgress(0, snapshot.rows.length)
    signal.addEventListener('abort', cancel, { once: true })
    let readingProgress = false
    let finished = false
    const readProgress = async () => {
      if (readingProgress || signal.aborted) return
      readingProgress = true
      try {
        const preparation = await api.codexTaskImportProgress()
        if (!finished && !signal.aborted) onProgress(0, snapshot.rows.length, preparation)
      } catch { /* The import request owns its failure; a progress read cannot cancel it. */ }
      finally { readingProgress = false }
    }
    const timer = setInterval(() => { void readProgress() }, 1000)
    try {
      signal.throwIfAborted()
      const read = await api.importCodexTasks(snapshot.rows.map(({ id, revision }) => ({ id, revision })))
      for (const item of read.items) {
        if (item.status === 'imported') result.imported.push({ title: titles.get(item.id) ?? item.id,
          projectId: item.projectId, sessionId: item.sessionId })
        else if (item.status === 'existing') result.existing++
        else {
          result.failed++
          result.details!.push({ id: item.id, title: titles.get(item.id) ?? item.id, category: 'tasks', status: 'failed',
            reason: item.status === 'changed' ? 'source-changed' : item.status === 'missing' ? 'source-missing' : 'message' in item ? item.message : undefined })
        }
      }
      result.failed += snapshot.blocked.length
      onProgress(snapshot.rows.length, snapshot.rows.length)
      return result
    } finally { finished = true; clearInterval(timer); signal.removeEventListener('abort', cancel) }
  }
  return provider
}
