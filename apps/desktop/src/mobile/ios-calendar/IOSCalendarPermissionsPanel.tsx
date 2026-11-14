import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { IOSCalendarPermissionError, iosCalendarPermissions, type IOSCalendarPermissionClient, type IOSCalendarSnapshot } from './iosCalendarPermissions'

type PermissionRead =
  | { ownerId: string; kind: 'loading' }
  | { ownerId: string; kind: 'changing'; operation: 'connect' | 'disconnect' }
  | { ownerId: string; kind: 'ready'; status: IOSCalendarSnapshot; message?: string }
  | { ownerId: string; kind: 'failed'; message: string }

const STATUS_TEXT = {
  notDetermined: '未授权', denied: '未授权', restricted: '系统限制',
  writeOnly: '仅允许写入', fullAccess: '系统已允许',
} as const

function failureMessage(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  if (code === 'stale_context') return '账号或这台手机的身份已变化，请重新打开权限页。'
  if (code === 'not_granted') return '请在当前账号的权限页查看日历权限。'
  if (code === 'os_permission') return '连接日历需要完整日历权限，请在系统设置中查看。'
  if (code === 'execution_unknown') return '刚才的操作未收到确认，请查看当前状态。'
  if (cause instanceof IOSCalendarPermissionError) return cause.message
  return '未读到日历连接状态，请重新读取。'
}

function statusText(current: PermissionRead): string {
  if (current.kind === 'loading') return '正在读取'
  if (current.kind === 'changing') return current.operation === 'connect' ? '正在连接' : '正在断开'
  if (current.kind === 'failed') return '查不到'
  if (current.status.calendarConnected) return current.status.authorization === 'fullAccess' ? '已连接' : '权限已撤销'
  return `未连接 · ${STATUS_TEXT[current.status.authorization]}`
}

/** Native owner/category truth is required before displaying or changing a connection. */
export function IOSCalendarPermissionsPanel({ ownerId, client = iosCalendarPermissions }: {
  ownerId: string
  client?: IOSCalendarPermissionClient
}) {
  const [snapshot, setSnapshot] = useState<PermissionRead>({ ownerId, kind: 'loading' })
  const latestRequest = useRef<symbol | null>(null)
  const mutation = useRef<symbol | null>(null)
  const current = snapshot.ownerId === ownerId ? snapshot : { ownerId, kind: 'loading' as const }

  const refresh = useCallback(async () => {
    // The permission sheet can foreground the App before native finish completes.
    if (mutation.current) return
    const request = Symbol('calendar-permission-read')
    latestRequest.current = request
    setSnapshot({ ownerId, kind: 'loading' })
    try {
      const status = await client.read(ownerId)
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status })
    } catch (cause) {
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
    }
  }, [ownerId, client])

  const changeConnection = async (operation: 'connect' | 'disconnect') => {
    if (current.kind !== 'ready' || mutation.current) return
    const request = Symbol('calendar-connection-change')
    latestRequest.current = request
    mutation.current = request
    setSnapshot({ ownerId, kind: 'changing', operation })
    try {
      const status = await client[operation](current.status.binding)
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status })
    } catch (cause) {
      // A lost reply is not evidence that native persistence did not run.
      // Read actual state once; never replay the connection operation here.
      if (latestRequest.current !== request) return
      try {
        const status = await client.read(ownerId)
        if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status, message: failureMessage(cause) })
      } catch {
        if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
      }
    } finally {
      if (mutation.current === request) mutation.current = null
    }
  }

  useEffect(() => {
    let alive = true
    void refresh()
    const unsubscribe = platform.subscribeAppForeground(() => { if (alive) void refresh() }, cause => {
      if (!alive) return
      latestRequest.current = null
      mutation.current = null
      setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
    })
    return () => { alive = false; latestRequest.current = null; mutation.current = null; unsubscribe() }
  }, [ownerId, refresh])

  const authorization = current.kind === 'ready' ? current.status.authorization : null
  const detail = authorization === 'writeOnly' ? '读取和管理日程需要完整日历权限。'
    : authorization === 'denied' || authorization === 'restricted' ? '请在系统设置中为咕咕开启日历权限。'
      : null
  const message = current.kind === 'failed' || current.kind === 'ready' ? current.message : undefined
  const busy = current.kind === 'loading' || current.kind === 'changing'

  return <SettingsGroup title="这台手机上的任务 Agent 能用" presentation="navigation"
    footer={message ? <SettingsNote tone="danger" role="alert">{message}</SettingsNote>
      : detail ? <SettingsNote>{detail}</SettingsNote> : undefined}>
    <SettingsRow title="日历" description="读取和管理日程" stack control={<div className="flex items-center gap-2">
      <span className="gg-settings-row-value" role="status">{statusText(current)}</span>
      {current.kind === 'ready' && <Button size="sm" variant="ghost"
        onClick={() => void changeConnection(current.status.calendarConnected ? 'disconnect' : 'connect')}>
        {current.status.calendarConnected ? '断开日历' : '连接日历'}
      </Button>}
      <Button size="sm" variant="ghost" disabled={busy} aria-label="重新读取日历权限" onClick={() => void refresh()}>重新读取</Button>
    </div>} />
  </SettingsGroup>
}
