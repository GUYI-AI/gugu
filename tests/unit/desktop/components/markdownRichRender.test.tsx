// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { MarkdownStreamingContext } from '../../../../apps/desktop/src/components/markdown/markdownStreaming'

vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom lays nothing out: each observed element is told it is near (or not) by the test, as the browser would.
const observed: { observer: object; notify: (near: boolean) => void }[] = []
class FakeIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    observed.push({ observer: this, notify: (near) => this.callback([{ isIntersecting: near, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver) })
  }
  disconnect() {
    observed.splice(0, observed.length, ...observed.filter((entry) => entry.observer !== this))
  }
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

async function bringNear(near: boolean) {
  await act(async () => { for (const entry of [...observed]) entry.notify(near) })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  observed.length = 0
  container = document.createElement('div')
  container.style.color = 'rgb(1, 2, 3)'
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function draw(content: string, streaming = false) {
  await act(async () => {
    root.render(createElement(MarkdownStreamingContext.Provider, { value: streaming }, createElement(Markdown, { trust: 'chat', content })))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
}

describe('chat markdown rich rendering', () => {
  it('draws a complete ```html-render fence as a sandboxed, themed page', async () => {
    await draw('```html-render\n<div id="chart">bars</div>\n```')
    await bringNear(true)
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    const doc = frame?.getAttribute('srcdoc') ?? ''
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain('--fg:rgb(1, 2, 3)')
    expect(doc).toContain('<div id="chart">bars</div>')
  })

  it('mounts the page only near the viewport, and keeps the box at its declared height while it is away', async () => {
    await draw('before\n\n```html-render height=320\n<div>bars</div>\n```\n\nafter')
    const box = container.querySelector<HTMLElement>('.gg-md-html-render')
    expect(box?.style.minHeight).toBe('320px')
    expect(container.querySelector('iframe')).toBeNull()
    await bringNear(true)
    expect(container.querySelector('iframe')?.getAttribute('height')).toBe('320')
    await bringNear(false)
    expect(container.querySelector('iframe')).toBeNull()
    expect(box?.style.minHeight).toBe('320px')
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })

  it('keeps an ```html fence as code', async () => {
    await draw('```html\n<div>sample</div>\n```')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('leads a public web link with its site icon and asks nothing for a private address', async () => {
    await draw('[docs](https://example.org/a) and [box](http://192.168.1.2/x)')
    const icons = [...container.querySelectorAll('.gg-md-link-icon img')].map((img) => img.getAttribute('src'))
    expect(icons).toEqual(['https://example.org/favicon.ico'])
    expect(container.querySelectorAll('.gg-md-link-icon')).toHaveLength(2)
  })

  it('fades letters in only while the text is streaming', async () => {
    await draw('hello there', true)
    expect(container.querySelectorAll('[data-sd-animate]').length).toBeGreaterThan(0)
    await draw('hello there')
    expect(container.querySelectorAll('[data-sd-animate]')).toHaveLength(0)
  })
})
