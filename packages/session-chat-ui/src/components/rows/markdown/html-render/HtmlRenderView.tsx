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
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from '@session-chat/core/html-render/page';
import type { HtmlRenderLeafLayout } from '@session-chat/core/layout/layout-types';
import { subscribeHostTheme, svgPalette } from '@session-chat/core/svg/figure';
import { useChatTranslator } from '@session-chat/localization';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { htmlRenderBackdrop, htmlRenderClose, htmlRenderDialog, htmlRenderFrame } from './html-render.css';

/** One frame of the page: reports the page's own height and opens its links in the host. */
function PageFrame(props: { srcDoc: string; title: string; width?: number; height: number; onHeight: (height: number) => void }) {
  const commands = useCommands();
  let frame!: HTMLIFrameElement;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) return props.onHeight(height);
    const url = readHtmlRenderLinkRequest(event.data);
    if (url && !commands().onOpenLink?.(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };
  window.addEventListener('message', onMessage);
  onCleanup(() => window.removeEventListener('message', onMessage));
  // An opaque sandbox: scripts run, but the page reaches neither this window, its storage, popups nor top navigation.
  return <iframe ref={frame} title={props.title} srcdoc={props.srcDoc} sandbox="allow-scripts" width={props.width ?? '100%'} height={props.height} class={htmlRenderFrame} />;
}

export function HtmlRenderView(props: { block: HtmlRenderLeafLayout }) {
  const caches = useCaches();
  const translate = useChatTranslator();
  const [themeFlips, setThemeFlips] = createSignal(0);
  const [expanded, setExpanded] = createSignal(false);
  const [expandedHeight, setExpandedHeight] = createSignal<number>();
  onCleanup(subscribeHostTheme(() => setThemeFlips((n) => n + 1)));
  // Themed with the same tokens a ```svg figure reads, as the page is now; a light/dark flip reloads it.
  const srcDoc = createMemo(() => {
    themeFlips();
    const root = document.documentElement;
    const mono = getComputedStyle(root).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
    return htmlRenderDocument(props.block.raw.source, htmlRenderRootCss(svgPalette(root), { sans: getComputedStyle(document.body).fontFamily, mono }));
  });
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
        srcDoc={srcDoc()}
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
                srcDoc={srcDoc()}
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
