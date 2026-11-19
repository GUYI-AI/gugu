import { expect } from 'vitest'
import { until } from './awaitCondition'

/** Exercise the actual horizontal scrollport before testing a complete, unobscured touch target. */
export async function revealPhoneControl(items: HTMLElement, button: HTMLElement) {
  const before = button.getBoundingClientRect(), viewport = items.getBoundingClientRect()
  items.scrollLeft += before.left - viewport.left
  await until('complete control inside its real scrollport', () => {
    const box = button.getBoundingClientRect(), clip = items.getBoundingClientRect()
    return box.left >= clip.left && box.right <= clip.right
  })
  const box = button.getBoundingClientRect()
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true)
}
