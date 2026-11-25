import { afterEach, describe, expect, it, vi } from 'vitest'
import { pausePhoneDeviceForAccountClosure, readPhoneDeviceSettings } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

afterEach(() => vi.unstubAllGlobals())
describe('phone V2 publication barrier', () => {
  it('persists both off preferences for A and preserves B and category choices', () => {
    const values = new Map<string, string>()
    const a = 'pause-A', b = 'pause-B', key = (owner: string) => `gugu.phoneDevice.v1:${owner}`
    const settings = { enabled: true, hostEnabled: true, groups: { calendar: true } }
    values.set(key(a), JSON.stringify(settings)); values.set(key(b), JSON.stringify(settings))
    vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) })
    pausePhoneDeviceForAccountClosure(a)
    expect(JSON.parse(values.get(key(a))!)).toMatchObject({ enabled: false, hostEnabled: false, groups: { calendar: true } })
    expect(JSON.parse(values.get(key(b))!)).toEqual(settings)
    expect(readPhoneDeviceSettings(a)).toMatchObject({ enabled: false, hostEnabled: false })
  })
  it('a failed preferences write cannot claim a successful pause while stale enabled data remains', () => {
    const settings = JSON.stringify({ enabled: true, hostEnabled: true, groups: {} })
    vi.stubGlobal('localStorage', { getItem: () => settings, setItem: () => { throw new Error('Storage full') } })
    expect(() => pausePhoneDeviceForAccountClosure('pause-write-failure')).toThrow(expect.objectContaining({ code: 'closure_storage_unavailable' }))
    expect(readPhoneDeviceSettings('pause-write-failure')).toMatchObject({ enabled: true, hostEnabled: true })
  })
})
