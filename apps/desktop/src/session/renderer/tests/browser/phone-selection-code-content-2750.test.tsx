import { afterEach, expect, it } from 'vitest'
import { capturePhoneTextSelection } from '@/components/chat/phoneTextSelectionSource'

let bubble: HTMLDivElement | undefined
afterEach(() => { bubble?.remove() })

it.each(['strong', 'code span'])('keeps code content when the press is on %s and the measuring clone is offscreen', async selector => {
  bubble = document.createElement('div')
  bubble.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;font:16px/24px sans-serif;user-select:none'
  // Streamdown 2.7 uses this exact optimization on its code-block container.
  bubble.innerHTML = `<div class="gg-md"><h1>Harbor notes</h1><p>The <strong>harbor</strong> opens.</p>
    <div data-streamdown="code-block" style="content-visibility:auto;contain-intrinsic-size:auto 200px">
      <pre><code>const <span>harbor</span> = "open";\nconsole.log(harbor);</code></pre><button>Copy</button>
    </div><p>Read the harbor guide.</p></div>`
  document.body.append(bubble)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const original = bubble.outerHTML
  const bounds = bubble.querySelector(selector)!.getBoundingClientRect()
  expect(bounds.width).toBeGreaterThan(0)
  const source = capturePhoneTextSelection(bubble, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)!
  expect(source.text).toContain('Harbor notes')
  expect(source.text).toContain('const harbor = "open";')
  expect(source.text).toContain('console.log(harbor);')
  expect(source.text).toContain('Read the harbor guide.')
  expect(source.text).not.toContain('Copy')
  expect(source.text.slice(source.start, source.end)).toBe('harbor')
  expect(source.browserRange.toString()).toBe('harbor')
  expect(bubble.outerHTML).toBe(original)
})
