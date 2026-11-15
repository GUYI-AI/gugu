/** @jsxImportSource solid-js */
import type { SourceFragment } from '@gugu/session-core/session-record/contract';
import { createMemo } from 'solid-js';
import { BlockStackView } from '../../primitives/BlockStackView';
import { defineUnit } from '../../../core/units';
import { layoutBlockStack } from '../../../core/layout/block-stack';
import type { MeasureCtx } from '../../../core/define';
import { assistantOuter, messageText } from './message.css';

function layout(data: SourceFragment, ctx: MeasureCtx) {
  return layoutBlockStack(ctx.caches.parseBlocks(`fragment:${data.key}`, data.text ?? ''), ctx);
}

/** Existing body typography, with no canonical message markers or action hooks. */
export const sourceFragmentUnitDef = defineUnit<SourceFragment>({
  kind: 'source-fragment',
  measure: (data, ctx) => layout(data, ctx).height,
  Render(props) {
    const measured = createMemo(() => layout(props.data, props.ctx.measureCtx!()));
    return <div class={`${assistantOuter} ${messageText({ role: 'assistant' })}`}
      data-source-fragment={props.data.key} style={{ height: `${measured().height}px` }}>
      <BlockStackView node={measured()} />
    </div>;
  },
});
