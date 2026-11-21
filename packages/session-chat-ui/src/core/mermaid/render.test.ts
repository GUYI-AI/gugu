// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderMermaidDiagram } from './render'

describe('renderMermaidDiagram', () => {
  it('draws one SVG that takes its colours from the theme variables', async () => {
    const svg = await renderMermaidDiagram('flowchart LR\n  A --> B')
    expect(svg).toMatch(/^<svg [^>]*class="pele pele-flowchart"/)
    expect(svg).toContain('var(--pele-fg')
  })

  it('rejects a source it cannot draw, and one aborted before it started', async () => {
    await expect(renderMermaidDiagram('!!! not a diagram !!!')).rejects.toThrow()
    const aborted = new AbortController()
    aborted.abort()
    await expect(renderMermaidDiagram('graph TD; A-->B;', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('draws no link or image a reader could open or a page could fetch', async () => {
    const svg = await renderMermaidDiagram('flowchart LR\n  A --> B\n  click A "https://example.com"\n  B@{ img: "https://example.com/a.png" }')
    expect(svg).not.toMatch(/<a\b|<image\b|example\.com/)
  })
})
