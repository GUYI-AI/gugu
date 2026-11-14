import { describe, expect, it } from 'vitest';
import { turnProcessUnitDef } from '@session-chat/components/rows/turn-process/turn-process.def';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { SubagentRosterEntry } from '@session-chat/lib/background-rosters';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

/**
 * The 「后台 · 1 个子智能体 ›」 pill sits on the running turn's process row. On a phone it was drawn over the
 * 「执行中 · 4s · 1 步」 header (same y, second text line spilling out of a one-line box) and the row below was
 * placed as if the pill had no height. Two ways the painted row left the measured one, both pinned here:
 *
 *  - the header's gap: the layout reserves `gap` between the sender name and the process line, the row painted
 *    the stylesheet's 8px, so a line that was measured to fit beside a squeezed name was pushed onto two rows;
 *  - the pill's text slot is exactly its measured width, so a rendering a hair wider than the measure
 *    (another font, another pixel ratio) shrank the text box below its own content and wrapped it.
 */

const agentTheme = { ...DEFAULT_THEME, layout: { ...DEFAULT_THEME.layout, agentConversation: true } };

const subagent: SubagentRosterEntry = {
  id: 's1', launchToolCallId: 'launch', name: 'Look into it', completedSteps: 0, calls: [], elapsedMs: 4000, startedAt: Date.now() - 4000,
};

const running = (previous?: string) => ({
  kind: 'turn-process' as const, id: 'running', turnId: 't', live: true, steps: 1, startedAt: Date.now() - 4000,
  ...(previous ? { conversationPreviousSpeaker: previous } : {}),
});

function overlap(a: DOMRect, b: DOMRect) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** What the reader would see wrong: boxes on top of each other, text wrapped inside a one-line box, paint outside the row. */
function inspect(host: HTMLElement) {
  const row = host.firstElementChild!.getBoundingClientRect();
  const proc = host.querySelector('[data-conversation-process]')!.getBoundingClientRect();
  const pillEl = host.querySelector<HTMLElement>('[data-slot="background-tasks-pill"]')!;
  const pill = pillEl.getBoundingClientRect();
  const text = pillEl.firstElementChild!.getBoundingClientRect();
  let bottom = 0;
  for (const element of host.firstElementChild!.querySelectorAll('*')) bottom = Math.max(bottom, element.getBoundingClientRect().bottom);
  return {
    pillOnProcess: overlap(pill, proc),
    textOnProcess: overlap(text, proc),
    textLines: Math.round(text.height / 22),
    paintBelowRow: Math.max(0, bottom - row.bottom),
  };
}

const rendered = (width: number, previous?: string, extra?: (host: HTMLElement) => void) => {
  const ctx = makeContractCtx({ width, theme: agentTheme });
  ctx.background = { ownerId: 'running', commands: [], subagents: [subagent], expanded: false };
  return renderAndMeasureUnit(turnProcessUnitDef, running(previous), ctx, (host) => { extra?.(host); return inspect(host); });
};

describe('the background pill on the running turn', () => {
  for (const previous of [undefined, '$agent'] as const) {
    it(`stays inside its measured row at every width a phone or a narrow pane has (${previous ? 'same speaker, no name' : 'name shown'})`, async () => {
      const bad: string[] = [];
      for (let width = 240; width <= 520; width += 1) {
        const result = await rendered(width, previous);
        const { pillOnProcess, textOnProcess, textLines, paintBelowRow } = result.inspected;
        if (result.dom !== result.computed || pillOnProcess > 0 || textOnProcess > 0 || textLines !== 1 || paintBelowRow > 0.5) {
          bad.push(`${width}px: row ${result.dom} measured ${result.computed}, pill over process ${pillOnProcess}, text over process ${textOnProcess}, text lines ${textLines}, paint below row ${paintBelowRow}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('does not wrap its text when the rendering is a hair wider than the measure', async () => {
    // A stand-in for the device: every glyph a little wider than the canvas said (letter-spacing is not part of the measure).
    const wider = (host: HTMLElement) => {
      const style = document.createElement('style');
      style.textContent = '[data-slot="background-tasks-pill"] { letter-spacing: 0.02px; }';
      host.appendChild(style);
    };
    const bad: string[] = [];
    for (const width of [300, 340, 360, 375, 390, 412, 430]) {
      for (const previous of [undefined, '$agent'] as const) {
        const result = await rendered(width, previous, wider);
        const { pillOnProcess, textOnProcess, textLines, paintBelowRow } = result.inspected;
        if (pillOnProcess > 0 || textOnProcess > 0 || textLines !== 1 || paintBelowRow > 0.5) bad.push(`${width}px ${previous ?? 'named'}: ${JSON.stringify(result.inspected)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
