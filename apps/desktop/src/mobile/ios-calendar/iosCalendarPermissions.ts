import { Capacitor, registerPlugin } from '@capacitor/core'

export type IOSCalendarAuthorization = 'notDetermined' | 'denied' | 'restricted' | 'writeOnly' | 'fullAccess'

/** OS permission only. Native per-owner category consent is a separate host decision. */
export interface IOSCalendarPermissionStatus {
  authorization: IOSCalendarAuthorization
  os_readable: boolean
  os_writable: boolean
}

export interface IOSCalendarBinding {
  ownerId: string
  deviceId: string
  installationId: string
}

export interface IOSCalendarSnapshot extends IOSCalendarPermissionStatus {
  binding: IOSCalendarBinding
  calendarConnected: boolean
  calendarRevision: string | null
}

export interface IOSCalendarPermissionClient {
  read(ownerId: string): Promise<IOSCalendarSnapshot>
  connect(binding: IOSCalendarBinding): Promise<IOSCalendarSnapshot>
  disconnect(binding: IOSCalendarBinding): Promise<IOSCalendarSnapshot>
}

export class IOSCalendarPermissionError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_native_status', message: string) {
    super(message)
    this.name = 'IOSCalendarPermissionError'
  }
}

// Attempts and the begin/connect/finish transaction stay native. Renderer binding
// is only an expected identity to compare, never authentication or category consent.
const nativeCalendar = registerPlugin<{
  status(options: { ownerId: string }): Promise<unknown>
  connect(options: { expectedBinding: IOSCalendarBinding }): Promise<unknown>
  disconnect(options: { expectedBinding: IOSCalendarBinding }): Promise<unknown>
}>('GuguCalendarPermissions')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function binding(value: unknown): IOSCalendarBinding {
  if (!value || typeof value !== 'object') throw invalidStatus()
  const candidate = value as Record<string, unknown>
  const { ownerId, deviceId, installationId } = candidate
  if (typeof ownerId !== 'string' || !UUID.test(ownerId) || typeof installationId !== 'string' || !UUID.test(installationId)
    || deviceId !== `phone-${installationId}-${ownerId}`) throw invalidStatus()
  return { ownerId, deviceId, installationId }
}

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

function requireNative(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios'
    || !Capacitor.isPluginAvailable('GuguCalendarPermissions')) {
    throw new IOSCalendarPermissionError('unavailable', '此安装包暂未提供本机日历权限。')
  }
}

function snapshot(value: unknown, ownerId: string, expectedBinding?: IOSCalendarBinding): IOSCalendarSnapshot {
  const permission = permissionStatus(value)
  const candidate = value as Record<string, unknown>
  const actual = binding(candidate.binding)
  if (actual.ownerId !== ownerId || (expectedBinding && (actual.deviceId !== expectedBinding.deviceId
    || actual.installationId !== expectedBinding.installationId))) throw invalidStatus()
  if (typeof candidate.calendarConnected !== 'boolean') throw invalidStatus()
  const revision = candidate.calendarRevision
  if (revision !== null && (typeof revision !== 'string' || !UUID.test(revision))) throw invalidStatus()
  if (candidate.calendarConnected && revision === null) throw invalidStatus()
  return { ...permission, binding: actual, calendarConnected: candidate.calendarConnected, calendarRevision: revision }
}

/** Discovery and foreground refresh read actual native state; neither requests OS access. */
export async function readIOSCalendarPermissionStatus(ownerId: string): Promise<IOSCalendarSnapshot> {
  requireNative()
  if (!UUID.test(ownerId)) throw invalidStatus()
  return snapshot(await nativeCalendar.status({ ownerId }), ownerId)
}

export async function connectIOSCalendar(expectedBinding: IOSCalendarBinding): Promise<IOSCalendarSnapshot> {
  requireNative()
  const expected = binding(expectedBinding)
  const result = snapshot(await nativeCalendar.connect({ expectedBinding: expected }), expected.ownerId, expected)
  if (!result.calendarConnected || result.authorization !== 'fullAccess') throw invalidStatus()
  return result
}

export async function disconnectIOSCalendar(expectedBinding: IOSCalendarBinding): Promise<IOSCalendarSnapshot> {
  requireNative()
  const expected = binding(expectedBinding)
  const result = snapshot(await nativeCalendar.disconnect({ expectedBinding: expected }), expected.ownerId, expected)
  if (result.calendarConnected) throw invalidStatus()
  return result
}

export const iosCalendarPermissions: IOSCalendarPermissionClient = {
  read: readIOSCalendarPermissionStatus, connect: connectIOSCalendar, disconnect: disconnectIOSCalendar,
}
