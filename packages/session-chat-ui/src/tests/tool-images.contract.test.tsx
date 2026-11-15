/** @jsxImportSource solid-js */
/**
 * 148 10-14(旁观的活画面,③):工具交回来的图画在工具行头下面,一条缩略图。
 *
 * 判据是行的老规矩 —— 量出来的高 = 画出来的高,而且一张图多大都不改这个数:框是定死的,图在框里 contain。
 * 一个工具一口气回很多大图(148 要的那一格):还是一条、最多四个框、最后一个框说还有几张,❌ 撑开时间线。
 * 点一张 = 交给宿主的看图器,整组图、从这张起。
 */

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext'
import { Tool } from '@session-chat/components/rows/tools/tool/Tool'
import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { conversationStepData, conversationStepUnitDef } from '@session-chat/components/rows/conversation-step/conversation-step.def'
import { CONVERSATION_NARRATION_H } from '@session-chat/components/rows/message/conversation-body'
import type { ChatTranslator } from '@session-chat/localization'
import {
  TOOL_THUMB_H,
  TOOL_THUMB_MAX,
  TOOL_THUMB_STRIP_H,
  TOOL_THUMB_W,
  toolThumbStrip
} from '@session-chat/components/rows/tools/tool/tool-images'
import type { ChatCommands } from '@session-chat/commands'
import type { ChatItem, ChatToolCall, ToolNode, ToolRunItem, TranscriptTurn } from '@session-chat/model'
import { flattenTier, toolRunId, type ItemNode } from '@session-chat/state/flatten'
import { toolRunUnitDef } from '@session-chat/components/rows/tool-run/tool-run.def'
import { unit, type ItemSegmenter, type SegmentCtx, type SegmentItem } from '@session-chat/core/units'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import { ROW_INSET_X } from '@session-chat/components/engine/row-metrics'
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract'

type Step = Parameters<typeof conversationStepData>[0]

const WIDTH = 720
const NARROW_WIDTH = 180

/** A real picture of `w`×`h`, the way a tool hands one back: a data URL the browser has to decode. */
function picture(w: number, h: number, colour: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w / 2, h / 3)
  return canvas.toDataURL('image/png')
}

const four = ['#e33', '#3e3', '#33e', '#ee3'].map((colour) => picture(390, 844, colour))
/** 148's cell: one call, many large pictures. */
const many = Array.from({ length: 12 }, (_, i) => picture(1600, 3200, `hsl(${i * 30} 70% 50%)`))

const tool = (id: string, extra: Partial<ChatToolCall>): ChatToolCall => ({
  kind: 'tool',
  id,
  name: 'MCP',
  status: 'done',
  inputSummary: 'gugu · app_check',
  ...extra
})

const appCheck = tool('contract-tool-images', { images: four, result: 'It loaded without errors.' })
const manyLarge = tool('contract-tool-images-many', { images: many })

/** Boxes, their largest painted size, the "+N" text and the img attributes, read off the live row. */
const readStrip: ContractInspector = (host) => {
  const strip = host.querySelector<HTMLElement>('[data-slot="tool-call-images"]')
  const boxes = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="tool-call-images"] button'))
  const imgs = Array.from(host.querySelectorAll<HTMLImageElement>('[data-slot="tool-call-images"] img'))
  const more = host.querySelector('[data-slot="tool-call-images-more"]')?.textContent ?? ''
  return {
    stripH: strip?.offsetHeight ?? 0,
    left: strip ? strip.getBoundingClientRect().left - host.getBoundingClientRect().left : -1,
    boxes: boxes.length,
    maxBoxW: Math.max(0, ...boxes.map((b) => b.getBoundingClientRect().width)),
    maxBoxH: Math.max(0, ...boxes.map((b) => b.getBoundingClientRect().height)),
    more: more ? Number(more.replace('+', '')) : 0,
    lazy: imgs.filter((img) => img.loading === 'lazy' && img.decoding === 'async').length
  }
}

