/** @jsxImportSource solid-js */
/**
 * #2594: on the phone, pictures a tool call's result handed back are not drawn and not fetched. The host says so with
 * `ChatLayout.hideToolPictures`; then no strip under a process step or a folded step line, no height reserved for one,
 * and `resolveToolImage` is never asked. Without it (the desktop) the strip is drawn and fetched as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import { createChatState } from '@session-chat/state/chat-state'
import { toolRunId } from '@session-chat/state/flatten'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { ChatLayout } from '@session-chat/core/layout/preset'
import type { ChatTranslator } from '@session-chat/localization'
import type { UnitDef } from '@session-chat/core/units'
import type { ChatToolCall, ToolNode, ToolRunItem, TranscriptItem, TranscriptTurn } from '@session-chat/model'
import { toolRunUnitDef } from '@session-chat/components/rows/tool-run/tool-run.def'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { conversationStepData, conversationStepUnitDef } from '@session-chat/components/rows/conversation-step/conversation-step.def'
import { TOOL_THUMB_STRIP_H } from '@session-chat/components/rows/tools/tool/tool-images'
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract'
import { plainMessageBody } from './fixtures/plain-message-body'

const PHONE_W = 390
const STRIP = '[data-slot="tool-call-images"]'
const conversation: ChatLayout = { preset: 'double', userGutter: 0, agentConversation: true }
const phone: ChatLayout = { ...conversation, hideToolPictures: true }

/** A real picture, the way a tool hands one back. */
function picture(colour: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 390
  canvas.height = 844
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, 390, 844)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 195, 280)
  return canvas.toDataURL('image/png')
}
const shots = ['#e33', '#3a3', '#33e'].map(picture)
const refs = shots.map(() => ({ mimeType: 'image/png', chars: 9 }))

const TURN = 'phone-pictures'
const READ = 'read-shot'
/** The agent reads a screenshot while it works: the history hands the phone only the pictures' count (`imageRefs`). */
function turn(active: boolean): TranscriptTurn {
  return {
    id: TURN, seq: 0, initiator: 'user', startedAt: 1000,
    ...(!active ? { endedAt: 4000, outcome: { kind: 'done' as const } } : {}),
    items: [
      { kind: 'message', id: 'ask', seq: 0, role: 'user', text: 'Check the login page' } as TranscriptItem,
      { kind: 'read-tool-call', id: READ, seq: 1, toolCallId: READ, title: 'Read', path: '/work/login.png', status: 'done',
        at: 2000, completedAt: 2500, parentToolCallId: null, imageRefs: refs } as unknown as TranscriptItem,
      ...(!active ? [{ kind: 'message', id: 'reply', seq: 2, role: 'assistant', text: 'The login page loads.' } as TranscriptItem] : []),
    ],
  }
}

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined })

