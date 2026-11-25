import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cloudComputerFailureKind, cloudComputerSnapshotFailureKind, type CloudComputerFailureKind, type CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { Check, Circle, X } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { cn } from '../../lib/cn'
import { rendererLogger } from '../../lib/log'
import {
  destroyCloudComputer,
  provisionCloudComputer,
  wakeCloudComputer,
} from '../../lib/cloudComputer'
import { cloudComputerProvisionSteps, type CloudComputerStepStatus } from '../../lib/cloudComputer'
import { InlineAction } from './addServer/InlineAction'
import { calloutClassName } from './addServer/callout'
import { billingLinksAvailable } from '../../lib/appLinks'

// #7199 个人助理的家(实现上叫云电脑,一人一台)的开通、状态、关闭:只用在「助理」App 里(开通引导、齿轮)。
// owner 10-15「云电脑对用户完全不可见」:设置 → 设备不再列它,这里的话说的一律是它本人 ——
//  · 还没有:「开通个人助理」;免费档点了就地说「个人助理是 Plus 及以上的权益」;
//  · 正在准备:就地一块进度(❌ 叠弹窗),三步按看得到的事实打勾;失败当场说原因;
//  · 开好之后:只说真实读数 —— 在线 / 连不上(带原因与重试);收回着、正在起来 ❌ 说(owner 10-17:Agent 没有休息这回事,
//    那是后台资源的事);关闭要再确认、写清一起删掉什么。

const log = rendererLogger('cloud-computer')
const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'

/** 给人看的只有那几类原因(common 词条 `cloudComputer.reason.*`);管家原话、异常原文进日志。 */
export type CloudComputerActionFailure = { kind: CloudComputerFailureKind }
type ActionFailure = CloudComputerActionFailure

function failureOf(error: unknown, action: string): ActionFailure {
  log.warn({ err: String((error as Error)?.message ?? error), action }, 'cloud computer action failed')
  return { kind: cloudComputerFailureKind(error) }
}

