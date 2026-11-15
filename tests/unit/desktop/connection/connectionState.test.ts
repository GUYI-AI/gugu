import { describe, expect, it } from 'vitest'
import { connectionStateOf } from '../../../../apps/desktop/src/components/connection/connectionState'

// owner 2026-11-08: header states 「在线」「连接中」「设备离线」; only the directory (or a failed cloud wake) says 「设备离线」.
describe('connectionStateOf', () => {
  it('the link answering is online, whatever the directory lease says', () => {
    expect(connectionStateOf({ answering: true, deviceOnline: false })).toBe('online')
  })
  it('directory online but the link silent (window lost / RPC timing out) is connecting, ❌ device offline', () => {
    expect(connectionStateOf({ answering: false, deviceOnline: true, networkOnline: true })).toBe('connecting')
  })
  it("this phone's own network down is connecting even when the directory reading is stale-offline", () => {
    expect(connectionStateOf({ answering: false, deviceOnline: false, networkOnline: false })).toBe('connecting')
  })
  it('a cloud computer being woken is connecting; one that could not be woken is device offline', () => {
    expect(connectionStateOf({ answering: false, deviceOnline: false, cloudWaking: true })).toBe('connecting')
    expect(connectionStateOf({ answering: false, deviceOnline: false, cloudWaking: true, cloudWakeFailed: true })).toBe('device_offline')
  })
  it('the directory saying the device is off is device offline', () => {
    expect(connectionStateOf({ answering: false, deviceOnline: false, networkOnline: true })).toBe('device_offline')
    expect(connectionStateOf({ deviceOnline: false })).toBe('device_offline')
  })
  it('a page with no link of its own follows the directory', () => {
    expect(connectionStateOf({ deviceOnline: true })).toBe('online')
  })
})
