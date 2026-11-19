import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { rpc } from '@renderer/lib/ipc'
import { rendererLogger } from '@/lib/log'
import { replica, useReplica } from '@/lib/replica'
import { Progress } from '@/components/ui/Progress'

const log = rendererLogger('integrations/install-progress')

export type CliDownloadProgress = Awaited<ReturnType<typeof rpc.integrations.cliLoginProgress>>

const readers = new Map<string, () => Promise<CliDownloadProgress>>()
const reportedFailures = new Set<string>()

/** Someone else's progress: a read, not a command. */
const cliInstallProgress = replica({
  name: 'cliInstallProgress',
  scope: 'device',
  read: async (_owner: string, source: string): Promise<CliDownloadProgress> => {
    const read = readers.get(source)
    if (!read) throw new Error(`no install progress reader for ${source}`)
    try {
      const progress = await read()
      reportedFailures.delete(source)
      return progress
    } catch (error) {
      if (!reportedFailures.has(source)) log.warn({ error: String(error) }, 'CLI install progress could not be read')
      reportedFailures.add(source)
      throw error
    }
  },
  refreshEvery: 750,
  keep: 0,
})

/** 只看安装进度，不消费登录结果。未知总大小时保留不定进度，绝不按时间猜百分比。
 * 只有真在下载/安装（进度不为 null）才出现进度条和下载字样；已装好、云电脑预装、读不到进度、或还没读到时只给 `idle`，
 * ❌ 把「正在准备连接」说成「正在准备下载」。`source` 是这份进度从哪里读的稳定键（宿主 + 集成）。 */
export function CliInstallProgress({ source, read, idle = null }: { source: string; read: () => Promise<CliDownloadProgress>; idle?: ReactNode }) {
  const { t } = useTranslation('assistant')
  readers.set(source, read)
  const reading = useReplica(cliInstallProgress, [source])
  const progress = reading.state === 'value' && !reading.error ? reading.value : null
  if (!progress) return <>{idle}</>
  const total = progress.totalBytes
  const received = progress.receivedBytes
  const measured = progress.phase === 'download' && typeof total === 'number' && Number.isFinite(total) && total >= 1024 && Number.isFinite(received) && received >= 0
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  // Small or unavailable totals have no useful MB ratio. Keep an honest, indeterminate track.
  const usefulRatio = measured && total >= 0.1 * 1024 * 1024
  return (
    <div className="grid gap-2 text-sm leading-6 text-[var(--muted-fg)]" role="status" data-testid="cli-install-progress">
      <Progress label={t('connectors.setup.downloadProgress')} value={measured ? Math.min(received / total * 100,100) : null} />
      <span>{progress.phase === 'install' ? t('connectors.setup.installing')
        : usefulRatio ? t('connectors.setup.downloadBytes', { received: mb(received), total: mb(total) })
        : received >= 0.1 * 1024 * 1024 ? t('connectors.setup.downloadReceived', { received: mb(received) })
        : t('connectors.setup.downloading')}</span>
    </div>
  )
}