/** 没成的原因 → 一句话 + 句尾动作。免费档 / 积分用完各有自己的去处,别的是「没开成：」「没能唤醒：」+ 那一类原因。 */
export function CloudComputerRefusal({
  failure,
  prefixKey,
  onUpgrade,
  onRetry,
  onCancel,
}: {
  failure: ActionFailure
  /** 原因前面那半句(「没开成：」「没能唤醒：」)。 */
  prefixKey: 'devices.cloud.provisionFailed' | 'devices.cloud.wakeFailed'
  onUpgrade?: () => void
  onRetry?: () => void
  onCancel?: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const tone =
    failure.kind === 'plan_required' || failure.kind === 'credits_exhausted' || failure.kind === 'membership_expired'
      ? 'warn'
      : 'danger'
  return (
    <div className={calloutClassName(tone)} role="alert" data-testid="cloud-computer-refusal" data-kind={failure.kind}>
      <div className={cn(text, 'text-[var(--fg)]')}>
        {failure.kind === 'plan_required' ? (
          <>
            {t('devices.cloud.planRequired')}
            {onUpgrade && billingLinksAvailable() && <>{' '}<InlineAction onClick={onUpgrade} testId="cloud-computer-upgrade">{t('devices.cloud.upgrade')}</InlineAction></>}
          </>
        ) : failure.kind === 'credits_exhausted' ? (
          <>
            {t('devices.cloud.creditsExhausted')}
            {onUpgrade && billingLinksAvailable() && <>{' '}<InlineAction onClick={onUpgrade} testId="cloud-computer-top-up">{t('devices.cloud.topUp')}</InlineAction></>}
          </>
        ) : (
          <>
            {t(prefixKey)}{tc(`cloudComputer.reason.${failure.kind}`)}
            {onRetry && <>{' '}<InlineAction onClick={onRetry} testId="cloud-computer-retry">{t('devices.retry')}</InlineAction></>}
            {onCancel && <>{t('devices.cloud.or')}<InlineAction onClick={onCancel} testId="cloud-computer-cancel-provision">{t('devices.cloud.cancelProvision')}</InlineAction></>}
          </>
        )}
      </div>
    </div>
  )
}


function StepIcon({ status }: { status: CloudComputerStepStatus }) {
  if (status === 'running') return <LoadingIndicator size="inline" className="text-live" />
  if (status === 'done') return <Check aria-hidden className="size-4 text-[var(--fg)]" />
  return <Circle aria-hidden className="size-4 text-[var(--faint-fg)]" />
}

function elapsedText(since: string | null, now: number): string | null {
  const start = since ? Date.parse(since) : NaN
  if (!Number.isFinite(start)) return null
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 开通进度那一块:就地展开在设备列表上方。出错时原因 + 「重试」「取消开通」。 */
export function CloudComputerProvisionPanel({
  snapshot,
  device,
  onUpgrade,
  retryProvision,
}: {
  snapshot: CloudComputerSnapshot
  device: Device | null
  onUpgrade?: () => void
  /** 开通就出错(还没有设备)时「重试」怎么再开通一次;不给 = 照默认(不带助理的名字与形象)。 */
  retryProvision?: () => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const [now, setNow] = useState(() => Date.now())
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const failed = snapshot.state === 'error'
  useEffect(() => {
    if (failed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [failed])
  const steps = cloudComputerProvisionSteps(snapshot, device)
  const elapsed = elapsedText(snapshot.since, now)

  // 开通就出错(还没有 deviceId):重来一次 = 再开通;有了 deviceId(建助理没成)= /wake,管家会补建。
  const retry = useCallback(async () => {
    setFailure(null)
    try {
      if (snapshot.deviceId) await wakeCloudComputer()
      else if (retryProvision) await retryProvision()
      else await provisionCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'retry provision'))
    }
  }, [snapshot.deviceId, retryProvision])
  const cancel = useCallback(async () => {
    setFailure(null)
    try {
      await destroyCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'cancel provision'))
    }
  }, [])

  return (
    <div
      className="flex flex-col gap-3 rounded-[var(--radius-document)] bg-foreground/[0.025] p-[13px] dark:bg-foreground/[0.04]"
      role="region"
      aria-label={t('devices.cloud.title')}
      data-testid="settings-cloud-computer-provision"
      data-state={snapshot.state}
    >
      <div className={cn(text, 'font-semibold text-[var(--fg)]')}>{t('devices.cloud.provisioningTitle')}</div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
        {steps.map((step) => {
          const stuck = failed && step.status === 'running'
          return (
            <li key={step.id} className="flex items-start gap-2" data-step={step.id} data-status={stuck ? 'failed' : step.status}>
              <span className="flex h-[21px] shrink-0 items-center">
                {stuck ? <X aria-hidden className="size-4 text-[var(--danger-fg)]" /> : <StepIcon status={step.status} />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className={cn(text, step.status === 'pending' ? 'text-[var(--faint-fg)]' : 'text-[var(--fg)]', stuck && 'font-semibold')}>
                  {t(`devices.cloud.steps.${step.id}`)}
                </div>
                {step.id === 'machine' && step.status === 'running' && !failed && (
                  <div className={cn(caption, 'text-[var(--faint-fg)]')}>
                    {elapsed ? t('devices.cloud.stepDetail.minutesElapsed', { elapsed }) : t('devices.cloud.stepDetail.minutes')}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {failed && (
        <CloudComputerRefusal
          failure={failure ?? { kind: cloudComputerSnapshotFailureKind(snapshot) }}
          prefixKey="devices.cloud.provisionFailed"
          onUpgrade={onUpgrade}
          onRetry={() => void retry()}
          onCancel={() => void cancel()}
        />
      )}
      {!failed && failure && <CloudComputerRefusal failure={failure} prefixKey="devices.cloud.provisionFailed" onUpgrade={onUpgrade} />}
    </div>
  )
}

/**
 * 设备行上云电脑那一格状态(替掉「在线 / 上次在线」):在线;开通中;收回着 / 正在起来 = 不说(owner 10-17 ❌「休息中 / 正在醒来」);
 * 出错(连不上、建助理没成)时是「连不上：云电脑那边出了问题。」+ 「重试」(/wake);管家那句原因进日志(store)。
 */
export function CloudComputerRowStatus({
  device,
  snapshot,
  onUpgrade,
  provisionShown = false,
}: {
  device: Device
  snapshot: CloudComputerSnapshot
  onUpgrade?: () => void
  /** 开通进度那一块正摆着:出错的原因与「重试」在那一块里说,行上只说「没开成」(❌ 说两遍)。 */
  provisionShown?: boolean
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const wake = useCallback(async () => {
    setFailure(null)
    try {
      await wakeCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'wake'))
    }
  }, [])
  if (failure) {
    return (
      <span className="text-[var(--danger-fg)]" data-testid="settings-cloud-computer-status" data-status="wake-failed">
        {failure.kind === 'credits_exhausted'
          ? <>{t('devices.cloud.creditsExhausted')}{onUpgrade && billingLinksAvailable() && <>{' '}<InlineAction onClick={onUpgrade}>{t('devices.cloud.topUp')}</InlineAction></>}</>
          : <>{t('devices.cloud.wakeFailed')}{tc(`cloudComputer.reason.${failure.kind}`)}{' '}<InlineAction onClick={() => void wake()}>{t('devices.retry')}</InlineAction></>}
      </span>
    )
  }
  if (snapshot.state === 'error' && provisionShown) {
    return <span className="text-[var(--danger-fg)]" data-testid="settings-cloud-computer-status" data-status="error">{t('devices.cloud.provisionFailedShort')}</span>
  }
  if (snapshot.state === 'error') {
    return (
      <span className="text-[var(--danger-fg)]" data-testid="settings-cloud-computer-status" data-status="error">
        {t('devices.cloud.wakeFailed')}{tc(`cloudComputer.reason.${cloudComputerSnapshotFailureKind(snapshot)}`)}{' '}
        <InlineAction onClick={() => void wake()} testId="settings-cloud-computer-wake-retry">{t('devices.retry')}</InlineAction>
      </span>
    )
  }
  const presence = device.cloud_computer
  if (presence === 'asleep' || presence === 'waking') return null
  if (presence || snapshot.state === 'provisioning') {
    const key = presence ?? 'provisioning'
    return <span data-testid="settings-cloud-computer-status" data-status={key}>{t(`devices.cloud.presence.${key}`)}</span>
  }
  // 管家那边已经没有它(刚关掉、列表还没刷新):照这一行本来的在线与否说。
  return <span data-testid="settings-cloud-computer-status" data-status="plain">{t(device.is_online ? 'devices.online' : 'devices.offline')}</span>
}

/**
 * 状态点:运行中 = live 实心;离线 = 墨色。收回着 / 正在起来 = 不画(#7199 owner 10-17:那是后台资源的事,
 * ❌ 说「休眠中 / 正在醒来」—— 旁边那句已经不说了,点也 ❌ 用空心圈、呼吸去说同一件事)。
 */
export function CloudComputerDot({ device }: { device: Device }) {
  const presence = device.cloud_computer
  if (presence === 'asleep' || presence === 'waking') return null
  return (
    <span
      aria-hidden
      data-presence={presence ?? 'none'}
      className={cn(
        'size-[7px] shrink-0 rounded-[var(--radius-circle)]',
        presence === 'awake' || device.is_online ? 'bg-live' : 'bg-[var(--faint-fg)]',
      )}
    />
  )
}