describe('工具交回来的图:量出来的高 = 画出来的高,一张图多大都不改它', () => {
  it.each([
    { label: '四张(app_check 的形状),收着', data: appCheck, ctx: makeContractCtx({ width: WIDTH }) },
    {
      label: '四张,展开(入参与结果在缩略图下面)',
      data: { ...appCheck, request: '{"tool":"app_check","args":{"tab_kind":"op-probe.main"}}' },
      ctx: makeContractCtx({ width: WIDTH, isCollapsed: (id) => id === appCheck.id })
    },
    { label: '一次十二张 1600×3200 的大图', data: manyLarge, ctx: makeContractCtx({ width: WIDTH }) },
    { label: '窄到只放得下一个框', data: appCheck, ctx: makeContractCtx({ width: NARROW_WIDTH }) }
  ])('$label', async ({ label, data, ctx }) => {
    const reading = await renderAndMeasureUnit(toolUnitDef, data, ctx, readStrip)
    expect(reading.dom, `${label}: engine=${reading.computed} DOM=${reading.dom}`).toBe(reading.computed)
    expect(reading.inspected.stripH).toBe(TOOL_THUMB_STRIP_H)
    expect(reading.inspected.maxBoxW).toBeLessThanOrEqual(TOOL_THUMB_W)
    expect(reading.inspected.maxBoxH).toBeLessThanOrEqual(TOOL_THUMB_H)
    expect(reading.inspected.lazy).toBe(reading.inspected.boxes)
    expect(reading.spill, `${label} spills ${reading.spill}px`).toBe(0)
  })

  it('收着的行 = 头 + 一条缩略图,不多一像素;没交图的行(阴控)只有头,没有那一条', async () => {
    const withPictures = await renderAndMeasureUnit(toolUnitDef, appCheck, makeContractCtx({ width: WIDTH }), readStrip)
    expect(withPictures.computed).toBe(ROW_H + TOOL_THUMB_STRIP_H)
    const without = await renderAndMeasureUnit(
      toolUnitDef,
      tool('contract-tool-no-images', { result: 'ok' }),
      makeContractCtx({ width: WIDTH }),
      readStrip
    )
    expect(without.computed).toBe(ROW_H)
    expect(without.dom).toBe(ROW_H)
    expect(without.inspected.boxes).toBe(0)
  })

  it('很多大图:最多四个框,最后一个说还有几张;窄的时候框少,剩下的算进「+N」', async () => {
    const wide = await renderAndMeasureUnit(toolUnitDef, manyLarge, makeContractCtx({ width: WIDTH }), readStrip)
    expect(wide.inspected.boxes).toBe(TOOL_THUMB_MAX)
    expect(wide.inspected.more).toBe(many.length - TOOL_THUMB_MAX)
    const narrow = await renderAndMeasureUnit(toolUnitDef, appCheck, makeContractCtx({ width: NARROW_WIDTH }), readStrip)
    expect(narrow.inspected.boxes).toBe(1)
    expect(narrow.inspected.more).toBe(3)
  })

  it('lazy picture references reserve the same strip before bytes arrive', async () => {
    const lazy = tool('lazy-pictures', { imageCount: 12, transportNote: 'Output preview shortened.' })
    const ctx = makeContractCtx({ width: WIDTH, isCollapsed: id => id === lazy.id })
    const reading = await renderAndMeasureUnit(toolUnitDef, lazy, ctx, readStrip)
    expect(reading.dom).toBe(reading.computed)
    expect(reading.inspected.boxes).toBe(TOOL_THUMB_MAX)
    expect(reading.inspected.more).toBe(12 - TOOL_THUMB_MAX)
    expect(reading.spill).toBe(0)
  })

  it('一组里的子调用交了图:组量出来的高也算上那一条', async () => {
    const group: ItemNode = {
      item: tool('contract-images-group', { name: 'Read', status: 'running' }),
      children: [
        { item: tool('contract-images-group-0', {}), children: [] },
        { item: appCheck, children: [] }
      ]
    }
    const reading = await renderAndMeasureUnit(
      toolGroupUnitDef,
      group,
      makeContractCtx({ width: WIDTH, isCollapsed: (id) => id === 'contract-images-group' }),
      readStrip
    )
    expect(reading.dom).toBe(reading.computed)
    expect(reading.inspected.boxes).toBe(4)
  })
})

