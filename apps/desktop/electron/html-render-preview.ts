import { BrowserWindow, session } from 'electron'
import {
  clampHtmlRenderHeight,
  HTML_RENDER_HEIGHT_EXPRESSION,
  htmlRenderDocument,
  htmlRenderPalette,
  htmlRenderRootCss,
} from '@gugu/session-chat-ui/html-render'
import { endPictures, keepPainting, pictureOf, showAtSize } from './session/main/core/extensions/extension-look-picture'
import type { HtmlPreviewRequest, HtmlPreviewResult } from './mcp/gugu-html-preview-tool'

/**
 * `html_preview`: an ```html-render page drawn off screen before it is sent, the way a chat draws it — the same document
 * (policy, theme tokens, base sheet), at the reader's width — so the agent sees it and gets the height to write into
 * the fence's header (```html-render height=N), the height the reader's frame opens at.
 *
 * The page's own hidden window, as `app_check`'s pictures (extension-look-picture.ts): sandboxed, in an in-memory
 * session of its own, no navigation, no popups, no permissions.
 */

/** The window's text and chart colours (tokens.css `:root` = dark, `[data-theme="light"]`); a test pins them to it. */
export const HTML_PREVIEW_THEMES = {
  light: { fg: '#0a0a0a', background: '#ffffff', chart: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'] },
  dark: { fg: '#fafafa', background: '#0f0f0f', chart: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'] },
} as const

const PREVIEW_PARTITION = 'html-render-preview'
/** Long enough for the fonts' swap and a chart library's first draw. */
const SETTLE_MS = 400
const LOAD_TIMEOUT_MS = 20_000
const FONTS = { sans: 'system-ui, -apple-system, "Segoe UI", sans-serif', mono: 'ui-monospace, monospace' }

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function previewSession() {
  const partition = session.fromPartition(PREVIEW_PARTITION)
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  return partition
}

async function loadedWhole(contents: Electron.WebContents, url: string): Promise<void> {
  const until = Date.now() + LOAD_TIMEOUT_MS
  for (;;) {
    if (contents.isDestroyed()) throw new Error('html_preview was cancelled')
    const ready = !contents.isLoading() && contents.getURL() === url
      && await contents.executeJavaScript('document.readyState', false).catch(() => null) === 'complete'
    if (ready) return
    if (Date.now() >= until) throw new Error(`the page did not load within ${LOAD_TIMEOUT_MS / 1000} s`)
    await delay(50)
  }
}

export async function previewHtmlRender({ html, width, appearance }: HtmlPreviewRequest, signal: AbortSignal): Promise<HtmlPreviewResult> {
  const theme = HTML_PREVIEW_THEMES[appearance]
  const palette = htmlRenderPalette(theme.fg, {
    success: '#16a34a', warning: '#f59e0b', error: '#ef4444',
    ...Object.fromEntries(theme.chart.map((colour, index) => [`c${index + 1}`, colour])),
  })
  const page = htmlRenderDocument(html, htmlRenderRootCss(palette, FONTS, appearance))
  const win = new BrowserWindow({
    show: false, width, height: 900, backgroundColor: theme.background,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: previewSession() },
  })
  const consoleMessages: HtmlPreviewResult['consoleMessages'] = []
  const abort = () => { if (!win.isDestroyed()) win.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('console-message', (event) => {
      if (consoleMessages.length < 20) consoleMessages.push({ level: event.level, text: event.message.slice(0, 500) })
    })
    const size = { width, touch: false, says: `${width} wide` }
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(page).toString('base64')}`
    // A page that tries to leave while it loads (refused above) fails loadURL's promise though it stays and finishes:
    // what counts is that this page is the one loaded, whole.
    void win.loadURL(url).catch(() => undefined)
    await loadedWhole(contents, url)
    // Laid out at the reader's width once it has loaded (the protocol does not answer before the first page).
    await showAtSize(contents, size)
    await keepPainting(contents)
    await contents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', false)
    await delay(SETTLE_MS)
    const measured: unknown = await contents.executeJavaScript(HTML_RENDER_HEIGHT_EXPRESSION, false)
    if (typeof measured !== 'number' || !Number.isFinite(measured)) throw new Error('the page reported no height')
    const height = clampHtmlRenderHeight(measured)
    const picture = await pictureOf(contents, { ...size, height }, `html-render page, ${width} wide, ${appearance}`)
    return { width, contentHeight: Math.ceil(measured), height, consoleMessages, picture }
  } finally {
    signal.removeEventListener('abort', abort)
    if (!win.isDestroyed()) {
      endPictures(win.webContents)
      win.destroy()
    }
  }
}
