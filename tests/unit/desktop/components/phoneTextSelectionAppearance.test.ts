// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { phoneTextSelectionAppearance } from '../../../../apps/desktop/src/components/chat/phoneTextSelectionAppearance'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('keeps the message position, width, computed type size and color for the native control', () => {
  const body = document.createElement('div')
  body.style.cssText = 'font-size: 18px; line-height: 27px; color: rgb(30, 40, 50)'
  document.body.append(body)
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 109, 227, 96))
  expect(phoneTextSelectionAppearance(body)).toEqual({
    x: 48, y: 109, width: 227, height: 96, viewportWidth: window.innerWidth,
    fontSize: 18, lineHeight: 27, color: '#1e2832',
  })
})

it('retains a negative top for a message already scrolled partway offscreen', () => {
  const body = document.createElement('div')
  document.body.append(body)
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, -80, 270, 800))
  expect(phoneTextSelectionAppearance(body)).toMatchObject({ y: -80, height: 800 })
})
