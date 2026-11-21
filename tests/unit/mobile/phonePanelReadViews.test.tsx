// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'
import { ReadFailed,ReadView } from '../../../apps/desktop/src/mobile/assistant/PhoneMachineView'
vi.mock('react-i18next',async original => ({ ...await original<object>(),useTranslation: () => ({ t: (key: string) => key }) }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.useFakeTimers();h=createReactHarness() })
afterEach(() => { h.cleanup();vi.useRealTimers() })
it('keeps unprepared quiet and never schedules recovery in a display component',async () => {
  const reload = vi.fn(),error = Object.assign(new Error('snapshot'),{ code: 'unprepared' })
  await h.render(<ReadView reading={{ state: 'error',error }} failedTitle="read">{() => null}</ReadView>)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
  expect(h.container.querySelector('[role="status"]')?.textContent).toContain('unprepared')
  await h.render(<ReadFailed title="read" error={new TypeError('network')} onRetry={reload} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(reload).not.toHaveBeenCalled()
})
// Audit R8: a failed background re-read kept the last data and dropped the error. The page keeps the last data
// and says this read failed.
it('shows a failed re-read above the last data instead of dropping it',async () => {
  await h.render(<ReadView reading={{ state: 'value',value: ['kept note'],stale: false,error: new Error('permission denied') }} failedTitle="read">
    {(data: string[]) => <ul>{data.map(item => <li key={item}>{item}</li>)}</ul>}
  </ReadView>)
  expect(h.container.querySelector('[data-testid="assistant-read-refresh-failed"]')?.getAttribute('role')).toBe('alert')
  expect(h.container.querySelector('li')?.textContent).toBe('kept note')
  await h.render(<ReadView reading={{ state: 'value',value: ['fresh'],stale: false,error: null }} failedTitle="read">{(data: string[]) => <span>{data[0]}</span>}</ReadView>)
  expect(h.container.querySelector('[data-testid="assistant-read-refresh-failed"]')).toBeNull()
})
