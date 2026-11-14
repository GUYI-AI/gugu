import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guguReasonText, reasonActions } from '@/session/renderer/features/sessions/gugu-reason'

const runtime = vi.hoisted(() => ({ native: true, platform: 'ios' }))
vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: () => runtime.native, getPlatform: () => runtime.platform,
} }))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }))
const translate = (key: string, values?: Record<string, string>) => key + (values ? ' ' + Object.values(values).join(' ') : '')

describe('read-only iOS account failures', () => {
  beforeEach(() => { runtime.native = true; runtime.platform = 'ios' })
  it('uses neutral membership copy with and without a model name', () => {
    expect(guguReasonText('membership-required', translate)).toBe('guguCatalog.reason.membership-required-readonly')
    expect(guguReasonText('membership-required', translate, 'V4 Pro'))
      .toBe('guguCatalog.namedReason.membership-required-readonly composer.platformModelShortName V4 Pro')
  })
  it('offers only a real retry and never invokes the purchase callback', () => {
    const retry = vi.fn(), joinMembership = vi.fn()
    const actions = reasonActions('membership-required', { retry, joinMembership }, translate)
    expect(actions.map(action => [action.kind, action.label])).toEqual([['retry', 'taskError.sessionStartRetry']])
    actions[0]!.run()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(joinMembership).not.toHaveBeenCalled()
  })
  it('does not invent an action when retry is unavailable', () => {
    expect(reasonActions('membership-required', { joinMembership: vi.fn() }, translate)).toEqual([])
  })
  it.each(['android', 'web'])('preserves the existing membership actions on %s', platform => {
    runtime.platform = platform; runtime.native = platform !== 'web'
    expect(reasonActions('membership-required', { retry: vi.fn(), joinMembership: vi.fn() }, translate)
      .map(action => action.kind)).toEqual(['join-membership', 'joined'])
    expect(guguReasonText('membership-required', translate)).toBe('guguCatalog.reason.membership-required')
  })
  it('keeps unrelated model and sign-in recovery actions unchanged', () => {
    const switchModel = vi.fn(), retry = vi.fn()
    expect(reasonActions('model-unavailable', { switchModel }, translate).map(action => action.kind)).toEqual(['switch-model'])
    expect(reasonActions('signed-out', { retry }, translate).map(action => action.kind)).toEqual(['signed-in'])
  })
})
