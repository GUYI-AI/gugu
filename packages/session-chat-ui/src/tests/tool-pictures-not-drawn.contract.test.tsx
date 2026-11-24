/** @jsxImportSource solid-js */
/**
 * Pictures a tool call's result handed back are not drawn in the run details: a step that returned pictures is the same
 * text row, and the same height, as one that returned none — folded into a line or opened, running or finished, in the
 * classic and the conversation layout. The pictures the person sends with a message still show.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import { createChatState } from '@session-chat/state/chat-state'
import { toolRunId } from '@session-chat/state/flatten'
import type { ChatLayout } from '@session-chat/core/layout/preset'
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model'
import { plainMessageBody } from './fixtures/plain-message-body'

const WIDTH = 720
const TURN = 'tool-pictures'
const WARM = 'open-page'
const READ = 'read-shot'

function picture(colour: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 390
  canvas.height = 844
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, 390, 844)
  return canvas.toDataURL('image/png')
}
const sent = picture('#3a3')
const shot = picture('#e33').slice('data:image/png;base64,'.length)

/** The person sends a picture; the agent opens a page, then checks it and gets a screenshot back (inline `images`, and
 * the history's `imageRefs`). Two steps, so they fold into one line. */
function turn(active: boolean, withPictures: boolean): TranscriptTurn {
  const pictures = withPictures
    ? { images: [{ mimeType: 'image/png', data: shot }], imageRefs: [{ mimeType: 'image/png', chars: shot.length }] }
    : {}
  return {
    id: TURN, seq: 0, initiator: 'user', startedAt: 1000,
    ...(!active ? { endedAt: 4000, outcome: { kind: 'done' as const } } : {}),
    items: [
      { kind: 'message', id: 'ask', seq: 0, role: 'user', text: 'Check the login page',
        attachments: [{ id: 'sent-image', name: 'login.png', mimeType: 'image/png' }] } as TranscriptItem,
      { kind: 'mcp-tool-call', id: WARM, seq: 1, toolCallId: WARM, title: 'app_open', server: 'gugu', tool: 'app_open',
        status: 'done', at: 1500, completedAt: 1800, parentToolCallId: null } as unknown as TranscriptItem,
      { kind: 'mcp-tool-call', id: READ, seq: 2, toolCallId: READ, title: 'app_check', server: 'gugu', tool: 'app_check',
        status: 'done', at: 2000, completedAt: 2500, parentToolCallId: null, ...pictures } as unknown as TranscriptItem,
      ...(!active ? [{ kind: 'message', id: 'reply', seq: 3, role: 'assistant', text: 'The login page loads.' } as TranscriptItem] : []),
    ],
  }
}

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined })

async function mount(layout: ChatLayout, opts: { active: boolean; openRun: boolean; withPictures: boolean }) {
  await page.viewport(WIDTH, 720)
  const context = createChatContext({ locale: () => 'en-US', layout })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;top:0;left:0;width:${WIDTH}px;height:640px;background:var(--chat-bg);color:var(--chat-fg)`
  document.body.append(host)
  const view = createChatView({ context, state, parent: host, commands: {
    resolveAttachment: async () => sent, onMessageBodyMount: plainMessageBody, conversationAgentName: () => 'Fixture agent',
  } })
  dispose = () => { view.dispose(); state.dispose(); context.dispose(); host.remove() }
  if (opts.active) state.transcript.activeTurn.set(turn(true, opts.withPictures))
  else state.transcript.history.seed([turn(false, opts.withPictures)])
  if (!opts.active) state.viewState.setCollapsed(`${TURN}:process`, true)
  if (opts.openRun) state.viewState.setCollapsed(toolRunId(TURN, WARM), true)
  return host
}

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1))
  step(n)
})

async function read(layout: ChatLayout, opts: { active: boolean; openRun: boolean; withPictures: boolean }) {
  const host = await mount(layout, opts)
  // The row that carries the step: the folded line when there is one and it is closed, else the step's own row.
  const folded = `[data-item-id="${toolRunId(TURN, WARM)}"]`
  const own = `[data-item-id="${READ}"]`
  const find = () => (!opts.openRun ? host.querySelector<HTMLElement>(folded) : null) ?? host.querySelector<HTMLElement>(own)
  await expect.poll(find).not.toBeNull()
  await expect.poll(() => host.querySelector('[data-attachment-chip] img')?.getAttribute('src')).toBe(sent)
  await frames(4)
  const row = find()!
  const out = {
    height: row.getBoundingClientRect().height,
    stepImages: row.querySelectorAll('img').length,
    allImages: Array.from(host.querySelectorAll('img')).map((img) => img.getAttribute('src')),
  }
  dispose?.()
  dispose = undefined
  return out
}

const layouts: Array<{ label: string; layout: ChatLayout }> = [
  { label: 'classic', layout: { preset: 'single', userGutter: 0 } },
  { label: 'conversation', layout: { preset: 'double', userGutter: 0, agentConversation: true } },
]
const cases = [
  { label: 'finished turn, steps folded into one line', active: false, openRun: false },
  { label: 'finished turn, the line opened into its steps', active: false, openRun: true },
  { label: 'the agent is still running', active: true, openRun: false },
]

describe('tool pictures are not drawn in run details', () => {
  for (const { label: layoutLabel, layout } of layouts) {
    it.each(cases)(`${layoutLabel}: $label`, async ({ active, openRun }) => {
      const shown = await read(layout, { active, openRun, withPictures: true })
      const bare = await read(layout, { active, openRun, withPictures: false })
      expect(shown.stepImages, 'a picture was drawn under the step').toBe(0)
      expect(shown.height, 'the step reserves room for its pictures').toBe(bare.height)
      expect(shown.allImages, 'only the sent picture is drawn').toEqual([sent])
    })
  }
})
