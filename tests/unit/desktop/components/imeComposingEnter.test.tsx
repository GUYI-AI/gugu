// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isImeComposing } from '../../../../apps/desktop/src/lib/ime'
import { platform } from '../../../../apps/desktop/src/platform'
import { DeviceRenameField } from '../../../../apps/desktop/src/components/devices/DeviceRenameField'
import { InlineNameInput } from '../../../../apps/desktop/src/components/ui/InlineNameInput'
import { createReactHarness, typeInto } from '../../../support/testHarness'

// On macOS the Enter that commits a pinyin candidate reaches the page as key 'Enter' with isComposing; Safari
// sends keyCode 229 for it. That key belongs to the input method: a name field must not save half-typed letters.
let h: ReturnType<typeof createReactHarness>
const kind = Object.getOwnPropertyDescriptor(platform, 'kind')!
beforeEach(() => {
  Object.defineProperty(platform, 'kind', { configurable: true, value: 'electron' })
  h = createReactHarness()
})
afterEach(() => { h.cleanup(); Object.defineProperty(platform, 'kind', kind) })

const press = (input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) => act(async () => {
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  await new Promise(resolve => setTimeout(resolve, 10))
})

it('reads composition from React and DOM keyboard events alike', () => {
  expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true)
  expect(isImeComposing({ isComposing: true })).toBe(true)
  expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true)
  expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false)
  expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
})

it.each([{ isComposing: true }, { keyCode: 229 }])('device rename leaves a composition Enter and Escape to the input method (%j)', async (init) => {
  const onSave = vi.fn(); const onCancel = vi.fn()
  await h.render(<DeviceRenameField label="Old" onSave={onSave} onCancel={onCancel} />)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'ceshi')
  await press(input, 'Enter', init)
  await press(input, 'Escape', init)
  expect(onSave).not.toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
  await press(input, 'Enter')
  expect(onSave).toHaveBeenCalledExactlyOnceWith('ceshi')
})

it.each([{ isComposing: true }, { keyCode: 229 }])('desktop inline rename leaves a composition Enter to the input method (%j)', async (init) => {
  const commit = vi.fn().mockResolvedValue(undefined)
  await h.render(<InlineNameInput name="Old" onCommit={commit} onClose={vi.fn()} />)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'ceshi')
  await press(input, 'Enter', init)
  expect(commit).not.toHaveBeenCalled()
  await press(input, 'Enter')
  expect(commit).toHaveBeenCalledExactlyOnceWith('ceshi')
})
