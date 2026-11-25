import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { svgPalette } from '@gugu/session-chat-ui/svg'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { sourceKeyOf, useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { followLink } from '../../lib/guguLinks'
import { SentMessageSurface } from './sentMessageSurface'
import { useNearViewport } from './useNearViewport'
import {
  clampHtmlPageHeight,
  htmlPageDocument,
  htmlPageRootCss,
  htmlPageSurface,
  keepHtmlPageOnItsPage,
  readHtmlPageContentHeight,
  readHtmlPageLinkRequest,
  type HtmlPageScheme,
} from './htmlPage'

const MAX_PAGE_HEIGHTS = 200

// The height each page (file and version) last reported, so a page drawn again (scrolled back to) opens at it.
const pageHeights = new Map<string, number>()

function rememberPageHeight(key: string, height: number) {
  pageHeights.delete(key)
  pageHeights.set(key, height)
  if (pageHeights.size > MAX_PAGE_HEIGHTS) pageHeights.delete(pageHeights.keys().next().value!)
}

/**
 * An .html attachment sent with a page size, drawn in place. Its box is that size (narrowed to the bubble) from the first
 * frame, then the height its page reports. The bytes are read once it comes near the screen; the frame is mounted only
 * while it is near, and its box keeps the page's height while it is not. Bytes it cannot have show `fallback` (its file card).
 */
export function InlinePage({ meta, messageId, size, fallback }: { meta: ParsedAttachment; messageId: string; size: { width: number; height: number }; fallback: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const onMount = useContext(SentMessageSurface)
  const seen = useNearViewport(box, !onMount) || onMount
  const near = useNearViewport(box, !onMount, true) || onMount
  const view = useAttachmentObjectUrl(meta.source, 'full', seen, meta.fileMetadata, messageId)
  const key = sourceKeyOf(meta.source)
  const [height, setHeight] = useState(() => pageHeights.get(key))
  if (view.status !== 'loading' && view.status !== 'ready') return fallback
  return (
    <div ref={box} data-html-page style={pageBoxStyle(size, height)}>
      {near && view.status === 'ready' && <PageFrame objectUrl={view.objectUrl} title={meta.fileName} onContentHeight={(next) => {
        rememberPageHeight(key, next)
        setHeight(next)
      }} />}
    </div>
  )
}

/** The declared size narrowed to the bubble, as an image's box is (inlineImageStyle); the page's own height once it reports it. */
function pageBoxStyle(size: { width: number; height: number }, height: number | undefined): CSSProperties {
  return { width: size.width, maxWidth: 'min(100%, calc(100cqw - 24px))', ...height === undefined ? { aspectRatio: `${size.width} / ${size.height}` } : { height: clampHtmlPageHeight(height) } }
}

function openLink(url: string) {
  if (!followLink(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * The page in its frame: its bytes with the policy, theme and bootstrap first, from a Blob URL of that document. Themed
 * from the surface it sits on (re-read on a light/dark flip, which reloads it); reports its height and opens its links
 * in the host.
 */
function PageFrame({ objectUrl, title, onContentHeight }: { objectUrl: string; title: string; onContentHeight: (height: number) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const report = useRef(onContentHeight)
  report.current = onContentHeight
  // Subscribed so a light/dark flip re-renders: the page re-reads its surface as the theme is now.
  const hostTheme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  const [page, setPage] = useState<{ url: string; scheme: HtmlPageScheme }>()
  useEffect(() => {
    const surface = htmlPageSurface(frame.current!.parentElement!, svgPalette(document.documentElement))
    const style = getComputedStyle(document.documentElement)
    const fonts = { sans: getComputedStyle(document.body).fontFamily, mono: style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace' }
    let alive = true
    let url: string | undefined
    void fetch(objectUrl).then((response) => response.text()).then((html) => {
      if (!alive) return
      url = URL.createObjectURL(new Blob([htmlPageDocument(html, htmlPageRootCss(surface.palette, fonts, surface.scheme))], { type: 'text/html' }))
      setPage({ url, scheme: surface.scheme })
    })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [objectUrl, hostTheme])
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const height = readHtmlPageContentHeight(event.data)
      if (height !== undefined) return report.current(height)
      const url = readHtmlPageLinkRequest(event.data, frame.current)
      if (url) openLink(url)
    }
    window.addEventListener('message', onMessage)
    const unkeep = keepHtmlPageOnItsPage(frame.current!)
    return () => {
      window.removeEventListener('message', onMessage)
      unkeep()
    }
  }, [])
  // An opaque sandbox: scripts run, but the page reaches neither this window, its storage, popups nor top navigation.
  return <iframe ref={frame} title={title} src={page?.url} sandbox="allow-scripts" className={`block size-full border-0 bg-transparent ${page?.scheme === 'dark' ? '[color-scheme:dark]' : '[color-scheme:light]'}`} />
}
