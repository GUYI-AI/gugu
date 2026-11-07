import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { IOSCalendarPermissionError, readIOSCalendarPermissionStatus, type IOSCalendarPermissionStatus } from './iosCalendarPermissions'

type PermissionRead =
  | { ownerId: string; kind: 'loading' }
  | { ownerId: string; kind: 'ready'; status: IOSCalendarPermissionStatus }
  | { ownerId: string; kind: 'failed'; message: string }

const STATUS_TEXT = {
  notDetermined: '未授权', denied: '未授权', restricted: '系统限制',
  writeOnly: '仅允许写入', fullAccess: '系统已允许',
} as const

function readFailure(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  if (code === 'stale_context') return '账号或这台手机的身份已变化，请重新打开权限页。'
  if (code === 'not_granted') return '请在当前账号的权限页查看日历权限。'
  if (cause instanceof IOSCalendarPermissionError) return cause.message
  return '未读到日历权限，请重新读取。'
}

/** iOS-only permission surface. Native category/owner actions are connected separately by the host. */
export function IOSCalendarPermissionsPanel({ ownerId, readStatus = readIOSCalendarPermissionStatus }: {
  ownerId: string
  readStatus?: () => Promise<IOSCalendarPermissionStatus>
}) {
  const [snapshot, setSnapshot] = useState<PermissionRead>({ ownerId, kind: 'loading' })
  const latestRead = useRef<symbol | null>(null)
  const current = snapshot.ownerId === ownerId ? snapshot : { ownerId, kind: 'loading' as const }

  const refresh = useCallback(async () => {
    const request = Symbol('calendar-permission-read')
    latestRead.current = request
    setSnapshot({ ownerId, kind: 'loading' })
    try {
      const status = await readStatus()
      if (latestRead.current === request) setSnapshot({ ownerId, kind: 'ready', status })
    } catch (cause) {
      if (latestRead.current === request) setSnapshot({ ownerId, kind: 'failed', message: readFailure(cause) })
    }
  }, [ownerId, readStatus])

  useEffect(() => {
    let alive = true
    void refresh()
    const unsubscribe = platform.subscribeAppForeground(() => { if (alive) void refresh() }, cause => {
      if (!alive) return
      latestRead.current = null
      setSnapshot({ ownerId, kind: 'failed', message: readFailure(cause) })
    })
    return () => { alive = false; latestRead.current = null; unsubscribe() }
  }, [ownerId, refresh])

  const authorization = current.kind === 'ready' ? current.status.authorization : null
  const statusText = current.kind === 'loading' ? '正在读取' : current.kind === 'failed' ? '查不到' : STATUS_TEXT[current.status.authorization]
  const detail = authorization === 'writeOnly' ? '读取和管理日程需要完整日历权限。'
    : authorization === 'denied' || authorization === 'restricted' ? '请在系统设置中为咕咕开启日历权限。'
      : null

  return <SettingsGroup title="这台手机上的任务 Agent 能用" presentation="navigation"
    footer={current.kind === 'failed' ? <SettingsNote tone="danger" role="alert">{current.message}</SettingsNote>
      : detail ? <SettingsNote>{detail}</SettingsNote> : undefined}>
    <SettingsRow title="日历" description="读取和管理日程" control={<div className="flex items-center gap-2">
      <span className="gg-settings-row-value" role="status">{statusText}</span>
      <Button size="sm" variant="ghost" disabled={current.kind === 'loading'} aria-label="重新读取日历权限" onClick={() => void refresh()}>重新读取</Button>
    </div>} />
  </SettingsGroup>
}
