/**
 * The one ```html-render page builder every surface draws with (chat bubbles, the transcript): the agent's page, drawn
 * in place in a sandboxed frame (`sandbox="allow-scripts"`, an opaque origin) that fits its height.
 *
 * Ported from T3 Code `packages/shared/src/htmlRender.ts` (https://github.com/pingdotgg/t3code, MIT):
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Kept: the bootstrap that themes the page before paint and reports its height and link clicks, the base sheet, the
 * height clamp. Changed: the page comes from the fence (srcdoc) instead of a published attachment, and its theme is the
 * same agent-facing tokens a ```svg figure reads (`svgPalette`: --fg, --muted, --c1 … --c6), not T3's palette.
 * Dropped: per-width measured heights, shortcut and image forwarding, contained scrollIntoView, file-preview scroll.
 */

export const HTML_RENDER_LANGUAGE = 'html-render'
export const HTML_RENDER_MIN_HEIGHT = 80
export const HTML_RENDER_MAX_HEIGHT = 2000
/** Source bytes past this stay a code block. */
export const HTML_RENDER_MAX_BYTES = 256 * 1024

// A page may come from another member's agent, so nothing it holds may leave: it opens no connection (no fetch() of
// what a reader types), and loads scripts, styles, fonts and images only from three public CDNs (a chart library), so
// no request carries data to a server of the page's choosing. Everything else falls to default-src 'none'.
const HTML_RENDER_CDNS = 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com'
const HTML_RENDER_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${HTML_RENDER_CDNS}`,
  `style-src 'unsafe-inline' ${HTML_RENDER_CDNS}`,
  `font-src data: ${HTML_RENDER_CDNS}`,
  `img-src data: blob: ${HTML_RENDER_CDNS}`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const OPEN_LINK_METHOD = 'ui/open-link'
const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed'

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(height)))
}

/**
 * Keeps the frame on its own page. A sandboxed page can still navigate its own frame (the one way out the policy cannot
 * close); a second load of the same `srcdoc` means it did, so the frame is put back on the page. Returns the unhook.
 */
export function keepHtmlRenderPage(frame: HTMLIFrameElement): () => void {
  let loaded: string | null = null
  const onLoad = () => {
    const page = frame.srcdoc
    if (loaded !== page) {
      loaded = page
      return
    }
    loaded = null
    frame.srcdoc = page // setting it again reloads it
  }
  frame.addEventListener('load', onLoad)
  return () => frame.removeEventListener('load', onLoad)
}

export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { jsonrpc, method, params } = data as Record<string, unknown>
  if (jsonrpc !== '2.0' || method !== SIZE_CHANGED_METHOD) return undefined
  const height = typeof params === 'object' && params !== null ? (params as { height?: unknown }).height : undefined
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : undefined
}

/**
 * The http(s) link a page in `frame` asks the host to open, read on the host as the message arrives. Honoured only
 * while the reader is acting in that frame: the window holds a live user activation and the frame has focus (a click
 * or key in the frame gives both). The page's own script posting the message unprompted carries no activation, and a
 * click elsewhere in the app leaves the focus outside the frame.
 */
export function readHtmlRenderLinkRequest(data: unknown, frame: HTMLIFrameElement): string | undefined {
  if (!navigator.userActivation.isActive || document.activeElement !== frame) return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const { jsonrpc, method, params } = data as Record<string, unknown>
  if (jsonrpc !== '2.0' || method !== OPEN_LINK_METHOD || typeof params !== 'object' || params === null) return undefined
  const { url } = params as Record<string, unknown>
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

const BASE_CSS =
  'html{box-sizing:border-box;padding:8px;color:var(--fg);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}' +
  'html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}'

/**
 * The page's `:root`: the palette as `--token` variables, plus the host's fonts and corner radius. No `color-scheme`:
 * a frame whose scheme differs from the host's is painted on an opaque canvas, and the page must sit on the message.
 */
export function htmlRenderRootCss(palette: Record<string, string>, fonts: { sans: string; mono: string }): string {
  const declarations = Object.entries(palette).map(([token, value]) => `--${token}:${value.replace(/[;{}<>]/g, '')};`).join('')
  const font = (value: string) => value.replace(/[;{}<>]/g, '')
  return `:root{${declarations}--font-sans:${font(fonts.sans)};--font-mono:${font(fonts.mono)};--radius:0.625rem}`
}

// Reports the page's height whenever it changes, and hands http(s) link clicks to the host (the frame cannot navigate).
const BOOTSTRAP_SCRIPT = `(function(){if(window.parent===window)return;var n=0,h;document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"gg-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");},true);var z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};var o=window.ResizeObserver?new ResizeObserver(z):null;if(o)o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`

function bootstrapMarkup(scan: string, rootCss: string): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CSP}">`,
    /<meta\s[^<>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s(?:[^"'<>]|"[^"]*"|'[^']*')*name\s*=\s*["']?viewport/i.test(scan)
      ? ''
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="gg-html-render-theme">${rootCss}${BASE_CSS}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join('')
}

// Blank inert content without shifting offsets so it cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length),
  )
  const parts: string[] = []
  let depth = 0
  let start = 0
  let at = 0
  for (const match of scan.matchAll(/<(\/?)template(?:\s(?:[^"'<>]|"[^"]*"|'[^']*')*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length
      parts.push(scan.slice(at, start), ' '.repeat(end - start))
      at = end
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start))
    at = scan.length
  }
  parts.push(scan.slice(at))
  return parts.join('')
}

/** A fence closes when its last line is a run of three or more backticks or tildes (CommonMark); a streaming one has not. */
export function fenceClosed(raw: string): boolean {
  return /\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(raw.trimEnd())
}

/** The fence's page with the policy, theme and bootstrap first in its head (a fragment gets a document around it). */
export function htmlRenderDocument(html: string, rootCss: string): string {
  const scan = blankNonMarkup(html)
  const markup = bootstrapMarkup(scan, rootCss)
  const headOpen = /<head(?:\s(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/i.exec(scan)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + markup + html.slice(at)
  }
  const htmlOpen = /<html(?:\s(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/i.exec(scan)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${markup}</head>${html}`
}
