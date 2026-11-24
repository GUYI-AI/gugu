/**
 * The ```html-render fence drawn in place: a sandboxed frame as tall as its page, with an expand button.
 *
 * Ported from T3 Code `apps/web/src/components/chat/HtmlRenderFrame.tsx` and `HtmlRenderDialog.tsx`
 * (https://github.com/pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools Inc.; full notice in packages/session-chat-ui/src/core/html-render/page.ts).
 * Changed: the page is the fence's source in `srcdoc` (no attachment URL to mint or refresh); the dialog is ours.
 * Dropped: zoom controls in the dialog, fullscreen pinning of the timeline, keyboard shortcut forwarding.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { svgPalette } from '@gugu/session-chat-ui/svg'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { Maximize2, X } from '@/lib/icons'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/IconButton'
import { followLink } from '../../lib/guguLinks'
import {
  clampHtmlRenderHeight,
  htmlRenderDocument,
  htmlRenderRootCss,
  HTML_RENDER_MIN_HEIGHT,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from '@gugu/session-chat-ui/html-render'

const MAX_MEASURED_CONTENT_HEIGHTS = 200

// The height each page last reported, so a remounted frame (a scrolled-back message) opens at it before its page loads.
const measuredContentHeights = new Map<string, number>()

function rememberContentHeight(code: string, height: number) {
  measuredContentHeights.delete(code)
  measuredContentHeights.set(code, height)
  if (measuredContentHeights.size > MAX_MEASURED_CONTENT_HEIGHTS) {
    const oldest = measuredContentHeights.keys().next().value
    if (oldest !== undefined) measuredContentHeights.delete(oldest)
  }
}

function openLink(url: string) {
  if (!followLink(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

/** One frame of the page; reports the page's own height and opens its links in the host. */
function HtmlRenderDocument({ srcDoc, title, height, onContentHeight }: { srcDoc: string; title: string; height: number; onContentHeight: (height: number) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const report = useRef(onContentHeight)
  report.current = onContentHeight
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const height = readHtmlRenderContentHeight(event.data)
      if (height !== undefined) return report.current(height)
      const url = readHtmlRenderLinkRequest(event.data)
      if (url) openLink(url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  // An opaque sandbox: scripts run, but the page reaches neither this window, its storage, popups nor top navigation.
  return <iframe ref={frame} title={title} srcDoc={srcDoc} sandbox="allow-scripts" height={height} className="block w-full border-0 bg-transparent" />
}

export function HtmlRenderFrame({ code }: { code: string }) {
  const { t } = useTranslation('messaging')
  // Subscribed so a light/dark flip re-renders: the palette is read from the page as the theme is now.
  useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  const [contentHeight, setContentHeight] = useState(() => measuredContentHeights.get(code))
  const [expanded, setExpanded] = useState(false)
  const [expandedHeight, setExpandedHeight] = useState<number>()
  const root = document.documentElement
  const style = getComputedStyle(root)
  const rootCss = htmlRenderRootCss(
    svgPalette(root),
    { sans: getComputedStyle(document.body).fontFamily, mono: style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace' },
  )
  const srcDoc = htmlRenderDocument(code, rootCss)
  const title = t('message.htmlRender.title')
  return (
    <div className="gg-md-html-render">
      <HtmlRenderDocument
        srcDoc={srcDoc}
        title={title}
        height={contentHeight === undefined ? HTML_RENDER_MIN_HEIGHT : clampHtmlRenderHeight(contentHeight)}
        onContentHeight={(height) => {
          rememberContentHeight(code, height)
          setContentHeight(height)
        }}
      />
      <IconButton size="sm" className="gg-md-html-render__expand" aria-label={t('message.htmlRender.expand')} title={t('message.htmlRender.expand')} onClick={() => setExpanded(true)}>
        <Maximize2 size={14} />
      </IconButton>
      {expanded && (
        <Dialog.Root open onOpenChange={(open) => { if (!open) setExpanded(false) }}>
          <Dialog.Portal>
            <Dialog.Backdrop />
            <Dialog.Viewport>
              <Dialog.Popup className="w-[min(92vw,1100px)] max-w-none p-0">
                <Dialog.Title className="sr-only">{title}</Dialog.Title>
                <Dialog.Close className="absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]" aria-label={t('message.htmlRender.close')}><X size={16} /></Dialog.Close>
                <div className="max-h-[86vh] overflow-y-auto overscroll-contain p-4 pt-10">
                  <HtmlRenderDocument srcDoc={srcDoc} title={title} height={expandedHeight === undefined ? HTML_RENDER_MIN_HEIGHT : Math.ceil(expandedHeight)} onContentHeight={setExpandedHeight} />
                </div>
              </Dialog.Popup>
            </Dialog.Viewport>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  )
}
