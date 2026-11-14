// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePhoneTextSelection } from '../../../../apps/desktop/src/components/chat/phoneTextSelectionSource'

const initialCaret = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
afterEach(() => {
  document.body.replaceChildren()
  if (initialCaret) Object.defineProperty(document, 'caretRangeFromPoint', initialCaret)
  else Reflect.deleteProperty(document, 'caretRangeFromPoint')
})

function message(html: string, selector: string, offset: number) {
  const bubble = document.createElement('div')
  bubble.innerHTML = `<div class="gg-md">${html}</div>`
  document.body.append(bubble)
  const caret = document.createRange()
  caret.setStart(bubble.querySelector(selector)!.firstChild!, offset)
  caret.collapse(true)
  const readCaret = vi.fn(() => caret)
  Object.defineProperty(document, 'caretRangeFromPoint', { value: readCaret, configurable: true })
  return { bubble, readCaret }
}

describe('the original message press', () => {
  it('captures the visible word and UTF-16 offsets before the menu lifts the message', () => {
    const { bubble, readCaret } = message('<p>The <strong>harbor</strong> opens.</p>', 'strong', 2)
    const before = bubble.outerHTML
    const source = capturePhoneTextSelection(bubble, 80, 140)!
    expect(readCaret).toHaveBeenCalledWith(80, 140)
    expect(source.text).toBe('The harbor opens.')
    expect(source.text.slice(source.start, source.end)).toBe('harbor')
    expect(source.browserRange.toString()).toBe('harbor')
    expect(bubble.outerHTML).toBe(before)
    expect(document.body.children).toHaveLength(1)
  })

  it('excludes copy controls and hidden labels without exposing markdown syntax', () => {
    const { bubble } = message('<p>👩‍💻 <em>harbor</em> opens.</p><button>Copy</button><span aria-hidden="true">hidden</span>', 'em', 1)
    const source = capturePhoneTextSelection(bubble, 10, 20)!
    expect(source.text).toBe('👩‍💻 harbor opens.')
    expect(source.start).toBe(6)
    expect(source.text.slice(source.start, source.end)).toBe('harbor')
    expect(bubble.querySelector('button')?.textContent).toBe('Copy')
  })

  it('does not remove message text that happens to match the temporary marker', () => {
    const { bubble } = message('<p>GUGU_SELECTION_OFFSET <strong>harbor</strong> opens.</p>', 'strong', 1)
    const source = capturePhoneTextSelection(bubble, 10, 20)!
    expect(source.text).toBe('GUGU_SELECTION_OFFSET harbor opens.')
    expect(source.text.slice(source.start, source.end)).toBe('harbor')
  })

  it('has no selection action for a missing or empty body', () => {
    expect(capturePhoneTextSelection(null, 10, 20)).toBeNull()
    expect(capturePhoneTextSelection(document.createElement('div'), 10, 20)).toBeNull()
  })
})
