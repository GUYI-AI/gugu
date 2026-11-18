// #2930 Product path: the CronPicker schedule editor.
import { expect, it } from 'vitest'
import {
  parseCron,
  toCron
} from '../../../../apps/desktop/src/session/renderer/lib/CronPicker/cron-utils'

it('represents cron Sunday seven in the picker', () => {
  const sunday = parseCron('15 9 * * 7')
  expect(sunday).toMatchObject({ period: 'week', weekDay: 0, minute: 15, hour: 9 })
  expect(toCron(sunday!)).toBe('15 9 * * 0')
  expect(parseCron('15 9 * * 8')).toBeNull()
  expect(parseCron('15 9 * * 6')).toMatchObject({ weekDay: 6 })
})
