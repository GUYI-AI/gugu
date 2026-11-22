/**
 * 向下兼容一档(serverMachineHealth.ts):两边只差一档时照常连,由新的一侧降级。
 * 10-28 Linux 2:13 的桌面敲 12 的 server,server 当成版本信号当场换版,7 条车道正在跑的那一轮全断。
 */
import { describe, expect, it } from 'vitest'
import { desktopProtocolOutsideWindow } from '../../../packages/core/src/cloud/serverDesktopVersions'
import { helloProtocol, MIN_CLIENT_PROTOCOL, MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION, serverProtocolTooOld } from '../../../packages/core/src/cloud/serverMachineHealth'
import { sessionInputAdmission } from '../../../packages/core/src/shared/sessionInputAdmission'
import { settlementFromWire, type Settlement } from '../../../packages/session-core/src/session-record/contract'

describe('protocol 20 is a clean break: a project id and a folder id cannot share one argument position', () => {
  it('both lower bounds are the current protocol; a 19 machine on either side is told to update', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(20)
    expect(MIN_CLIENT_PROTOCOL).toBe(REMOTE_PROTOCOL_VERSION)
    expect(MIN_SERVER_PROTOCOL).toBe(REMOTE_PROTOCOL_VERSION)
    expect(serverProtocolTooOld(REMOTE_PROTOCOL_VERSION - 1, { unknownIsTooOld: false })).toBe(true)
    expect(desktopProtocolOutsideWindow(REMOTE_PROTOCOL_VERSION - 1)).toBe(true)
  })

  it('a desktop says its own protocol to an older machine, which refuses it as outside its window', () => {
    const own = REMOTE_PROTOCOL_VERSION
    expect(helloProtocol(own - 1)).toBe(own)
    expect(desktopProtocolOutsideWindow(helloProtocol(own - 1), { min: own - 2, max: own - 1 })).toBe(true)
    expect(helloProtocol(own)).toBe(own)
    expect(helloProtocol(own + 1)).toBe(own)
    expect(helloProtocol(own - 2)).toBe(own)
    expect(helloProtocol(null)).toBe(own)
  })

  it('a settlement from a protocol-12 host (host: {kind, payload}) reads as origin; a new one is left alone', () => {
    const base = { itemId: 'a', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null } as const
    const old = { ...base, host: { kind: 'app-install', payload: { extensionId: 'x' } } } as Settlement
    expect(settlementFromWire(old).origin).toEqual({ source: 'app-install', payload: { extensionId: 'x' } })
    const fresh: Settlement = { ...base, origin: { source: 'harness-permission' } }
    expect(settlementFromWire(fresh)).toBe(fresh)
    expect(settlementFromWire({ ...base } as Settlement).origin).toBeUndefined()
  })
})

it('reads a task input reply without an admission decision as uncertain', () => {
  expect(sessionInputAdmission({ code: 'session_not_found', message: 'missing' })).toBe('uncertain')
  const error = { code: 'session_not_found', message: 'missing', admission: 'rejected' }
  expect(sessionInputAdmission(error)).toBe('rejected')
})
