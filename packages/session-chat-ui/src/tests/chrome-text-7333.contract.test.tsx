/** @jsxImportSource solid-js */
/**
 * #7333 chrome 字号按消费角色落到字阶,真 Chromium:
 *   ① chrome 正文 13 → 14/20:收尾行与它的动作(外框 28 不动)、mermaid 的占位与出错两句;
 *   ② 标记 11 → 12/18:收尾徽章(外框 24)、缩略图「+N」;附件文件行照 assistant-ui:名字 14/20 字重 500、类型 12/16(`FILE_ROW`,量高与绘制一起变);
 *   ③ 收尾详情是可逐字复制的等宽原文:代码档 13/20,`DETAIL_LINE_H` 20,原文与「一次看 6 行、自己滚」保留;
 *   ④ micro 10 只量折叠箭头的字形(图标几何),不在这里。
 * 读的是计算值、行**里面**的矩形,以及展开后的量高 === 真实 DOM。选择器落空时键缺席 → undefined(响亮的失败)。
 */
import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { mermaidError, mermaidPlaceholder } from '@session-chat/components/rows/markdown/mermaid/mermaid.css'
import { FILE_ROW } from '@gugu/session-shared/file-row'
import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { DETAIL_PAD_Y } from '@session-chat/components/rows/turn-outcome/turn-outcome.css'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import type { ChatMessage, ChatToolCall, TurnOutcomeItem } from '@session-chat/model'
import { turnOutcomeDetailId } from '@session-chat/state/flatten'
import { describe, expect, it } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const COMPACT = { size: 14, leading: 20 } as const
const CAPTION = { size: 12, leading: 18 } as const
// 代码档是等宽那一面自己的档。写成具名常量:视觉守卫按源码文本数旧字阶的字面量。
const CODE = { size: 13, leading: 20 } as const
const px = (value: string) => Number.parseFloat(value) || 0

function readSlot(read: Record<string, number>, key: string, element: Element | null, box: DOMRect) {
  if (!element) return
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  read[`${key}:size`] = px(style.fontSize)
  read[`${key}:leading`] = Math.round(px(style.lineHeight))
  read[`${key}:height`] = Math.round(rect.height)
  read[`${key}:out`] = Math.max(box.top - rect.top, rect.bottom - box.bottom, box.left - rect.left, rect.right - box.right)
}
const expectTier = (read: Record<string, number>, key: string, tier: { size: number; leading: number }) => {
  expect(read[`${key}:size`], `${key} font-size`).toBe(tier.size)
  expect(read[`${key}:leading`], `${key} line-height`).toBe(tier.leading)
  expect(read[`${key}:out`], `${key} pokes out of its box`).toBeLessThanOrEqual(0.5)
}

const TURN = 'turn-chrome'
const outcome = (detail?: string): TurnOutcomeItem => ({
  kind: 'turn-outcome',
  turnId: TURN,
  id: `${TURN}:outcome`,
  outcome: { kind: 'error', reason: 'prompt_failed', ...(detail ? { detail } : {}) },
  prompt: '把这段东西读一遍',
})
const cancelled: TurnOutcomeItem = { kind: 'turn-outcome', turnId: TURN, id: `${TURN}:cancelled`, outcome: { kind: 'cancelled', reason: 'cancelled' }, prompt: '再来一次' }
const actions = { onRestorePrompt: () => {}, onContinueTurn: () => {} }
const open = (width = 640) => makeContractCtx({ width, isCollapsed: (id) => id === turnOutcomeDetailId(TURN) })