describe('点一张缩略图', () => {
  it('交给宿主:整组图(含没摆出来的那些)、从被点的这张起、带着这张缩略图;❌ 顺手开合这一行', async () => {
    const calls: Parameters<NonNullable<ChatCommands['onViewImages']>>[0][] = []
    const commands: ChatCommands = { onViewImages: (arg) => calls.push(arg) }
    let thumb: Element | null = null
    let inToggle = -1
    await renderAndMeasureUnit(
      toolUnitDef,
      { ...manyLarge, result: 'twelve pictures' },
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const boxes = host.querySelectorAll<HTMLButtonElement>('[data-slot="tool-call-images"] button')
        thumb = boxes[3].querySelector('img')
        // 行的开合是 ChatRoot 收点击、认 `closest('[data-collapse-id]')`(ChatRoot.tsx):缩略图得在那一格外面。
        // 阳控:这一行可以开合(有结果),它的头上确实挂着 data-collapse-id。
        inToggle = [...boxes].filter((box) => box.closest('[data-collapse-id]')).length
        if (!host.querySelector('[data-collapse-id]')) inToggle = -1
        boxes[3].click()
        return {}
      },
      commands
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ urls: many, index: 3, itemId: manyLarge.id, source: 'tool-result' })
    expect(calls[0].thumb).toBe(thumb)
    expect(inToggle).toBe(0)
  })
})

describe('transport picture loading', () => {
  it('waits for the shared viewport, resolves the gallery on click, clears recycled row pictures, keeps a reseeded one', async () => {
    const host = document.createElement('div')
    Object.assign(host.style, { position: 'fixed', top: '100000px', left: '0', width: '180px' })
    document.body.appendChild(host)
    const requests: string[] = []
    const viewed: Parameters<NonNullable<ChatCommands['onViewImages']>>[0][] = []
    let finishNext!: (value: string | null) => void
    const commands: ChatCommands = {
      resolveToolImage: async (id, index) => {
        requests.push(id + ':' + index)
        return id === 'next-picture' ? new Promise<string | null>(resolve => { finishNext = resolve }) : four[index]
      },
      onViewImages: arg => viewed.push(arg),
    }
    const [item, setItem] = createSignal(tool('lazy-picture', { imageCount: four.length }))
    const dispose = render(() => (
      <CommandsContext.Provider value={() => commands}>
        <Tool item={item()} collapsible={false} expanded={false}
          thumbs={toolThumbStrip(item().imageCount ?? 0, NARROW_WIDTH)}
          payload={null} codeLineH={20} />
      </CommandsContext.Provider>
    ), host)
    const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    try {
      await paint()
      expect(requests).toEqual([])
      host.style.top = '0px'
      await expect.poll(() => requests).toEqual(['lazy-picture:0'])
      await expect.poll(() => host.querySelector('img')?.getAttribute('src')).toBe(four[0])
      host.querySelector<HTMLButtonElement>('button')!.click()
      await expect.poll(() => viewed.length).toBe(1)
      expect(viewed[0]).toMatchObject({ urls: four, index: 0, itemId: 'lazy-picture' })
      expect(requests).toEqual(four.map((_, i) => 'lazy-picture:' + i))
      setItem(tool('next-picture', { imageCount: 1 }))
      await expect.poll(() => requests.at(-1)).toBe('next-picture:0')
      expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
      finishNext(four[1])
      await expect.poll(() => host.querySelector('img')?.getAttribute('src')).toBe(four[1])
      // A reseeded transcript hands the same call back as a new object: what is shown stays, nothing is fetched again.
      const asked = requests.length
      setItem(tool('next-picture', { imageCount: 1 }))
      await paint()
      expect(requests.length).toBe(asked)
      expect(host.querySelector('button')?.getAttribute('data-image-state')).toBe('ready')
    } finally {
      dispose()
      host.remove()
    }
  })
})

describe('transport picture loading: a reseed while the fetch is out', () => {
  it('asks again when the answer comes back empty after a reseed, and not when nothing moved', async () => {
    const host = document.createElement('div')
    Object.assign(host.style, { position: 'fixed', top: '0px', left: '0', width: '180px' })
    document.body.appendChild(host)
    const requests: string[] = []
    const answers: ((value: string | null) => void)[] = []
    const commands: ChatCommands = {
      resolveToolImage: (id, index) => {
        requests.push(id + ':' + index)
        return new Promise<string | null>(resolve => answers.push(resolve))
      },
    }
    const [item, setItem] = createSignal(tool('reseeded', { imageCount: 1 }))
    const dispose = render(() => (
      <CommandsContext.Provider value={() => commands}>
        <Tool item={item()} collapsible={false} expanded={false}
          thumbs={toolThumbStrip(1, NARROW_WIDTH)} payload={null} codeLineH={20} />
      </CommandsContext.Provider>
    ), host)
    const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const state = () => host.querySelector('button')?.getAttribute('data-image-state')
    try {
      await expect.poll(() => requests).toEqual(['reseeded:0'])
      // The store reloads its history while this fetch is out: the same call comes back as a new object, and the
      // fetch that was out answers empty (the store drops answers from before its reload).
      setItem(tool('reseeded', { imageCount: 1 }))
      answers[0](null)
      await expect.poll(() => requests).toEqual(['reseeded:0', 'reseeded:0'])
      answers[1](four[0])
      await expect.poll(state).toBe('ready')
      // A call whose picture really is gone is asked once.
      setItem(tool('gone', { imageCount: 1 }))
      await expect.poll(() => requests.length).toBe(3)
      answers[2](null)
      await paint()
      await paint()
      expect(requests.length).toBe(3)
      expect(state()).toBe('unavailable')
    } finally {
      dispose()
      host.remove()
    }
  })
})

