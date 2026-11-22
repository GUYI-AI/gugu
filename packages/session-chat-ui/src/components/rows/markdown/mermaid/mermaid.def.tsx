/** @jsxImportSource solid-js */
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { MermaidLeafLayout } from '@session-chat/core/layout/layout-types';
import type { MermaidBlock } from '@session-chat/core/markdown/document';
import { Mermaid } from './Mermaid';

/** Fixed 21:9 aspect ratio: height = width * 9 / 21. */
function mermaidHeight(width: number): number {
  return Math.round((width * 9) / 21);
}

export const mermaidBlockDef = defineBlock<MermaidBlock, MermaidLeafLayout>({
  kind: 'mermaid',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: MermaidBlock, ctx: MeasureCtx): Measured<MermaidLeafLayout> {
    const height = mermaidHeight(ctx.width);
    const layout: MermaidLeafLayout = {
      kind: 'mermaid',
      id: block.id,
      top: 0,
      height,
      contentWidth: ctx.width,
      source: block.source,
      raw: block,
    };
    return { height, width: ctx.width, layout };
  },

  // The diagram is drawn from its source: a width change resizes its frame and keeps the drawn svg.
  domFromContentOnly: true,
  Render(props: { node: Measured<MermaidLeafLayout> }) {
    return <Mermaid block={props.node.layout} rawBlock={props.node.layout.raw} />;
  },
});