describe('the turn outcome in the master\'s tiers (#7333 chrome)', () => {
  it.each([
    { label: 'failed, with a detail to open', item: outcome('exit code=1'), slots: ['turn-outcome-badge'] },
    { label: 'stopped, with continue and discard', item: cancelled, slots: ['turn-outcome-badge', 'turn-outcome-continue', 'turn-outcome-discard'] },
  ])('$label: the lane text 14/20, the badge 12/18 in its 24, the actions 14/20 in their 28, all inside the 32px lane', async ({ item, slots }) => {
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, item, makeContractCtx({ width: 640 }), (host) => {
      const lane = host.querySelector<HTMLElement>('[data-slot="turn-outcome-lane"]')
      const read: Record<string, number> = { lane: lane ? 1 : 0 }
      if (!lane) return read
      const box = lane.getBoundingClientRect()
      read.laneHeight = Math.round(box.height)
      readSlot(read, 'lane', lane, box)
      for (const slot of slots) readSlot(read, slot, lane.querySelector(`[data-slot="${slot}"]`), box)
      return read
    }, actions)
    const read = reading.inspected
    expect(read.lane, 'the lane is not in the DOM').toBe(1)
    expect(reading.computed).toBe(ROW_H)
    expect(reading.dom).toBe(reading.computed)
    expect(read.laneHeight).toBe(ROW_H)
    expectTier(read, 'lane', COMPACT)
    expectTier(read, 'turn-outcome-badge', CAPTION)
    expect(read['turn-outcome-badge:height'], 'the badge is no longer 24 high').toBe(24)
    for (const slot of slots.filter((s) => s !== 'turn-outcome-badge')) {
      expectTier(read, slot, COMPACT)
      expect(read[`${slot}:height`], `${slot} is no longer 28 high`).toBe(28)
    }
    expect(reading.spill).toBeLessThanOrEqual(0.5)
  })

  // The band's height counts the source's lines (capped at 6) × DETAIL_LINE_H: one line, two, and nine (capped, scrolls).
  it.each([
    { label: 'one line', detail: 'exit code=1', lines: 1 },
    { label: 'two lines', detail: 'Input exceeds the maximum length of 1048576 characters.\ninput_error_code=input_too_large', lines: 2 },
    { label: 'nine lines, shown six at a time', detail: Array.from({ length: 9 }, (_, i) => `stderr line ${i + 1}: something went wrong`).join('\n'), lines: 6 },
  ])('the opened detail ($label): the mono code tier 13/20, measured as drawn, every character kept', async ({ detail, lines }) => {
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, outcome(detail), open(), (host): Record<string, number> => {
      const band = host.querySelector<HTMLElement>('[data-slot="turn-outcome-detail"]')
      if (!band) return { band: 0 }
      const style = getComputedStyle(band)
      return {
        band: 1,
        size: px(style.fontSize),
        leading: Math.round(px(style.lineHeight)),
        mono: /JetBrains Mono/.test(style.fontFamily) ? 1 : 0,
        height: Math.round(band.getBoundingClientRect().height),
        scrolls: band.scrollHeight > band.clientHeight + 0.5 ? 1 : 0,
        chars: band.textContent?.length ?? 0,
        selectable: style.userSelect === 'text' ? 1 : 0,
      }
    }, actions)
    const read = reading.inspected
    expect(read.band, 'the detail band did not open').toBe(1)
    expect({ size: read.size, leading: read.leading, mono: read.mono }).toEqual({ ...CODE, mono: 1 })
    expect(read.height, 'the band is not lines × 20 + its padding').toBe(lines * CODE.leading + 2 * DETAIL_PAD_Y)
    expect(reading.dom, `measure()=${reading.computed} but the DOM is ${reading.dom}`).toBe(reading.computed)
    expect(reading.computed).toBe(ROW_H + lines * CODE.leading + 2 * DETAIL_PAD_Y)
    expect(read.chars, 'the verbatim detail lost characters').toBe(detail.length)
    expect(read.scrolls, lines === 6 ? 'nine lines did not scroll inside six' : 'a short detail scrolls').toBe(lines === 6 ? 1 : 0)
    expect(read.selectable).toBe(1)
  })

  it('mermaid\'s placeholder and error sentences are chrome text, 14/20 (read on spans with their classes, in a themed row)', async () => {
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, cancelled, makeContractCtx({ width: 640 }), (host) => {
      const read: Record<string, number> = {}
      for (const [key, className] of [['placeholder', mermaidPlaceholder], ['error', mermaidError]] as const) {
        const probe = Object.assign(document.createElement('span'), { className, textContent: '图表' })
        host.append(probe)
        const style = getComputedStyle(probe)
        read[`${key}:size`] = px(style.fontSize)
        read[`${key}:leading`] = Math.round(px(style.lineHeight))
        probe.remove()
      }
      return read
    }, actions)
    for (const key of ['placeholder', 'error']) {
      expect({ size: reading.inspected[`${key}:size`], leading: reading.inspected[`${key}:leading`] }, key).toEqual(COMPACT)
    }
  })
})