// The task page draws every tool call as a conversation step, so a call's pictures have to be there too.
describe('conversation step: the same strip under the step line', () => {
  const translate = ((key: string) => key) as unknown as ChatTranslator
  const step = (extra: Partial<ToolNode> = {}) => conversationStepData({
    kind: 'unknown-tool-call', id: 'step', toolCallId: 'step', name: 'view_image', status: 'done',
    inputSummary: 'shot.png', ...extra
  } as Step, translate)

  it.each([
    { label: 'inline pictures', data: step({ images: [{ mimeType: 'image/png', data: four[0].split(',')[1] }] } as Partial<ToolNode>), boxes: 1, more: 0 },
    { label: 'pictures left behind by history', data: step({ imageRefs: Array.from({ length: 6 }, () => ({ mimeType: 'image/png', chars: 9 })) } as Partial<ToolNode>), boxes: TOOL_THUMB_MAX, more: 2 }
  ])('$label: reserved height = painted height', async ({ data, boxes, more }) => {
    const reading = await renderAndMeasureUnit(conversationStepUnitDef, data, makeContractCtx({ width: WIDTH }), readStrip)
    expect(reading.dom).toBe(reading.computed)
    expect(reading.computed).toBe(CONVERSATION_NARRATION_H + TOOL_THUMB_STRIP_H)
    expect(reading.inspected.boxes).toBe(boxes)
    expect(reading.inspected.more).toBe(more)
    expect(reading.spill).toBe(0)
  })

  it('a step without pictures keeps its one line', async () => {
    const reading = await renderAndMeasureUnit(conversationStepUnitDef, step(), makeContractCtx({ width: WIDTH }), readStrip)
    expect(reading.computed).toBe(CONVERSATION_NARRATION_H)
    expect(reading.inspected.boxes).toBe(0)
  })
})

