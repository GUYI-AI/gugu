import { afterEach, expect, it } from 'vitest'
import { capturePhoneTextSelection } from '@/components/chat/phoneTextSelectionSource'
import { phoneTextSelectionRichText } from '@/components/chat/phoneTextSelectionRichText'
import { phoneTextSelectionAppearance } from '@/components/chat/phoneTextSelectionAppearance'

let bubble: HTMLDivElement | undefined
afterEach(() => { bubble?.remove() })

it.each(['strong', '.code-harbor'])('keeps rich styles, all code and the pressed word from %s', async selector => {
  bubble = document.createElement('div')
  bubble.style.cssText = 'position:fixed;left:16px;top:16px;width:300px;font:16px/24px sans-serif;color:rgb(24,24,24);user-select:none'
  bubble.innerHTML = `<div class="gg-md" style="font:16px/24px sans-serif;color:rgb(24,24,24)">
    <h1 style="font-size:28px;line-height:32px;font-weight:600;margin:0 0 8px">Harbor notes</h1>
    <p style="margin:0 0 8px">The <strong>harbor</strong> opens. Use <code style="font:14px/20px monospace;background:rgb(224,224,224)">copy(text)</code>.</p>
    <div data-streamdown="code-block" style="content-visibility:auto;contain-intrinsic-size:auto 200px;background:rgb(238,238,238);border-radius:8px;padding:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;height:24px;font:12px/18px sans-serif"><span>js</span><button>Copy</button></div>
      <pre style="font:14px/20px monospace;white-space:pre;margin:0"><code><span style="color:rgb(180,35,24)">const</span> <span class="code-harbor" style="color:color-mix(in srgb,red 50%,blue 50%)">harbor</span> = "open";\nconsole.log(harbor);</code></pre>
    </div>
    <p style="margin:8px 0">Read the <a href="https://example.com/harbor" style="color:rgb(30,64,175);text-decoration:underline">harbor guide</a>.</p>
    <ol start="3" style="padding-left:24px;margin:8px 0"><li>Bring a notebook</li><li>Second 😀</li></ol>
  </div>`
  document.body.append(bubble)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const bounds = bubble.querySelector(selector)!.getBoundingClientRect()
  const source = capturePhoneTextSelection(bubble, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)!
  const original = bubble.outerHTML
  const rich = phoneTextSelectionRichText(source)
  expect(rich.text.slice(rich.start, rich.end)).toBe('harbor')
  expect(rich.text).toContain('const harbor = "open";\nconsole.log(harbor);')
  expect(rich.text).not.toContain('Copy')
  expect(rich.text).toContain('3.\tBring a notebook')
  expect(rich.text).toContain('4.\tSecond 😀')
  expect(rich.runs.some(run => run.fontSize === 28 && run.weight === 600)).toBe(true)
  expect(new Set(rich.runs.map(run => run.fontSize))).toEqual(new Set([12, 14, 16, 28]))
  expect(rich.runs.some(run => run.weight === 700 && rich.text.slice(run.start, run.end) === 'harbor')).toBe(true)
  expect(rich.runs.some(run => run.monospace && run.fontSize === 14 && run.color.red === 180 && run.color.green === 35)).toBe(true)
  expect(rich.runs.some(run => run.color.red >= 127 && run.color.red <= 128 && run.color.blue >= 127 && run.color.blue <= 128)).toBe(true)
  expect(rich.runs.some(run => run.background?.red === 224 && rich.text.slice(run.start, run.end) === 'copy(text)')).toBe(true)
  expect(rich.runs.some(run => run.underline && run.color.blue === 175)).toBe(true)
  expect(rich.paragraphs.some(paragraph => paragraph.marker === '3.' && paragraph.indent === 24 && paragraph.firstLineIndent < paragraph.indent)).toBe(true)
  expect(rich.paragraphs.some(paragraph => paragraph.after > 0)).toBe(true)
  expect(rich.blocks).toHaveLength(1)
  expect(rich.blocks[0].background.red).toBe(238)
  expect(rich.blocks[0].radius).toBe(8)
  expect(bubble.outerHTML).toBe(original)
})

it('keeps a code header and its code at the same inset inside a list item', async () => {
  bubble = document.createElement('div')
  bubble.style.cssText = 'position:fixed;left:16px;top:16px;width:300px;font:16px/24px sans-serif;color:rgb(24,24,24)'
  bubble.innerHTML = `<div class="gg-md"><ol style="padding-left:24px;margin:0"><li>
    <p style="margin:0 0 8px">First item</p><div data-streamdown="code-block" style="background:rgb(238,238,238);padding:8px">
      <div style="display:flex;height:24px;font:12px/18px sans-serif"><span>js</span><button>Copy</button></div>
      <pre style="font:14px/20px monospace;white-space:pre;margin:0"><code>const <span>harbor</span> = 1;</code></pre>
    </div></li></ol></div>`
  document.body.append(bubble)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const word = bubble.querySelector('pre span')!.getBoundingClientRect()
  const source = capturePhoneTextSelection(bubble, word.x + word.width / 2, word.y + word.height / 2)!
  const rich = phoneTextSelectionRichText(source)
  const header = rich.paragraphs.find(paragraph => rich.text.slice(paragraph.start, paragraph.end) === 'js')!
  const code = rich.paragraphs.find(paragraph => rich.text.slice(paragraph.start, paragraph.end).includes('const harbor'))!
  expect(header.indent).toBe(32)
  expect(code.indent).toBe(header.indent)
  expect(rich.text.slice(rich.start, rich.end)).toBe('harbor')
  expect(rich.blocks[0].insetLeft).toBe(24)
})

it('keeps the actual root foreground when CSS resolves it in sRGB rather than rgb bytes', () => {
  bubble = document.createElement('div')
  bubble.style.cssText = 'width:300px;font:16px/24px sans-serif;color:color-mix(in srgb,black 90%,white 10%)'
  bubble.textContent = 'harbor'
  document.body.append(bubble)
  expect(CSS.supports('color', 'color-mix(in srgb,black 90%,white 10%)')).toBe(true)
  expect(phoneTextSelectionAppearance(bubble).color).toBe('#1a1a1a')
})
