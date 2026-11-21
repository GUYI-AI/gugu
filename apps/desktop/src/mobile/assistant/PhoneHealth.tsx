import { AssistantMemoryContent } from '@/components/assistant/AssistantMemoryContent'
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ArrowUpToLine, FileText, Heart, RefreshCw, Sparkles } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { HEALTH_REPORT_ACCEPT, HealthBody, isHealthNote } from '@/session/renderer/features/assistant/assistant-health'
import { memoryContentPreview } from '@/session/renderer/features/assistant/memory-content-preview'
import type { MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantRow, AssistantSection, PageHead, Tile } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { openPhonePermissions } from '../phone-device/phonePermissionsNavigation'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineView, ReadFailed, ReadingNow, ReadView } from './PhoneMachineView'
import { healthClock, type PhoneHealthView } from './phoneHealthView'
import { phoneHealth } from './phoneHealthReplica'
import type { Reading } from '@/lib/replica'
import { ReadingSlot } from '@/components/ui/ReadingSlot'
import { useReplica } from '@/lib/replica'
import './phone-memory.css'


/**
 * 「健康」(记忆首页那张卡点进来,同桌面):数据就在这台手机上,此刻经原生读 Health Connect,
 * ❌ 经云端问自己,也 ❌ 被「它在休息」挡住。读不到分几种如实说并给下一步(去授权 / 重试);
 * 下面「你的健康分析」(让它解读,只填不发;它记进记忆的 health_* 几条,醒着读到了才列)、「分析健康报告」(选文件排进聊天)。
 */
export function PhoneHealth({ assistant, askInChat, go, healthNotes, machine }: PhonePageProps & {
  healthNotes: Reading<{ notes: MemoryEntry[] }>
}) {
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  const health = useReplica(phoneHealth, [])
  const reload = () => { void phoneHealth.refresh() }
  const view = health.state === 'value' ? health.value : null
  return (
    <div className="ta-page ta-phone-health" data-testid="assistant-health" data-state={health.state === 'value' ? health.value.state : health.state === 'unknown' ? 'loading' : 'error'}>
      <PageHead
        title={t('health.title')}
        sub={view?.state === 'ok' ? t('health.from', { device: t('health.phone.thisPhone'), time: healthClock(view.summary.generated_at) }) : undefined}
        action={
          <IconButton
            size="lg"
            aria-label={t('health.refresh')}
            disabled={health.state === 'unknown'}
            onClick={reload}
            data-testid="assistant-health-refresh"
          >
            {health.state === 'unknown' ? <LoadingIndicator size="inline" /> : <RefreshCw />}
          </IconButton>
        }
      />
      <ReadingSlot reading={health} placeholder={<ReadingNow label={t('health.loading')} />}
        failed={(error) => <div className="ta-card"><ReadFailed title={t('health.state.errorTitle')} error={error} onRetry={reload} /></div>}>
        {(value) => value.state === 'ok' ? <HealthBody summary={value.summary} t={t} />
          : <ConnectCard view={value} onGrant={openPhonePermissions} onRetry={reload} />}
      </ReadingSlot>
      <AssistantSection
        title={t('health.analysisTitle')}
        action={
          <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('health.analyzePrompt'))} data-testid="assistant-health-analyze">
            <Sparkles />
            {t('health.analyze', { name })}
          </Button>
        }
        testId="assistant-health-analysis"
      >
        <PhoneMachineView machine={machine} name={name}>
          {() => (
            <ReadView reading={healthNotes} failedTitle={t('memory.loadFailed')}>
              {({ notes }) => {
                const analysis = notes.filter((note) => isHealthNote(note.file))
                return analysis.length === 0 ? (
                  <p className="ta-card-text ta-page-sub">{t('health.analysisEmpty', { name })}</p>
                ) : analysis.map((entry) => (
                  <AssistantMemoryContent key={entry.file} machine={machine.state === 'ready' ? machine.machine : undefined} entry={entry}>{(note,error) => (
                  <AssistantRow
                    key={note.file}
                    leading={<FileText />}
                    title={note.title}
                    detail={error ? assistantPanelFailure(error,t) : memoryContentPreview(note.body, 140)}
                    detailLines={4}
                    onClick={() => go(`note:${note.file}`)}
                    testId={`assistant-health-note-${note.file}`}
                  />)}</AssistantMemoryContent>
                ))
              }}
            </ReadView>
          )}
        </PhoneMachineView>
      </AssistantSection>
      <ReportUpload askInChat={askInChat} />
    </div>
  )
}

/** 读不到:「让健康状况一目了然」那张卡,下面一句说清是哪一种、去哪弄好。 */
function ConnectCard({ view, onGrant, onRetry }: { view: Exclude<PhoneHealthView, { state: 'ok' }>; onGrant: () => void; onRetry: () => void }) {
  const { t } = useTranslation('assistant')
  const line = (() => {
    switch (view.state) {
      case 'not-android':
        return t('health.phone.notAndroid')
      case 'old-app':
        return t('health.phone.oldApp')
      case 'unsupported':
        return t('health.phone.unsupported')
      case 'not-granted':
        return t('health.phone.notGranted')
      case 'os-permission':
        return t('health.phone.osPermission')
      case 'failed':
        return t('health.state.failed', { message: view.message })
    }
  })()
  const canGrant = view.state === 'not-granted' || view.state === 'os-permission'
  return (
    <div className="ta-card ta-health-connect" data-testid={`assistant-health-${view.state}`}>
      <span className="ta-tile-icon">
        <Heart />
      </span>
      <h2 className="ta-card-title">{t('health.emptyStateTitle')}</h2>
      <p className="ta-page-sub">{t('health.emptyStateSubtitle')}</p>
      <div className="ta-card-divider" />
      <p className="ta-health-line">{line}</p>
      {canGrant ? (
        <Button variant="ghost" className="ta-pill-btn" onClick={onGrant} data-testid="assistant-health-grant">
          {t('health.phone.grant')}
        </Button>
      ) : view.state === 'failed' ? (
        <Button variant="ghost" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-health-retry">
          {t('health.retry')}
        </Button>
      ) : null}
    </div>
  )
}

/** 分析健康报告:选一份 PDF / 图片,连同那句话排进和它的聊天(只填不发,人看过再发)。 */
function ReportUpload({ askInChat }: { askInChat: PhonePageProps['askInChat'] }) {
  const { t } = useTranslation('assistant')
  const input = useRef<HTMLInputElement>(null)
  return (
    <AssistantSection title={t('health.addData')} bare testId="assistant-health-add">
      <div className="ta-grid">
        <Tile icon={<ArrowUpToLine />} title={t('health.analyzeReport')} sub={t('health.analyzeReportDescription')} onClick={() => input.current?.click()} testId="assistant-health-report" />
      </div>
      <input
        ref={input}
        type="file"
        accept={HEALTH_REPORT_ACCEPT}
        className="hidden"
        data-testid="assistant-health-report-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) askInChat(t('health.healthReportMessage'), files)
        }}
      />
    </AssistantSection>
  )
}
