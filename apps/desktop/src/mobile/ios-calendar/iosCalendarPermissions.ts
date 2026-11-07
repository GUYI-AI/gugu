import { Capacitor, registerPlugin } from '@capacitor/core'

export type IOSCalendarAuthorization = 'notDetermined' | 'denied' | 'restricted' | 'writeOnly' | 'fullAccess'

/** OS permission only. Native per-owner category consent is a separate host decision. */
export interface IOSCalendarPermissionStatus {
  authorization: IOSCalendarAuthorization
  os_readable: boolean
  os_writable: boolean
}

export class IOSCalendarPermissionError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_native_status', message: string) {
    super(message)
    this.name = 'IOSCalendarPermissionError'
  }
}

// Deliberately expose no mutation or permission-prompt method through this reader.
const nativeCalendar = registerPlugin<{ status(): Promise<unknown> }>('GuguCalendarPermissions')

function permissionStatus(value: unknown): IOSCalendarPermissionStatus {
  if (!value || typeof value !== 'object') throw invalidStatus()
  const status = value as Record<string, unknown>
  const authorization = status.authorization
  if (authorization !== 'notDetermined' && authorization !== 'denied' && authorization !== 'restricted'
    && authorization !== 'writeOnly' && authorization !== 'fullAccess') throw invalidStatus()
  const readable = authorization === 'fullAccess'
  const writable = readable || authorization === 'writeOnly'
  if (status.os_readable !== readable || status.os_writable !== writable) throw invalidStatus()
  return { authorization, os_readable: readable, os_writable: writable }
}

function invalidStatus(): IOSCalendarPermissionError {
  return new IOSCalendarPermissionError('invalid_native_status', '未读到有效的日历权限状态，请重新读取。')
}

/** Discovery and foreground refresh read actual native state; neither requests OS access. */
export async function readIOSCalendarPermissionStatus(): Promise<IOSCalendarPermissionStatus> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios'
    || !Capacitor.isPluginAvailable('GuguCalendarPermissions')) {
    throw new IOSCalendarPermissionError('unavailable', '此安装包暂未提供本机日历权限。')
  }
  return permissionStatus(await nativeCalendar.status())
}
