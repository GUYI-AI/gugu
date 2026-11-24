/** @jsxImportSource solid-js */
/**
 * html — text rendered by the shared markdown dialect, measured in the DOM.
 *
 * The painted element carries the same classes, font and width as the offscreen
 * measurement (layout.ts), so `measure()` equals the painted height. What the
 * paint adds on top never moves a box:
 *  - mention icons fill a fixed-size slot the measurement already reserved;
 *  - streaming fades the text appended since the last paint (opacity only);
 *  - code nested inside a list or quote is coloured in place (monospace, no wrap).
 */

import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useStreamAnimation } from '@session-chat/components/contexts/StreamContext';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import { FileMark, MentionAtIcon, MentionIssueIcon, MentionSymbolIcon } from '@session-chat/components/primitives/icons';
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { ChatCaches } from '@session-chat/core/caches';
import { paintHighlight } from '@session-chat/core/highlight/highlighter';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { HtmlLeafLayout } from '@session-chat/core/layout/layout-types';
import type { HtmlBlock } from '@session-chat/core/markdown/document';
import { hookLinkIconFallback } from '@gugu/session-shared/markdown/dialect';
import { createEffect, createMemo, on, onCleanup, untrack } from 'solid-js';
import { render } from 'solid-js/web';
import { applyBodyType, htmlBlockClass, measureHtml } from './layout';

const KIND_ICONS = { issue: MentionIssueIcon, symbol: MentionSymbolIcon } as const;
type MentionKind = 'file' | 'issue' | 'symbol' | 'custom';

function hydrateMentionIcons(root: HTMLElement): () => void {
  const disposers: (() => void)[] = [];
  for (const slot of root.querySelectorAll<HTMLElement>('.gg-md-mention-icon')) {
    const { icon, iconUrl, iconName } = slot.dataset;
    if (icon === 'url' && iconUrl) {
      const img = document.createElement('img');
      img.src = iconUrl;
      img.alt = '';
      slot.appendChild(img);
    } else if (icon === 'file') {
      disposers.push(render(() => <FileMark name={iconName ?? ''} size={12} ink />, slot));
    } else {
      const Icon = KIND_ICONS[icon as keyof typeof KIND_ICONS] ?? MentionAtIcon;
      disposers.push(render(() => <Icon />, slot));
    }
  }
  return () => disposers.forEach((dispose) => dispose());
}

// ArcMD's answer stream (itself LobeHub Streamdown's char animation): each new letter is born a pace after the one
// before it, the pace spreading a paint's letters over the time since the last paint, so the text keeps gliding in.
// Faded a word at a time, each word born at its first letter's time: a span per letter breaks kerning at its edges and
// moves glyphs by fractions of a pixel, while text is never shaped across a space.
const FADE_MS = 180;
const LETTER_PACE_MS = 18;
const words = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** The text cut into words, each with the spaces and punctuation after it (only the first piece may lack a word). */
function splitWords(text: string): string[] {
  const pieces = words ? Array.from(words.segment(text), ({ segment, isWordLike }) => ({ segment, isWordLike: !!isWordLike })) : text.split(/(\s+)/).map((segment) => ({ segment, isWordLike: !!segment.trim() }));
  const out: string[] = [];
  for (const { segment, isWordLike } of pieces) {
    if (!segment) continue;
    if (out.length && !isWordLike) out[out.length - 1] += segment;
    else out.push(segment);
  }
  return out;
}

/**
 * Wraps each word past `from` characters in a fading span, each a pace per letter later than the one before (`gapMs`: the time
 * since this block last painted); returns the block's character count. Opacity and delay only: no box moves.
 */
