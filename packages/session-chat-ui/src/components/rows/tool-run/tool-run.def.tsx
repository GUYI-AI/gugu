/** @jsxImportSource solid-js */
/**
 * tool-run — 一段连续工具调用折成的一句话（#4981，owner 2026-09-06）。
 *
 * 与 `turn-process` 同一副骨架（同一条时间线、同一个折叠头、同一把 ViewState 开关），
 * 只是标签不是「过程 · N 步」而是成句的摘要「搜索了 3 个模式、读了 2 个文件」。
 * 展开不会长高这一行 —— flatten 在它下面重新发出原始行。
 */
import { HEADER_ROW_EXTRA_H, ROW_INSET_X } from '@session-chat/components/engine/row-metrics';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { defineUnit } from '@session-chat/core/units';
import { Show } from 'solid-js';
import type { ToolRunItem } from '@session-chat/model';
import { toolRunNowLabel } from '@session-chat/state/tool-run';
import { readableLabel, rowTranslator } from '../readable-label';
import { ToolThumbs } from '../tools/tool/Tool';
import { toolPictures, toolThumbsFor } from '../tools/tool/tool.def';
import { STEP_STRIP_INSET } from '../tools/tool/tool-images';
import { turnProcessHeaderSlot, turnProcessLine, turnProcessRow } from '../turn-process/turn-process.css';

function summaryLayout(data: ToolRunItem, ctx: import('@session-chat/core/define').MeasureCtx) {
  const now = data.now ? ` · ${toolRunNowLabel(data.now, rowTranslator(ctx))}` : '';
  const command = data.now?.kind === 'command' ? ` ${data.now.command}` : '';
  const label = readableLabel(data.label + now + command, ctx, ctx.width - 20,
    ctx.theme.layout.agentConversation ? 12 : ctx.theme.config.roles.body.size);
  return { ...label, rowHeight: Math.max(ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H, label.height + 8) };
}

/**
 * The only folded line that shows something of what it folds: a step's pictures are what it was for (tool-images.ts:
 * seen without opening the row), so folded, the line carries the strip of its last step that has any. It sits on the
 * column the opened row draws it on, so opening the line moves the pictures down, never sideways. The line is inset by
 * its row chrome; a conversation step is not (its strip is on its label), a classic tool row is (its strip is flush).
 */
function pictureStrip(data: ToolRunItem, ctx: import('@session-chat/core/define').MeasureCtx) {
  if (!data.pictureStep) return null;
  const inset = ctx.theme.layout.agentConversation ? STEP_STRIP_INSET - ROW_INSET_X : 0;
  const pictures = toolPictures(data.pictureStep);
  const strip = toolThumbsFor(pictures, ctx, ctx.width - inset);
  return strip && { strip, inset, item: { id: data.pictureStep.id, ...pictures } };
}

function rowLayout(data: ToolRunItem, ctx: import('@session-chat/core/define').MeasureCtx) {
  const summary = summaryLayout(data, ctx);
  const pictures = pictureStrip(data, ctx);
  return { summary, pictures, height: summary.rowHeight + (pictures?.strip.stripH ?? 0) };
}

export const toolRunUnitDef = defineUnit<ToolRunItem, { extraH: number }>({
  kind: 'tool-run',
  margin: { top: 2, bottom: 2 },
  vars: { extraH: HEADER_ROW_EXTRA_H },

  measure(data, ctx) { return rowLayout(data, ctx).height; },

  Render(props) {
    const row = () => rowLayout(props.data, props.ctx.measureCtx!());
    const layout = () => row().summary;
    const height = () => layout().rowHeight;
    const pictures = () => row().pictures;
    // ViewState keeps the inverted flag inherited from the original store:
    // `isCollapsed(id) === true` means expanded (see view-state.ts).
    const expanded = () => props.ctx.viewState.isCollapsed(props.data.id);
    return (
      <div
        data-slot="tool-run"
        data-turn-id={props.data.turnId}
        data-step-count={props.data.stepCount}
        data-live={props.data.live ? 'true' : 'false'}
        data-expanded={expanded() ? 'true' : 'false'}
        class={turnProcessRow}
        style={{ height: `${row().height}px` }}
      >
        <div class={turnProcessLine} data-slot="tool-timeline-line">
          <div class={turnProcessHeaderSlot}>
            <CollapseHeader
              id={props.data.id}
              collapsible
              expanded={expanded()}
              active={props.data.live}
              height={height()}
              wrap labelSize={layout().size} labelLineHeight={layout().lineHeight}
            >
              {layout().text}
            </CollapseHeader>
          </div>
        </div>
        <Show when={pictures()}>{(value) => <div style={{ 'padding-left': `${value().inset}px` }}><ToolThumbs item={value().item} strip={value().strip} /></div>}</Show>
      </div>
    );
  },
});
