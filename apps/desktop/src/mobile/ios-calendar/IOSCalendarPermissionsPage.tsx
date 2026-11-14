import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { getIOSOwnerPublicationSnapshot, retryIOSOwnerPublication, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import type { IOSOwnerPublicationState } from '../ios-runtime/iosOwnerPublication'
import { IOSCalendarPermissionsPanel } from './IOSCalendarPermissionsPanel'
import { iosCalendarPermissionsAvailable } from './iosCalendarPermissionsAvailability'

const STATE_LABEL = { unavailable: '暂不可用', waiting: '等待登录', publishing: '正在核验', retiring: '正在断开', failed: '核验失败', stopped: '已停止' } as const
function failureText(state: Extract<IOSOwnerPublicationState, { status: 'failed' }>): string {
  if (state.error.code === 'retirement_failed') return '上一轮本机连接还未结束，请重试。'
  if (state.error.code === 'stale_context') return '账号或这台手机的身份已变化，请重新核验。'
  return '未能核验本机身份，请重试。'
}
function detail(state: IOSOwnerPublicationState): string {
  if (state.status === 'failed') return failureText(state)
  if (state.status === 'retiring') return '正在结束上一轮本机连接，完成后才能连接日历。'
  if (state.status === 'stopped') return '本机身份核验已停止。'
  if (state.status === 'publishing') return '正在核验当前账号在这台手机上的身份。'
  if (state.status === 'waiting') return '正在等待当前账号的有效登录会话。'
  if (state.status === 'unavailable') return '本机身份核验暂不可用，请重试。'
  return '账号已变化，请重新核验当前账号的本机身份。'
}

/** Route/capability registration stays with A; this page never enables Android phone capabilities. */
export function IOSCalendarPermissionsPage({ ownerId }: { ownerId: string | null }) {
  const publication = useSyncExternalStore(subscribeIOSOwnerPublication, getIOSOwnerPublicationSnapshot, getIOSOwnerPublicationSnapshot)
  const [retry, setRetry] = useState<{ ownerId: string | null; pending: boolean; failed: boolean } | null>(null)
  const latestRetry = useRef<symbol | null>(null)
  useEffect(() => () => { latestRetry.current = null }, [ownerId])

  const available = iosCalendarPermissionsAvailable()
  const currentRetry = retry?.ownerId === ownerId ? retry : null
  const retryPublication = async () => {
    if (!ownerId || !available || latestRetry.current) return
    const request = Symbol('ios-owner-retry')
    latestRetry.current = request
    setRetry({ ownerId, pending: true, failed: false })
    try {
      await retryIOSOwnerPublication()
      if (latestRetry.current === request) setRetry({ ownerId, pending: false, failed: false })
    } catch {
      if (latestRetry.current === request) setRetry({ ownerId, pending: false, failed: true })
    } finally {
      if (latestRetry.current === request) latestRetry.current = null
    }
  }

  if (available && ownerId && publication.status === 'ready' && publication.binding.ownerId === ownerId) {
    return <SettingsPage data-testid="settings-permissions"><IOSCalendarPermissionsPanel key={publication.binding.deviceId} ownerId={ownerId} /></SettingsPage>
  }

  const failed = Boolean(available && ownerId && (publication.status === 'failed' || currentRetry?.failed))
  const message = !available ? '此安装包暂未提供本机日历权限。' : !ownerId ? '请先登录，再连接这台手机的日历。'
    : currentRetry?.failed ? '未能重新核验本机身份，请重试。' : detail(publication)
  const label = !available ? '暂不可用' : !ownerId ? '未登录' : publication.status === 'ready' ? '账号已变化' : STATE_LABEL[publication.status]
  return <SettingsPage data-testid="settings-permissions">
    <SettingsGroup title="这台手机上的任务 Agent 能用" presentation="navigation"
      footer={<SettingsNote role={failed ? 'alert' : 'status'} tone={failed ? 'danger' : undefined}>{message}</SettingsNote>}>
      <SettingsRow title="日历" description="读取和管理日程" control={<div className="flex items-center gap-2">
        <span className="gg-settings-row-value">{label}</span>
        {available && ownerId && publication.status !== 'stopped' && <Button size="sm" variant="ghost" disabled={currentRetry?.pending}
          aria-label="重新核验本机身份" onClick={() => void retryPublication()}>重试</Button>}
      </div>} />
    </SettingsGroup>
  </SettingsPage>
}
