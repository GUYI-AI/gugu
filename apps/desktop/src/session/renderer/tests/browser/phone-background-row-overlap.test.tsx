import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { LocalizationProvider, getLocaleSnapshot, setLocalePreference } from '@/i18n'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-look.css'

/*
 * A phone task conversation while the agent works with one background subagent: the process header
 * 「执行中 · 4s · 1 步」, the pill 「后台 · 1 个子智能体 ›」 and the row 「跑了 1 条命令」 under it. The pill was drawn over the
 * header (same y, its last glyph wrapped onto a second line) and the row below was placed as if it had no height.
 */

let h: ReturnType<typeof createReactHarness>
const previousLocale = getLocaleSnapshot().preference
const cleanups: (() => void)[] = []
beforeEach(() => { h = createReactHarness() })
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  h.cleanup()
  setLocalePreference(previousLocale)
})

const NOW = Date.now()
const user = (id: string, text: string) => ({ kind: 'message' as const, role: 'user' as const, id, seq: 0, text, _meta: { guguClientMessageId: id, guguNativeMessageId: `p-${id}` } })
const earlier = (): TranscriptTurn => ({ id: 'turn:s0', seq: 0, initiator: 'user', startedAt: NOW - 90_000, endedAt: NOW - 60_000, outcome: { kind: 'done' },
  items: [user('u0', '先看一下这个问题'), { kind: 'message', role: 'assistant', id: 'a0', seq: 1, text: '好的,我来看。' }] })
const working = (): TranscriptTurn => ({ id: 'live:1', seq: 1, initiator: 'user', startedAt: NOW - 4000, items: [
  user('u1', '帮我查一下'),
  { kind: 'execute-tool-call', id: 'live:1:tool', seq: 1, toolCallId: 'call-1', title: 'sleep', status: 'running', command: 'sleep 30', at: NOW - 3000 },
] })

const overlap = (a: DOMRect, b: DOMRect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

async function mount(width: number, turns: TranscriptTurn[]) {
  setLocalePreference('zh-CN')
  await page.viewport(width, 844)
  h.container.style.cssText = `height:700px;width:${width}px;display:flex;flex-direction:column`
  h.container.setAttribute('data-phone-shell', '')
  await h.render(<LocalizationProvider>
    <SessionTranscriptView uri={`phone-background-row-${width}-${turns.length}`} turns={turns} mobile
      backgroundTasks={{ commands: [], subagents: [{ id: 's1', launchToolCallId: 'launch', name: '调研', completedSteps: 0, calls: [], elapsedMs: 4000, startedAt: NOW - 4000 }] }} />
  </LocalizationProvider>)
  await until('the background pill and the command row under it are drawn',
    () => !!h.container.querySelector('[data-slot="background-tasks-pill"]') && !!h.container.querySelector('[data-row-kind="tool-run"]'))
}

function read() {
  const q = (selector: string) => h.container.querySelector<HTMLElement>(selector)!
  const pill = q('[data-slot="background-tasks-pill"]')
  const processRow = q('[data-slot="turn-process"]')
  const row = processRow.getBoundingClientRect()
  const proc = q('[data-conversation-process]').getBoundingClientRect()
  const text = pill.firstElementChild!.getBoundingClientRect()
  const below = q('[data-row-kind="tool-run"]').getBoundingClientRect()
  let bottom = 0
  for (const element of processRow.querySelectorAll('*')) bottom = Math.max(bottom, element.getBoundingClientRect().bottom)
  const half = (value: number) => Math.round(value * 2) / 2
  return {
    text: pill.textContent,
    textLines: Math.round(text.height / 22),
    textOnProcess: overlap(text, proc),
    pillOnProcess: overlap(pill.getBoundingClientRect(), proc),
    paintBelowRow: half(Math.max(0, bottom - row.bottom)),
    rowOnBelow: half(Math.max(0, row.bottom - below.top)),
  }
}

const sound = { textLines: 1, textOnProcess: 0, pillOnProcess: 0, paintBelowRow: 0, rowOnBelow: 0 }

for (const width of [340, 360, 375, 390, 412, 430]) {
  for (const [label, turns] of [['a first turn', () => [working()]], ['a continued conversation', () => [earlier(), working()]]] as const) {
    it(`draws the background pill under the process header, not over it, on ${label} at ${width}px`, async () => {
      await mount(width, turns())
      expect(read()).toMatchObject({ text: '后台 · 1 个子智能体›', ...sound })
    })
  }

  it(`keeps the pill on one line when the phone paints its glyphs a hair wider than they were measured, at ${width}px`, async () => {
    // Not a different font: letter-spacing is not part of the engine's measure, so this is the device's few hundredths of a pixel.
    const wider = document.head.appendChild(document.createElement('style'))
    wider.textContent = '[data-slot="background-tasks-pill"] { letter-spacing: 0.02px; }'
    cleanups.push(() => wider.remove())
    await mount(width, [earlier(), working()])
    expect(read()).toMatchObject(sound)
  })
}