// A finished turn folds its steps into one line ("读了 1 个文件"), so a step's pictures would be a click away again: the
// folded line carries the strip of its last step that has any; opened, the steps below draw their own.
describe('folded steps: the line carries the pictures', () => {
  const translate = ((key: string) => key) as unknown as ChatTranslator
  const read = (id: string, extra: Partial<ToolNode> = {}) => ({
    kind: 'read-tool-call', id, seq: 0, toolCallId: id, title: 'Read', path: `/work/${id}.png`, status: 'done',
    parentToolCallId: null, ...extra
  }) as unknown as ChatItem
  const inline = { images: [{ mimeType: 'image/png', data: four[0].split(',')[1] }] } as Partial<ToolNode>
  const turn = (items: ChatItem[]) => ({ id: 't', seq: 1, initiator: 'user', outcome: { kind: 'done' },
    items: [{ kind: 'message', id: 'u', seq: 0, role: 'user', text: 'look' }, ...items, { kind: 'message', id: 'r', seq: 0, role: 'assistant', text: 'seen' }]
  }) as unknown as TranscriptTurn
  const passthrough = (kind: string): ItemSegmenter => ({ kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] })
  const segmenters = Object.fromEntries(['message', 'read-tool-call', 'tool-run', 'turn-process', 'turn-outcome'].map((k) => [k, passthrough(k)]))
  const runOf = (items: ChatItem[], open: boolean) => flattenTier([turn(items)], {
    caches: {}, expanded: () => false, active: false, plan: () => null, translate, pendingToolCallIds: () => new Set<string>(),
    terminalSnapshot: () => null, agentConversation: true,
    // The turn's own process is open; only the run's fold is under test.
    isTurnProcessExpanded: (id: string) => id !== toolRunId('t', items[0].id) || open
  } as unknown as SegmentCtx, segmenters)
    // The conversation layout gathers a turn's steps into one block; the run is one of its units.
    .flatMap((u) => [u, ...((u.data as { units?: typeof u[] }).units ?? [])]).find((u) => u.kind === 'tool-run')?.data as ToolRunItem

  it('folded, the line holds the last step with pictures; opened, none', () => {
    const steps = [read('a', inline), read('b', inline), read('c')]
    expect(runOf(steps, false).pictureStep?.id).toBe('b')
    expect(runOf(steps, true).pictureStep).toBeUndefined()
    expect(runOf([read('c')], false).pictureStep).toBeUndefined()
  })

  const run = (pictureStep?: ToolNode): ToolRunItem => ({ kind: 'tool-run', id: 'run', turnId: 't', label: 'Read 1 file', stepCount: 1,
    ...(pictureStep ? { pictureStep } : {}) })
  const bare = run()
  it.each([
    { label: 'inline pictures', data: run(read('a', inline) as unknown as ToolNode), boxes: 1, more: 0 },
    { label: 'pictures left behind by history', data: run(read('a', { imageRefs: Array.from({ length: 6 }, () => ({ mimeType: 'image/png', chars: 9 })) } as Partial<ToolNode>) as unknown as ToolNode), boxes: TOOL_THUMB_MAX, more: 2 }
  ])('$label: reserved height = painted height, one strip taller than the bare line', async ({ data, boxes, more }) => {
    const plain = await renderAndMeasureUnit(toolRunUnitDef, bare, makeContractCtx({ width: WIDTH }), readStrip)
    const reading = await renderAndMeasureUnit(toolRunUnitDef, data, makeContractCtx({ width: WIDTH }), readStrip)
    expect(reading.dom).toBe(reading.computed)
    expect(reading.computed).toBe(plain.computed + TOOL_THUMB_STRIP_H)
    expect(plain.inspected.boxes).toBe(0)
    expect(reading.inspected.boxes).toBe(boxes)
    expect(reading.inspected.more).toBe(more)
    expect(reading.spill).toBe(0)
  })

  // Rows sit in their chrome: the tool-run line and a classic tool row are inset by ROW_INSET_X, a conversation step is not.
  it('opening the line moves the strip down only: same column as the opened row, in both layouts', async () => {
    const data = run(read('a', inline) as unknown as ToolNode)
    const conversation = { ...DEFAULT_THEME, layout: { ...DEFAULT_THEME.layout, agentConversation: true } }
    const foldedConversation = await renderAndMeasureUnit(toolRunUnitDef, data, makeContractCtx({ width: WIDTH, theme: conversation }), readStrip)
    const step = conversationStepData({ kind: 'read-tool-call', id: 'a', toolCallId: 'a', title: 'Read', path: '/work/a.png',
      status: 'done', ...inline } as unknown as Step, translate)
    const openedStep = await renderAndMeasureUnit(conversationStepUnitDef, step, makeContractCtx({ width: WIDTH, theme: conversation }), readStrip)
    expect(foldedConversation.inspected.left + ROW_INSET_X).toBe(openedStep.inspected.left)

    const foldedClassic = await renderAndMeasureUnit(toolRunUnitDef, data, makeContractCtx({ width: WIDTH }), readStrip)
    const openedTool = await renderAndMeasureUnit(toolUnitDef, tool('a', { images: [four[0]] }), makeContractCtx({ width: WIDTH }), readStrip)
    expect(foldedClassic.inspected.left + ROW_INSET_X).toBe(openedTool.inspected.left + ROW_INSET_X)
    for (const reading of [foldedConversation, foldedClassic]) expect(reading.dom).toBe(reading.computed)
  })

  it('narrow: still one strip, as many boxes as the width holds', async () => {
    const data = run(read('a', { images: four.map((url) => ({ mimeType: 'image/png', data: url.split(',')[1] })) } as Partial<ToolNode>) as unknown as ToolNode)
    const reading = await renderAndMeasureUnit(toolRunUnitDef, data, makeContractCtx({ width: NARROW_WIDTH }), readStrip)
    expect(reading.dom).toBe(reading.computed)
    expect(reading.inspected.boxes).toBe(1)
    expect(reading.inspected.more).toBe(3)
  })
})
