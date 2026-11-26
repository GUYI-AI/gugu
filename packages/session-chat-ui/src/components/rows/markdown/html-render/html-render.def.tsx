/** @jsxImportSource solid-js */
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import { htmlRenderOpeningHeight } from '@session-chat/core/html-render/page';
import type { HtmlRenderLeafLayout } from '@session-chat/core/layout/layout-types';
import type { HtmlRenderBlock } from '@session-chat/core/markdown/document';
import { HtmlRenderView } from './HtmlRenderView';

/**
 * A ```html-render page: the row's width, as tall as the page last reported (`caches.htmlRenderHeight`, a reactive
 * read, so the row re-measures when its page reports). Before the page has run once it is the height its header
 * declares (html_preview's measure), else the minimum.
 */
export const htmlRenderBlockDef = defineBlock<HtmlRenderBlock, HtmlRenderLeafLayout>({
  kind: 'html-render',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: HtmlRenderBlock, ctx: MeasureCtx): Measured<HtmlRenderLeafLayout> {
    const height = htmlRenderOpeningHeight(ctx.caches.htmlRenderHeight(block.source), block.height);
    const layout: HtmlRenderLeafLayout = { kind: 'html-render', id: block.id, top: 0, height, contentWidth: ctx.width, raw: block };
    return { height, width: ctx.width, layout };
  },

  // A re-measure (its own height report, a width change) must keep the frame: a remount reloads the page.
  domFromContentOnly: true,

  Render(props: { node: Measured<HtmlRenderLeafLayout> }) {
    return <HtmlRenderView block={props.node.layout} />;
  },
});