function fadeFreshText(root: HTMLElement, from: number, gapMs: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.katex, .gg-md-mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const texts: { node: Text; start: number }[] = [];
  let offset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    texts.push({ node, start: offset });
    offset += node.data.length;
  }
  const freshTexts = texts.filter(({ node, start }) => start + node.data.length > from);
  const freshCount = freshTexts.reduce((sum, { node, start }) => sum + node.data.length - Math.max(0, from - start), 0);
  const gap = Math.min(160, Math.max(16, gapMs));
  const pace = Math.min(LETTER_PACE_MS, Math.max(2, gap / Math.max(1, freshCount)));
  let born = 0;
  for (const { node, start } of freshTexts) {
    const fresh = from > start ? node.splitText(from - start) : node;
    if (!fresh.data.trim()) {
      born += fresh.data.length;
      continue;
    }
    const spans = document.createDocumentFragment();
    for (const word of splitWords(fresh.data)) {
      const span = document.createElement('span');
      span.className = 'gg-md-fresh';
      span.style.setProperty('--gg-md-fresh-delay', `${Math.round(Math.min(born * pace, FADE_MS + gap))}ms`);
      span.textContent = word;
      spans.append(span);
      born += word.length;
    }
    fresh.replaceWith(spans);
  }
  return offset;
}

function highlightNestedCode(root: HTMLElement, caches: ChatCaches): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = /language-(\S+)/.exec(code.className)?.[1];
    if (!lang) continue;
    void caches.highlightWhenReady(code.textContent ?? '', lang).then((result) => {
      if (result && code.isConnected) paintHighlight(code, result);
    });
  }
}

function HtmlBlockView(props: { node: Measured<HtmlLeafLayout> }) {
  const commands = useCommands();
  const caches = useCaches();
  const stream = useStreamAnimation();
  const theme = useTheme();
  let root!: HTMLDivElement;
  let lastPaint = -Infinity;
  hookLinkIconFallback();

  // The block stays mounted across re-measures of the same source block (domFromContentOnly): a width change only
  // moves and resizes its frame. What is painted follows the html (a collapsed block's is empty) and the theme's type.
  createEffect(() => applyBodyType(root, theme()));
  // A memo, so a re-measure that hands over the same html notifies nothing.
  const html = createMemo(() => props.node.layout.html);
  createEffect(
    on(
      html,
      (html) => {
        const id = untrack(() => props.node.layout.id);
        root.innerHTML = html;
        onCleanup(hydrateMentionIcons(root));
        highlightNestedCode(root, caches);
        if (stream) {
          const now = performance.now();
          stream.frontier.set(id, fadeFreshText(root, stream.frontier.get(id) ?? 0, now - lastPaint));
          lastPaint = now;
        }
      },
    ),
  );

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const mention = target.closest<HTMLElement>('.gg-md-mention[data-mention-kind]');
    if (mention) {
      // A file pill is read the way a link is (App 引用 pill, 148 17:03): one pointing at a group's file — `gugu-file://`,
      // maybe with a place — opens there, as that link's click does; only a path on this computer is the host's file.
      if (mention.dataset.mentionKind === 'file' && commands().onOpenLink?.(mention.dataset.mentionId ?? '')) return;
      commands().onClickMention?.({
        id: mention.dataset.mentionId ?? '',
        label: mention.dataset.mentionLabel ?? mention.textContent ?? '',
        kind: mention.dataset.mentionKind as MentionKind,
        itemId: props.node.layout.id,
        source: 'prose-mention',
      });
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    if (commands().onOpenLink?.(href)) return;
    const kind = commands().classifyLink?.(href);
    if (kind?.kind === 'workspace-file') {
      commands().onOpenFile?.({ path: kind.path, itemId: props.node.layout.id, source: 'prose-link', ...(kind.at ? { at: kind.at } : {}) });
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return (
    <BlockFrame layout={props.node.layout}>
      <div ref={root} class={htmlBlockClass(props.node.layout.raw)} onClick={onClick} />
    </BlockFrame>
  );
}

export const htmlBlockDef = defineBlock<HtmlBlock, HtmlLeafLayout>({
  kind: 'html',
  margin: () => ({ top: 6, bottom: 6 }),

  measure(block: HtmlBlock, ctx: MeasureCtx): Measured<HtmlLeafLayout> {
    const width = Math.max(1, ctx.width);
    const metrics = measureHtml(block, width, ctx.theme);
    const layout: HtmlLeafLayout = {
      kind: 'html',
      id: block.id,
      top: 0,
      height: metrics.height,
      contentWidth: metrics.width,
      html: block.html,
      raw: block,
    };
    return { height: metrics.height, width: metrics.width, layout };
  },

  domFromContentOnly: true,
  Render: HtmlBlockView,
});