async function mount(layout: ChatLayout, opts: { active: boolean; openRun: boolean }) {
  await page.viewport(PHONE_W, 720)
  const context = createChatContext({ locale: () => 'en-US', layout })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;top:0;left:0;width:${PHONE_W}px;height:640px;background:var(--chat-bg);color:var(--chat-fg)`
  document.body.append(host)
  const resolveToolImage = vi.fn(async (_id: string, index: number) => shots[index] ?? null)
  const view = createChatView({ context, state, parent: host,
    commands: { resolveToolImage, onMessageBodyMount: plainMessageBody, conversationAgentName: () => 'Fixture agent' } })
  dispose = () => { view.dispose(); state.dispose(); context.dispose(); host.remove() }
  if (opts.active) state.transcript.activeTurn.set(turn(true))
  else state.transcript.history.seed([turn(false)])
  // The turn's process is open (that is where the pictures showed): a running one is open by default, a finished one is
  // opened here. The run inside it is folded or opened per case.
  if (!opts.active) state.viewState.setCollapsed(`${TURN}:process`, true)
  if (opts.openRun) state.viewState.setCollapsed(toolRunId(TURN, READ), true)
  return { host, resolveToolImage }
}

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1))
  step(n)
})
/** The step is on screen: the folded line, or the opened step itself. */
const stepShown = (host: HTMLElement, openRun: boolean) =>
  !!host.querySelector(openRun ? `[data-conversation-step="${READ}"]` : '[data-slot="tool-run"]')

const cases = [
  { label: 'finished turn, steps folded into one line', active: false, openRun: false },
  { label: 'finished turn, the line opened into its steps', active: false, openRun: true },
  { label: 'the agent is still running', active: true, openRun: false },
]

describe('#2594 phone: process pictures are not drawn or fetched', () => {
  it.each(cases)('desktop (no flag) still draws and fetches them: $label', async ({ active, openRun }) => {
    const { host, resolveToolImage } = await mount(conversation, { active, openRun })
    await expect.poll(() => host.querySelectorAll(STRIP).length).toBe(1)
    await expect.poll(() => resolveToolImage.mock.calls.length).toBeGreaterThan(0)
    await expect.poll(() => host.querySelector(`${STRIP} img`)?.getAttribute('src')).toBe(shots[0])
    if (!active && !openRun) await page.screenshot({ element: host, path: '__screenshots__/mobile-process-pictures/before.png' })
  })

  it.each(cases)('phone (hideToolPictures): no strip, nothing fetched: $label', async ({ active, openRun }) => {
    const { host, resolveToolImage } = await mount(phone, { active, openRun })
    await expect.poll(() => stepShown(host, openRun)).toBe(true)
    // Long enough for the strip to have mounted, been seen by the viewport observer and asked (the desktop case above).
    await frames(6)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(host.querySelectorAll(STRIP)).toHaveLength(0)
    expect(resolveToolImage).not.toHaveBeenCalled()
    if (!active && !openRun) await page.screenshot({ element: host, path: '__screenshots__/mobile-process-pictures/after.png' })
  })
})

describe('#2594 phone: no height is reserved for the hidden strip', () => {
  const translate = ((key: string) => key) as unknown as ChatTranslator
  const phoneCtx = () => makeContractCtx({ width: PHONE_W, theme: { ...DEFAULT_THEME, layout: phone } })
  const desktopCtx = () => makeContractCtx({ width: PHONE_W, theme: { ...DEFAULT_THEME, layout: conversation } })
  const strip: ContractInspector = (host) => ({ boxes: host.querySelectorAll(`${STRIP} button`).length })
  const read = (extra: object) => ({ kind: 'read-tool-call', id: READ, toolCallId: READ, title: 'Read', path: '/work/login.png',
    status: 'done', parentToolCallId: null, ...extra }) as unknown as ToolNode
  const run = (pictureStep?: ToolNode): ToolRunItem => ({ kind: 'tool-run', id: 'run', turnId: TURN, label: 'Read 1 file', stepCount: 1,
    ...(pictureStep ? { pictureStep } : {}) })
  const step = (node: ToolNode) => conversationStepData(node as Parameters<typeof conversationStepData>[0], translate)
  const tool = (extra: Partial<ChatToolCall>): ChatToolCall => ({ kind: 'tool', id: 'tool', name: 'MCP', status: 'done', inputSummary: 'app_check', ...extra })

  /** Same height as the row without pictures, painted as measured, no boxes; the desktop still adds one strip. */
  async function expectHidden<D, V extends Record<string, number>>(def: UnitDef<D, V>, withPictures: D, without: D) {
    const hidden = await renderAndMeasureUnit(def, withPictures, phoneCtx(), strip)
    const bare = await renderAndMeasureUnit(def, without, phoneCtx(), strip)
    const desktop = await renderAndMeasureUnit(def, withPictures, desktopCtx(), strip)
    expect(hidden.computed).toBe(bare.computed)
    expect(hidden.dom).toBe(hidden.computed)
    expect(hidden.inspected.boxes).toBe(0)
    expect(desktop.computed).toBe(bare.computed + TOOL_THUMB_STRIP_H)
    expect(desktop.inspected.boxes).toBeGreaterThan(0)
  }

  it('folded step line', () => expectHidden(toolRunUnitDef, run(read({ imageRefs: refs })), run()))
  it('conversation step', () => expectHidden(conversationStepUnitDef, step(read({ imageRefs: refs })), step(read({}))))
  it('classic tool row', () => expectHidden(toolUnitDef, tool({ imageCount: refs.length }), tool({})))
})
