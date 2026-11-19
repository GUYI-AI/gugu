import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import type { AssistantHomePlace } from '../../lib/assistantHome'
import { refreshSpendingPower, useSpendingPower } from '../../lib/billing/useSpendingPower'
import { membershipSettingsSection } from '../../lib/billing/settingsDestination'
import { UI_EVENTS } from '../../lib/uiEvents'
import { getMoveState, startMove, startPreview, subscribeMove } from '@renderer/features/assistant/assistant-move-controller'
import { moveRecovery, type MoveEnv } from '@renderer/features/assistant/assistant-move-wire'
import { useReplica, type Reading, refreshFailure } from '../../lib/replica'
import { canSetUpCloudAssistant, cloudComputer, type CloudComputerState } from '../../lib/cloudComputer'
import { Unknown } from '../ui/Unknown'
import '../../i18n/registerAssistantCatalog'
import { billingLinksAvailable } from '../../lib/appLinks'

export type AssistantMoveGroupProps = {
  ownerUserId: string
  assistantId: string
  assistantName: string
  home: AssistantHomePlace
  /** 这台电脑的设备 id;网页 / 手机 = null(搬不回来:没有「这台电脑」可住)。 */
  localDeviceId: string | null
  /** 管家那扇门(`cloudComputer` 的读数):没读到 = 等它;开着、这一读没失败 = 能搬上云;读不到 = 说一句、给重试。 */
  cloud: Reading<CloudComputerState>
}

function openMembership() {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: membershipSettingsSection() } }))
}

/**
 * #7199 搬家(owner 10-16:会员升降级 = 搬家;到期保留云上的家,续费或一键搬回自己的电脑)。
 * 云上的家 → 「搬回这台电脑」;这台电脑上的家 → 会员「搬到云上」、非会员指向会员。搬之前先列清会带走什么,点了才搬。
 * 这里只有设置里的那几行;弹窗是 AssistantMoveDialog(挂在壳上,状态在 assistant-move-controller),
 * 编排与测试在 features/assistant/assistant-move.ts。
 */
