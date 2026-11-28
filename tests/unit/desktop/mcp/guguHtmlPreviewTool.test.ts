import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGuguHtmlPreviewTool, type HtmlPreviewRequest, type HtmlPreviewResult } from '../../../../apps/desktop/electron/mcp/gugu-html-preview-tool'

vi.mock('electron', () => ({}))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function connect(contentHeight = 316) {
  const requests: HtmlPreviewRequest[] = []
  const server = new McpServer({ name: 'test', version: '0' })
  registerGuguHtmlPreviewTool(server, async (request): Promise<HtmlPreviewResult> => {
    requests.push(request)
    return { width: request.width, contentHeight, height: Math.min(2000, Math.max(80, contentHeight)), consoleMessages: [{ level: 'error', text: 'boom' }], picture: { mimeType: 'image/jpeg', data: 'AAAA' } }
  }, (work) => work)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  cleanups.push(async () => { await client.close(); await server.close() })
  return { client, requests }
}

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>

describe('html_preview', () => {
  it('returns the picture and the fence header with the measured height, at the default width and light', async () => {
    const { client, requests } = await connect()
    const result = await client.callTool({ name: 'html_preview', arguments: { html: '<div>bars</div>' } })
    expect(result.isError).toBeFalsy()
    const content = result.content as Content
    expect(content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' })
    expect(content[1]!.text).toContain('```html-render height=316')
    expect(JSON.parse(content[1]!.text!.split('\n')[0]!)).toEqual({ width: 560, height: 316, contentHeight: 316, consoleMessages: [{ level: 'error', text: 'boom' }] })
    expect(requests).toEqual([{ html: '<div>bars</div>', width: 560, appearance: 'light' }])
  })

  it('reads an absolute .html path, and says when the page is past what a chat frame shows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'html-preview-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'chart.html')
    await writeFile(file, '<p>from a file</p>')
    const { client, requests } = await connect(2600)
    const result = await client.callTool({ name: 'html_preview', arguments: { path: file, width: 390, appearance: 'dark' } })
    expect(requests).toEqual([{ html: '<p>from a file</p>', width: 390, appearance: 'dark' }])
    expect((result.content as Content)[1]!.text).toContain('height=2000 The page is 2600 px; a chat frame is 80–2000 px.')
  })

  it('refuses both or neither of html and path, a relative or non-html path, and a page over 256 KB', async () => {
    const { client, requests } = await connect()
    for (const args of [{}, { html: '<p>a</p>', path: '/tmp/a.html' }, { path: 'a.html' }, { path: '/tmp/a.txt' }, { html: 'x'.repeat(256 * 1024 + 1) }]) {
      expect((await client.callTool({ name: 'html_preview', arguments: args })).isError, JSON.stringify(args).slice(0, 60)).toBe(true)
    }
    expect(requests).toEqual([])
  })
})

describe('html_preview themes', () => {
  it('draws with the window theme colours tokens.css defines (dark :root, [data-theme="light"])', async () => {
    const { HTML_PREVIEW_THEMES } = await import('../../../../apps/desktop/electron/html-render-preview')
    const tokens = readFileSync(join(__dirname, '../../../../apps/desktop/src/styles/tokens.css'), 'utf8')
    // The theme's own rule: of the rules with this selector, the one that defines the chart colours.
    const block = (selector: string) => tokens.split(/\n}/).find(rule => rule.includes(`\n${selector} {`) && rule.includes('--chart-1:'))!
    const read = (css: string, token: string) => new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1]
    for (const [theme, css] of [['dark', block(':root')], ['light', block('[data-theme="light"]')]] as const) {
      const expected = HTML_PREVIEW_THEMES[theme]
      expect(read(css, 'fg'), theme).toBe(expected.fg)
      expect(read(css, 'bg'), theme).toBe(expected.background)
      expect([1, 2, 3, 4, 5, 6].map(n => read(css, `chart-${n}`)), theme).toEqual(expected.chart)
    }
  })
})
