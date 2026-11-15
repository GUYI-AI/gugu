import { beforeEach, describe, expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ native: true, os: 'ios', plugin: true }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => bridge.native, getPlatform: () => bridge.os, isPluginAvailable: (name: string) => name === 'GuguAgent' && bridge.plugin } }))
import { nativePhoneAgentHostAvailable } from '../../../../apps/desktop/src/platform/phoneAgentHostCapability'
beforeEach(() => { bridge.native = true; bridge.os = 'ios'; bridge.plugin = true })
describe('native phone Agent host capability', () => {
  it.each(['ios', 'android'] as const)('requires the actual %s plugin and preserves its wire boundary', os => {
    bridge.os = os; expect(nativePhoneAgentHostAvailable(os)).toBe(true)
    expect(nativePhoneAgentHostAvailable(os === 'ios' ? 'android' : 'ios')).toBe(false)
    bridge.plugin = false; expect(nativePhoneAgentHostAvailable(os)).toBe(false)
    bridge.plugin = true; bridge.native = false; expect(nativePhoneAgentHostAvailable(os)).toBe(false)
  })
})