export function AssistantMoveGroup({ ownerUserId, assistantId, assistantName, home, localDeviceId, cloud }: AssistantMoveGroupProps) {
  const cloudAvailable = canSetUpCloudAssistant(cloud)
  const cloudFailed = refreshFailure(cloud) !== null
  const { t, i18n } = useTranslation('assistant')
  // 会员档(账号额度那一份 replica):没读到 = null(不当成非会员),读不到如实说并给重试。管家那扇门没开 = 不问。
  const spending = useSpendingPower(cloudAvailable ? { id: ownerUserId } : null)
  const member = spending.state === 'value' && spending.membership ? spending.membership.tier !== 'free' : null
  // The plan unread (its read failed while the balance's did not: a value without membership) is unreadable too.
  const membershipFailed = spending.state !== 'unknown' && !spending.membership ? spending.balanceError : null
  // 一次搬的状态是模块级的:搬着时这一组被换位置重挂,照样读得到;每次状态变都重渲染、重读日志
  // (搬完 / 搬断了「接着搬」那一行才跟着变;读日志只是一次 localStorage)。
  const move = useSyncExternalStore(subscribeMove, getMoveState)
  const busy = move.phase.kind === 'preparing' || move.phase.kind === 'moving'
  // A move left half-done here (only a computer keeps one: web and phone have no journal). Read again when a move ends (its
  // phase changes to one not busy): ❌ on every progress tick, ❌ while the move itself writes the journal.
  const recovery = useReplica(moveRecovery, localDeviceId ? [assistantId] : null)
  useEffect(() => {
    if (!localDeviceId) return
    let kind = getMoveState().phase.kind
    return subscribeMove(() => {
      const next = getMoveState().phase.kind
      if (next === kind) return
      kind = next
      if (next !== 'preparing' && next !== 'moving') void moveRecovery.refresh(assistantId)
    })
  }, [localDeviceId, assistantId])
  // Unread, or read before and its read again failing (the resume row stays drawn): said with a retry, the moves waiting.
  const recoveryFailed = refreshFailure(recovery) !== null
  // Not read yet on a computer: the move actions wait for it (a half-done move must be resumed, ❌ a second one started).
  const recoveryUnknown = !!localDeviceId && recovery.state === 'unknown'
  const pending = move.phase.kind === 'done' || recovery.state !== 'value' ? null : recovery.value

  const env = useMemo<MoveEnv | null>(
    () => (localDeviceId ? { ownerUserId, assistantId, assistantName, localDeviceId, home } : null),
    [ownerUserId, assistantId, assistantName, localDeviceId, home]
  )

  const onComputerHere = home.kind === 'computer' && home.thisDevice
  return (
    <SettingsGroup title={t('move.group')} data-testid="assistant-move-group">
      {home.kind === 'cloud' || onComputerHere ? <SettingsRow
        title={t(home.kind === 'cloud' ? 'setup.homeCloudTitle' : 'setup.homeComputerTitle')}
        control={<span className="gg-settings-row-value">{t('move.currentHome')}</span>}
        data-testid="assistant-move-current-home"
      /> : null}
      {recoveryFailed ? <SettingsRow title={t('move.recoveryUnreadable')} control={<Button size="sm" onClick={() => void moveRecovery.refresh(assistantId)}>{t('setup.retry')}</Button>} /> : null}
      {membershipFailed ? <SettingsRow title={t('setup.membershipUnreadable')} description={membershipFailed} control={<Button size="sm" onClick={refreshSpendingPower}>{t('setup.retry')}</Button>} /> : null}
      {pending && env ? (
        <SettingsRow
          title={t('move.resumeTitle')}
          description={t('move.resumeBody')}
          control={
            <Button size="sm" disabled={busy} onClick={() => void startMove(env, pending.direction, new Map(), i18n.language)} data-testid="assistant-move-resume">
              {t('move.resumeAction')}
            </Button>
          }
          data-testid="assistant-move-resume-row"
        />
      ) : null}
      {home.kind === 'cloud' && member === false ? (
        <SettingsRow
          title={t('move.expiredTitle', { name: assistantName })}
          description={billingLinksAvailable() ? t('move.expiredBody', { name: assistantName }) : undefined}
          control={billingLinksAvailable() ? (
            <Button size="sm" onClick={openMembership} data-testid="assistant-move-renew">
              {t('move.renew')}
            </Button>
          ) : undefined}
          data-testid="assistant-move-expired"
        />
      ) : null}
      {home.kind === 'cloud' && env ? (
        <SettingsRow
          stack
          title={t('move.toComputerTitle')}
          description={t('move.toComputerBody')}
          control={
            <Button size="sm" disabled={busy || !!pending || recoveryFailed || recoveryUnknown} onClick={() => void startPreview(env, 'to-computer', i18n.language)} data-testid="assistant-move-to-computer">
              {t('move.toComputerAction')}
            </Button>
          }
          data-testid="assistant-move-to-computer-row"
        />
      ) : null}
      {onComputerHere && env ? (
        <SettingsRow
          stack
          title={t('move.toCloudTitle')}
          description={member === false ? t('move.toCloudNeedsMember') : cloud.state === 'unknown' ? <Unknown className="w-48" />
            : !cloudAvailable ? t('move.cloudUnavailable') : t('move.toCloudBody')}
          control={
            member === false ? (billingLinksAvailable() ? (
              <Button size="sm" onClick={openMembership} data-testid="assistant-move-member">
                {t('move.memberLink')}
              </Button>
            ) : null) : cloudFailed ? (
              <Button size="sm" onClick={() => void cloudComputer.refresh()} data-testid="assistant-move-cloud-retry">{t('setup.retry')}</Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !!pending || recoveryFailed || recoveryUnknown || member === null || !cloudAvailable}
                onClick={() => void startPreview(env, 'to-cloud', i18n.language)}
                data-testid="assistant-move-to-cloud"
              >
                {t('move.toCloudAction')}
              </Button>
            )
          }
          data-testid="assistant-move-to-cloud-row"
        />
      ) : null}
    </SettingsGroup>
  )
}
