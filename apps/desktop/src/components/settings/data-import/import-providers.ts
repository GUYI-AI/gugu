import { rpcOn } from '@renderer/lib/ipc'
import { resolveImportSource, LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source'
import {
  LOCAL_SESSION_ENGINE_LABEL,
  LOCAL_SESSION_ENGINE_PROVIDER,
  type LocalSessionEngine,
} from '@shared/core/session-import/session-import'

export type ImportedSession = { title: string; projectId: string | null; sessionId: string }
export type ImportResult = { imported: ImportedSession[]; existing: number; failed: number }

export type ImportProvider = {
  id: string
  label: string
  iconId: string
  supportsAutomaticSync?: boolean
  scan(deviceId: string | null): Promise<{ count: number; pending: boolean; needsSource?: boolean } | null>
  pickSource?(deviceId: string | null): Promise<void>
  openImportedSession?(session: ImportedSession, deviceId: string | null): Promise<void>
  listHistory?(deviceId: string | null): Promise<Array<ImportedSession & { importedAt: number }>>
  importAll(
    deviceId: string | null,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<ImportResult>
}

// Counts come from a single scan per device, even when both source cards ask together.
const scans = new Map<string | null, ReturnType<typeof readTranscriptCounts>>()

function readTranscriptCounts(deviceId: string | null) {
  return rpcOn(deviceId).sessionHistory.list({ status: 'not-imported', limit: 0 })
}

function scanTranscripts(deviceId: string | null) {
  const previous = scans.get(deviceId)
  if (previous) return previous
  const scan = readTranscriptCounts(deviceId).finally(() => { scans.delete(deviceId) })
  scans.set(deviceId, scan)
  return scan
}

function transcriptProvider(engine: LocalSessionEngine): ImportProvider {
  const query = { source: engine, status: 'not-imported' } as const
  return {
    id: engine,
    label: LOCAL_SESSION_ENGINE_LABEL[engine],
    iconId: LOCAL_SESSION_ENGINE_PROVIDER[engine],
    supportsAutomaticSync: true,
    async scan(deviceId) {
      const page = await scanTranscripts(deviceId)
      return page.local ? { count: page.countsBySource[engine], pending: page.local.pending > 0 } : null
    },
    async importAll(deviceId, onProgress, signal) {
      const result: ImportResult = { imported: [], existing: 0, failed: 0 }
      const history = rpcOn(deviceId).sessionHistory
      // Read one stable snapshot before inserting anything. Paginating only after
      // each insertion would skip entries as they drop out of the source list.
      const page = await history.list({ ...query, mode: 'cached', limit: Number.MAX_SAFE_INTEGER })
      const rows = page.rows.flatMap(({ local }) => local?.engine === engine ? [local] : [])
      const source = resolveImportSource(deviceId ?? LOCAL_IMPORT_DEVICE)
      onProgress(0, rows.length)
      for (const [index, row] of rows.entries()) {
        if (signal.aborted) break
        try {
          const imported = await source.importSession({
            engine,
            providerSessionId: row.providerSessionId,
            filePath: row.filePath,
            title: row.title,
            cwd: row.cwd,
            sessionView: source.sessionView,
          })
          if (imported.alreadyImported) result.existing++
          else result.imported.push({ title: row.title, projectId: imported.projectId, sessionId: imported.sessionId })
        } catch {
          result.failed++
        }
        onProgress(index + 1, rows.length)
      }
      return result
    },
  }
}

export const importProviders = (Object.keys(LOCAL_SESSION_ENGINE_LABEL) as LocalSessionEngine[]).map(transcriptProvider)

const extraProviders = new Map<string, ImportProvider>()

export function locateImportProvider(id: string): ImportProvider | undefined {
  return extraProviders.get(id) ?? importProviders.find((provider) => provider.id === id)
}

export function registerExtraImportProviders(providers: readonly ImportProvider[]): () => void {
  providers.forEach((provider) => extraProviders.set(provider.id, provider))
  return () => providers.forEach((provider) => {
    if (extraProviders.get(provider.id) === provider) extraProviders.delete(provider.id)
  })
}
