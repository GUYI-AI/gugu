import { useAssistantReadError } from '@/session/renderer/features/assistant/assistant-read-failure'
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import type { PhoneMachineState } from './phoneMachine'
import type { Reading } from '@/lib/replica'

/** 门过了之后的页:工作区已经打开(❌ 再判 opening / error)。 */
export type OpenedPageProps = Omit<PhonePageProps, 'machine'> & { machine: AssistantMachine }

/** 云端读取的加载和失败状态；读不到时保留明确的原因。 */
export function PhoneMachineView({
  machine,
  name,
  children,
}: {
  machine: PhoneMachineState
  name: string
  children: (machine: AssistantMachine) => ReactNode
}) {
  const { t } = useTranslation('assistant')
  const inner = (() => {
    if (machine.state === 'error') return <ReadFailed title={t('machine.openFailed', { name })} error={machine.error} onRetry={machine.retry} />
    if (machine.state === 'opening') return <ReadingNow />
    return children(machine.machine)
  })()
  return inner
}

/** 读的时候:只一个「在等」(全产品同一个样子)。 */
export function ReadingNow({ label }: { label?: string }) {
  const { t } = useTranslation('assistant')
  return (
    <AssistantEmpty>
      <span className="inline-flex items-center gap-2" role="status">
        <LoadingIndicator size="inline" />
        {label ?? t('library.loading')}
      </span>
    </AssistantEmpty>
  )
}

/** 读失败:标题说是哪一步没读到,下面一句原因,一个「重试」。 */
export function ReadFailed({ title, error, onRetry: _onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('assistant')
  return <AssistantEmpty title={title}><span role={(error as { code?: string })?.code === 'unprepared' ? 'status' : 'alert'}>{assistantPanelFailure(error,t)}</span></AssistantEmpty>
}

/** 一次读的三种结果:在读 / 读失败(说哪一步)/ 读到了交给 children(重读没成:列着上一次的,上面一句说这一次没读到)。 */
export function ReadView<T>({ reading, failedTitle, children }: { reading: Reading<T>; failedTitle: string; children: (data: T) => ReactNode }) {
  const { t } = useTranslation('assistant')
  const error = useAssistantReadError(reading.state === 'unknown',reading.state === 'error' ? reading.error : null)
  if (error) return <AssistantEmpty title={failedTitle}><span role={(error as { code?: string })?.code === 'unprepared' ? 'status' : 'alert'}>{assistantPanelFailure(error,t)}</span></AssistantEmpty>
  if (reading.state !== 'value') return <ReadingNow />
  // ❌ 只留旧的、不说。
  if (reading.error) return <>
    <p role={(reading.error as { code?: string })?.code === 'unprepared' ? 'status' : 'alert'} className="ta-page-sub text-foreground-error" data-testid="assistant-read-refresh-failed">{assistantPanelFailure(reading.error,t)}</p>
    {children(reading.value)}
  </>
  return <>{children(reading.value)}</>
}
