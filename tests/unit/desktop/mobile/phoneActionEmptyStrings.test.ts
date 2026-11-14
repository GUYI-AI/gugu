import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ calendarList: vi.fn(), calendarCreate: vi.fn() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

import { phoneActionByName } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'
import { normalizePhoneActionArguments } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionArguments'

describe('optional phone action strings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    native.calendarList.mockResolvedValue({ events: [], timezone: 'UTC' })
  })
  afterEach(() => vi.useRealTimers())

  it.each(['', ' \t\n'])('uses the interval when the optional date is blank (%j)', async (date) => {
    const args = { date, start: '2026-11-15T10:00:00+08:00', end: '2026-11-15T11:00:00+08:00', limit: 100 }
    await phoneActionByName('calendar.events.list')!.run(args)
    expect(native.calendarList).toHaveBeenCalledExactlyOnceWith({ start_ms: 1794708000000, end_ms: 1794711600000, limit: 100 })
    expect(args.date).toBe(date)
  })

  it.each(['', ' \t\n'])('uses the default range when all optional dates are blank (%j)', async (blank) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date('2026-11-15T04:30:00Z')
    vi.setSystemTime(now)
    await phoneActionByName('calendar.events.list')!.run({ date: blank, start: blank, end: blank })
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    expect(native.calendarList).toHaveBeenCalledExactlyOnceWith({ start_ms: start, end_ms: start + 7 * 86400000, limit: 100 })
  })

  it('still rejects a nonempty date combined with an interval', async () => {
    await expect(phoneActionByName('calendar.events.list')!.run({ date: '2026-01-02', start: '2026-01-02T10:00:00Z' }))
      .rejects.toMatchObject({ code: 'invalid_args' })
    expect(native.calendarList).not.toHaveBeenCalled()
  })

  it.each(['', ' \t\n'])('still rejects an empty required title (%j)', async (title) => {
    await expect(phoneActionByName('calendar.events.create')!.run({ title, start: '2026-11-15T10:00:00Z' }))
      .rejects.toMatchObject({ code: 'invalid_args' })
    expect(native.calendarCreate).not.toHaveBeenCalled()
  })

  it('preserves nonempty strings, non-string values, unknown fields and the input object', () => {
    const schema = { properties: { optional: { type: 'string' }, required: { type: 'string' }, text: { type: 'string' }, typed: { type: 'string' }, count: { type: 'number' } }, required: ['required'] }
    const args = { optional: '  ', required: '', text: '  keep  ', typed: null, count: 0, unknown: '' }
    expect(normalizePhoneActionArguments(schema, args)).toEqual({ required: '', text: '  keep  ', typed: null, count: 0, unknown: '' })
    expect(args.optional).toBe('  ')
  })
})
