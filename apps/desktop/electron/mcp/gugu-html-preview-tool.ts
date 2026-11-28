import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { HTML_RENDER_MAX_BYTES, HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT } from '@gugu/session-chat-ui/html-render'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { registerGuguTool } from './register-gugu-tool.mjs'

/** A desktop chat bubble's page width (a phone's is about 390). */
export const HTML_PREVIEW_DEFAULT_WIDTH = 560

export interface HtmlPreviewRequest { html: string; width: number; appearance: 'light' | 'dark' }
export interface HtmlPreviewResult {
  width: number
  /** The page's own height; `height` is that as the reader's frame takes it (clamped). */
  contentHeight: number
  height: number
  consoleMessages: { level: string; text: string }[]
  picture: { mimeType: string; data: string }
}
export type HtmlPreview = (request: HtmlPreviewRequest, signal: AbortSignal) => Promise<HtmlPreviewResult>

const schema = z.object({
  html: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  width: z.number().int().min(240).max(1600).optional(),
  appearance: z.enum(['light', 'dark']).optional(),
}).strict()

async function pageSource(args: z.infer<typeof schema>): Promise<string> {
  if ((args.html === undefined) === (args.path === undefined)) throw new Error('html_preview takes html or path, one of them')
  if (args.html !== undefined) return args.html
  const file = args.path!
  if (!path.isAbsolute(file) || !/\.html?$/i.test(file)) throw new Error('html_preview path must be an absolute .html file path')
  return readFile(file, 'utf8')
}

/**
 * `html_preview`: draws an ```html-render page off screen as a chat draws it and returns its picture and height, which
 * goes into the fence's header (```html-render height=N) so the reader's frame opens at it. In the catalog; the
 * platform prompt names it.
 */
export function registerGuguHtmlPreviewTool(server: McpServer, preview: HtmlPreview, track: GuguMcpRequestTracker): void {
  registerGuguTool(server, {
    name: 'html_preview',
    description: `Draw an html-render page as a chat shows it, before you send it. Returns a picture, its height and console output. Send the page as a \`\`\`html-render height=<height> fence. html or an absolute .html path, at most ${HTML_RENDER_MAX_BYTES / 1024} KB; width default ${HTML_PREVIEW_DEFAULT_WIDTH} (about 390 for a phone); appearance light or dark.`,
    schema,
  }, async (raw, signal) => {
    const args = raw as z.infer<typeof schema>
    const html = await pageSource(args)
    if (Buffer.byteLength(html) > HTML_RENDER_MAX_BYTES) throw new Error(`html_preview: the page is over ${HTML_RENDER_MAX_BYTES / 1024} KB, which a chat shows as code`)
    const result = await preview({ html, width: args.width ?? HTML_PREVIEW_DEFAULT_WIDTH, appearance: args.appearance ?? 'light' }, signal)
    const clamped = result.contentHeight > HTML_RENDER_MAX_HEIGHT || result.contentHeight < HTML_RENDER_MIN_HEIGHT
      ? ` The page is ${result.contentHeight} px; a chat frame is ${HTML_RENDER_MIN_HEIGHT}–${HTML_RENDER_MAX_HEIGHT} px.`
      : ''
    const text = JSON.stringify({ width: result.width, height: result.height, contentHeight: result.contentHeight, consoleMessages: result.consoleMessages })
    return {
      content: [
        { type: 'image' as const, data: result.picture.data, mimeType: result.picture.mimeType },
        { type: 'text' as const, text: `${text}\nFence header: \`\`\`html-render height=${result.height}${clamped}` },
      ],
    }
  }, track)
}
