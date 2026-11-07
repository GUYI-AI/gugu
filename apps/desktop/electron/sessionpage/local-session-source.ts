import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLocalSessionIndex, engineIdForAgentType, readLocalTranscript, TRANSCRIPT_SOURCE_IDS } from '@gugu/core'
import type { LocalSessionIndex, TranscriptScanOptions, TranscriptSource } from '@gugu/core'
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers'
import { requireNativeHome } from '@gugu/session-plugins/agents'
import type { AppSessionRead, AppSessionReadOptions } from '../../src/session/shared/extensions/app-sessions'
import { sessionPageNumber } from '../../src/session/shared/extensions/app-sessions'
import { readBoundedLocalSessionPreview } from './local-session-preview'
import { createReverseIndexScheduler } from '@gugu/session-core/session-record/window-cache/reverse-index-runner'
import type { PendingLongRecord } from '@gugu/session-core/session-record/window-cache/types'
import { log } from '../lib/logger'

// @@@sessionpage 导入本机会话 (spec session-page-import)：宿主侧的实现，注入给会话页。
//
// 为什么在宿主这边：本机 transcript 的解析（Claude 的旁支会话、伪装成 user 的机器注入记录、
// Codex 的注入前缀…）。会话页独立复用这一份 parser/index 口径；社交创建面不再提供 transcript picker。
//
// 索引是增量的：面板第一帧用缓存（毫秒级），随后每一轮对账磁盘并解析一批新会话。
// 一台常用开发机上实测 1.4 万条会话——一次性全扫要 40 秒以上，那样面板会一直卡在加载态。

// 引擎清单不在这里第二次写死：core 的 `TranscriptSource` 是「咕咕已接通读回」的唯一真值表
// （见 packages/core/src/shared/types/transcripts.ts），这里跟着它走。
type LocalSessionEngine = TranscriptSource

type ListParams = {
  cwd?: string
  filePath?: string
  offset?: number
  engine?: LocalSessionEngine
  query?: string
  limit?: number
  mode?: 'cached' | 'fresh'
  hydrateBudgetMs?: number
}

/** 与会话页后端侧 `LocalSessionSource` 结构一致；类型在模块边界上按结构对接，不跨包 import。 */
export type HostLocalSessionSource = {
  read(params: AppSessionReadOptions): Promise<AppSessionRead>
  list(params: ListParams): Promise<{
    rows: Array<{
      engine: LocalSessionEngine
      providerSessionId: string
      title: string
      cwd: string | null
      filePath: string
      updatedAt: number
      sizeBytes: number
    }>
    matched: number
    discovered: number
    indexed: number
    pending: number
    countsByEngine: Record<LocalSessionEngine, number>
    stale: boolean
  }>
  preview(params: { filePath: string; engine: LocalSessionEngine }): Promise<{
    providerSessionId: string
    title: string
    cwd: string | null
    turnCount: number | null
    pendingLongRecords?: PendingLongRecord[]
    head: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string | null }>
    tail: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string | null }>
  }>
  dispose(): Promise<void>
}

/** 插件 `nativeHome` 的候选,递给看不见插件的 core 扫描层;清单与读取围栏用同一组根。 */
export function transcriptScanOptions(
  env: Record<string, string | undefined> = process.env,
  osHomeDir: string = homedir(),
): TranscriptScanOptions {
  const nativeHomes = {} as Record<TranscriptSource, readonly string[]>
  for (const source of TRANSCRIPT_SOURCE_IDS) {
    const providerId = engineIdForAgentType(source)
    if (!providerId) throw new Error(`transcript source '${source}' has no engine id`)
    nativeHomes[source] = nativeHomeRoots(requireNativeHome(providerId), env, osHomeDir)
  }
  return { nativeHomes }
}

export function createHostLocalSessionSource(userDataPath: string, scanOptions: TranscriptScanOptions = transcriptScanOptions()): HostLocalSessionSource {
  let index: LocalSessionIndex | null = null
  let disposed = false
  let disposePromise: Promise<void> | null = null
  const controller = new AbortController()
  const active = new Set<Promise<unknown>>()
  let locatingFailure: unknown = null
  const locating = createReverseIndexScheduler({ onFailure(error) {
    locatingFailure = error
    log.warn('Local session record locating failed', { error: String(error) })
  } })

  const getIndex = (): LocalSessionIndex => {
    if (disposed) throw new Error('Local session source is shutting down')
    index ??= createLocalSessionIndex({
      ...scanOptions,
      cacheFilePath: join(userDataPath, 'taskpage-local-session-index.json'),
      signal: controller.signal,
    })
    return index
  }

  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Local session source is shutting down'))
    const pending = operation()
    active.add(pending)
    pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }

  return {
    list(params) {
      return run(async () => {
        const query = {
          cwd: params.cwd,
          filePath: params.filePath,
          offset: params.offset,
          source: params.engine,
          query: params.query,
          limit: params.limit,
          hydrateBudgetMs: params.hydrateBudgetMs,
        }
        const page =
          params.mode === 'cached'
            ? await getIndex().readCachedPage(query)
            : await getIndex().readPage(query)
        return {
          rows: page.rows.map((row) => ({
            engine: row.source,
            providerSessionId: row.providerSessionId,
            title: row.title,
            cwd: row.cwd,
            filePath: row.filePath,
            updatedAt: row.updatedAt,
            sizeBytes: row.sizeBytes
          })),
          matched: page.matched,
          discovered: page.discovered,
          indexed: page.indexed,
          pending: page.pending,
          countsByEngine: page.countsBySource,
          stale: page.stale
        }
      })
    },

    read(params) {
      return run(async () => {
        const indexed = await getIndex().readCachedPage({ source: params.source, filePath: params.filePath, limit: 1 })
        if (indexed.rows.length !== 1) throw Object.assign(new Error('Read a filePath returned by sessions.index first'), { code: 'not-found' })
        const options = { ...scanOptions, signal: controller.signal }
        if (params.view === 'context') return readLocalTranscript(params.filePath, params.source, { ...options, view: 'context' })
        const transcript = await readLocalTranscript(params.filePath, params.source, options)
        const offset = sessionPageNumber(params.offset, 'offset', 0)
        const limit = sessionPageNumber(params.limit, 'limit', 50)
        const turns = transcript.turns.slice(offset, offset + limit)
        const next = offset + turns.length
        return { ...transcript, turns, total: transcript.turns.length, nextOffset: next < transcript.turns.length ? next : null }
      })
    },

    preview(params) {
      return run(async () => {
        await locating.pause()
        if (locatingFailure) { const failure = locatingFailure; locatingFailure = null; throw failure }
        return readBoundedLocalSessionPreview(userDataPath, params, { ...scanOptions, signal: controller.signal },
          (path, checkpoint, directory, scope) => locating.schedule(path, checkpoint, directory, scope))
      })
    },

    dispose() {
      return (disposePromise ??= (async () => {
        disposed = true
        controller.abort()
        await locating.dispose()
        await Promise.allSettled(Array.from(active))
        await index?.flush()
      })())
    }
  }
}