describe('the small marks in the caption tier (#7333 chrome)', () => {
  it('an attachment file row: name 14/20 weight 600, extension 12/16, inside it; the row is FILE_ROW.height = what measure() reserves', async () => {
    const message: ChatMessage = {
      kind: 'message',
      id: 'chrome-attach',
      role: 'user',
      text: 'One file.',
      attachments: [{ id: 'path:/u/a.pdf', name: 'a-file-whose-name-is-long-enough-to-be-cut-in-its-row.pdf', kind: 'file' }],
    }
    const reading = await renderAndMeasureUnit(messageUnitDef, message, makeContractCtx({ width: 640 }), (host): Record<string, number> => {
      const row = host.querySelector<HTMLElement>('.gg-file-row')
      if (!row) return { chip: 0 }
      const box = row.getBoundingClientRect()
      const read: Record<string, number> = { chip: 1, chipHeight: Math.round(box.height), chipWidth: Math.round(box.width) }
      const name = row.querySelector<HTMLElement>('.gg-file-row-name')
      readSlot(read, 'name', name, box)
      readSlot(read, 'type', row.querySelector('.gg-file-row-detail'), box)
      if (name) { read.cut = name.scrollWidth > name.clientWidth ? 1 : 0; read.nameWeight = Number(getComputedStyle(name).fontWeight) }
      return read
    })
    const read = reading.inspected
    expect(read.chip, 'the attachment row did not render').toBe(1)
    expectTier(read, 'name', { size: FILE_ROW.nameSize, leading: FILE_ROW.nameLine })
    expect(read.nameWeight).toBe(600)
    expectTier(read, 'type', { size: FILE_ROW.detailSize, leading: FILE_ROW.detailLine })
    expect(read.chipHeight).toBe(FILE_ROW.height)
    expect(read.chipWidth, 'the row is fixed-width, not as wide as its name').toBe(FILE_ROW.width)
    expect(read.cut, 'the long name was not cut: the ellipsis is untested').toBe(1)
    expect(reading.dom).toBe(reading.computed)
  })

  it('the "+N" on the last thumbnail is 12/18, inside that thumbnail', async () => {
    const picture = (colour: string) => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 80
      const context = canvas.getContext('2d')!
      context.fillStyle = colour
      context.fillRect(0, 0, 40, 80)
      return canvas.toDataURL('image/png')
    }
    const many: ChatToolCall = {
      kind: 'tool',
      id: 'chrome-thumbs',
      name: 'MCP',
      status: 'done',
      inputSummary: 'gugu · app_check',
      images: Array.from({ length: 12 }, (_, i) => picture(`hsl(${i * 30} 70% 50%)`)),
    }
    const reading = await renderAndMeasureUnit(toolUnitDef, many, makeContractCtx({ width: 720 }), (host): Record<string, number> => {
      const more = host.querySelector<HTMLElement>('[data-slot="tool-call-images-more"]')
      const frame = more?.closest('button') ?? null
      if (!more || !frame) return { more: 0 }
      const read: Record<string, number> = { more: 1 }
      readSlot(read, 'more', more, frame.getBoundingClientRect())
      return read
    })
    expect(reading.inspected.more, 'there was no "+N"').toBe(1)
    expectTier(reading.inspected, 'more', CAPTION)
  })
})
