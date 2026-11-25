/** @jsxImportSource solid-js */
/**
 * The page in the box its def measured, with an expand button that opens it over the window. Ported from T3 Code
 * `apps/web/src/components/chat/HtmlRenderFrame.tsx` and `HtmlRenderDialog.tsx`
 * (https://github.com/pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools Inc.; full notice in core/html-render/page.ts).
 */
import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import { codeGroup, copyButtonOverlay } from '@session-chat/components/primitives/copy-button.css';
import { IconMaximize, IconX } from '@session-chat/components/primitives/icons';
import {
  clampHtmlRenderHeight,
  htmlRenderDocument,
  htmlRenderRootCss,
  htmlRenderSurface,
  keepHtmlRenderPage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from '@session-chat/core/html-render/page';
import type { HtmlRenderLeafLayout } from '@session-chat/core/layout/layout-types';
import { subscribeHostTheme, svgPalette } from '@session-chat/core/svg/figure';
import { useChatTranslator } from '@session-chat/localization';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { htmlRenderBackdrop, htmlRenderClose, htmlRenderDialog, htmlRenderFrame } from './html-render.css';

/**
 * One frame of the page: themed from the surface it sits on (re-read when the host theme flips, which reloads it),
 * reports the page's own height and opens its links in the host.
 */
function PageFrame(props: { source: string; themeFlips: () => number; title: string; width?: number; height: number; onHeight: (height: number) => void }) {
  const commands = useCommands();
  let frame!: HTMLIFrameElement;
  const [surface, setSurface] = createSignal<ReturnType<typeof htmlRenderSurface>>();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) return props.onHeight(height);
    const url = readHtmlRenderLinkRequest(event.data, frame);
    if (url && !commands().onOpenLink?.(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };
  window.addEventListener('message', onMessage);
  onCleanup(() => window.removeEventListener('message', onMessage));
  onMount(() => {
    onCleanup(keepHtmlRenderPage(frame));
    createEffect(() => (props.themeFlips(), setSurface(htmlRenderSurface(frame.parentElement!, svgPalette(document.documentElement)))));
  });
  const srcDoc = createMemo(() => {
    const theme = surface();
    if (!theme) return undefined;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
    return htmlRenderDocument(props.source, htmlRenderRootCss(theme.palette, { sans: getComputedStyle(document.body).fontFamily, mono }, theme.scheme));
  });
  // An opaque sandbox: scripts run, but the page reaches neither this window, its storage, popups nor top navigation.
  return <iframe ref={frame} title={props.title} srcdoc={srcDoc()} sandbox="allow-scripts" width={props.width ?? '100%'} height={props.height} class={htmlRenderFrame} style={{ 'color-scheme': surface()?.scheme }} />;
}

export function HtmlRenderView(props: { block: HtmlRenderLeafLayout }) {
  const caches = useCaches();
  const translate = useChatTranslator();
  const [themeFlips, setThemeFlips] = createSignal(0);
  const [expanded, setExpanded] = createSignal(false);
  const [expandedHeight, setExpandedHeight] = createSignal<number>();
  // Themed with the same tokens a ```svg figure reads, as the page is now; a light/dark flip reloads it.
  onCleanup(subscribeHostTheme(() => setThemeFlips((n) => n + 1)));
  let expand!: HTMLButtonElement;
  const close = () => setExpanded(false);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && expanded()) close();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <BlockFrame layout={props.block} class={codeGroup}>
      <PageFrame
        source={props.block.raw.source}
        themeFlips={themeFlips}
        title={translate('transcript.htmlRenderTitle')}
        width={props.block.contentWidth}
        height={props.block.height}
        onHeight={(height) => caches.setHtmlRenderHeight(props.block.raw.source, height)}
      />
      <button ref={expand} type="button" class={copyButtonOverlay} aria-label={translate('transcript.htmlRenderExpand')} onClick={() => setExpanded(true)}>
        <IconMaximize />
      </button>
      <Show when={expanded()}>
        {/* Into the chat root, as the subagent panel: it carries the host's type variables and theme class. */}
        <Portal mount={expand.closest('[data-chat-root]') ?? document.body}>
          <div class={htmlRenderBackdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && close()}>
            <div class={htmlRenderDialog} role="dialog" aria-modal="true" aria-label={translate('transcript.htmlRenderTitle')}>
              <button type="button" class={htmlRenderClose} aria-label={translate('transcript.htmlRenderClose')} onClick={close}>
                <IconX />
              </button>
              <PageFrame
                source={props.block.raw.source}
                themeFlips={themeFlips}
                title={translate('transcript.htmlRenderTitle')}
                height={clampHtmlRenderHeight(expandedHeight() ?? props.block.height)}
                onHeight={setExpandedHeight}
              />
            </div>
          </div>
        </Portal>
      </Show>
    </BlockFrame>
  );
}
