/** @jsxImportSource solid-js */
/**
 * The page in the box its def measured. Ported from T3 Code `apps/web/src/components/chat/HtmlRenderFrame.tsx`
 * (https://github.com/pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools Inc.; full notice in core/html-render/page.ts).
 */
import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import {
  htmlRenderDocument,
  htmlRenderRootCss,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from '@session-chat/core/html-render/page';
import type { HtmlRenderLeafLayout } from '@session-chat/core/layout/layout-types';
import { subscribeHostTheme, svgPalette } from '@session-chat/core/svg/figure';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { htmlRenderFrame } from './html-render.css';

export function HtmlRenderView(props: { block: HtmlRenderLeafLayout }) {
  const caches = useCaches();
  const commands = useCommands();
  const [themeFlips, setThemeFlips] = createSignal(0);
  onCleanup(subscribeHostTheme(() => setThemeFlips((n) => n + 1)));
  // Themed with the same tokens a ```svg figure reads, as the page is now; a light/dark flip reloads it.
  const srcDoc = createMemo(() => {
    themeFlips();
    const root = document.documentElement;
    const mono = getComputedStyle(root).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
    return htmlRenderDocument(props.block.raw.source, htmlRenderRootCss(svgPalette(root), { sans: getComputedStyle(document.body).fontFamily, mono }));
  });
  let frame!: HTMLIFrameElement;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) return caches.setHtmlRenderHeight(props.block.raw.source, height);
    const url = readHtmlRenderLinkRequest(event.data);
    if (url && !commands().onOpenLink?.(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };
  window.addEventListener('message', onMessage);
  onCleanup(() => window.removeEventListener('message', onMessage));
  return (
    <BlockFrame layout={props.block}>
      {/* An opaque sandbox: scripts run, but the page reaches neither this window, its storage, popups nor top navigation. */}
      <iframe ref={frame} title="html-render" srcdoc={srcDoc()} sandbox="allow-scripts" width={props.block.contentWidth} height={props.block.height} class={htmlRenderFrame} />
    </BlockFrame>
  );
}
