import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import type { ChatCommands } from '@session-chat/commands'
import { BACKGROUND_TASK_ROW_H } from '@session-chat/components/rows/background-tasks/background-tasks-parts'
import { backgroundTasksUnitDef } from '@session-chat/components/rows/background-tasks/background-tasks.def'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster'
import type { BackgroundTasksItem, TranscriptTurn } from '@session-chat/model'
import { createChatState } from '@session-chat/state/chat-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../tests/support/awaitCondition'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

/**
 * owner 2026-11-12 真窗口:「这个命令行怎么是全部内容展示,不渐进披露吗,这样也太长了」——
 * 后台单子里一条命令把整条 shell 原样铺了七八行,同一张单子里子智能体只占一行名字。
 *
 * 钉的是:收着恒一行(有说明写说明,没有写命令第一行,放不下省略号);有东西藏着才能点开,点开就地写全、
 * 再点收回;停止 / × 不顺带开合;每种开合、每种宽度 measure 都等于画出来的 offsetHeight。
 */
const teardown: Array<() => void> = []
afterEach(() => {
  while (teardown.length) teardown.pop()?.()
})

/** 截图里那条:一句 description,命令本身三行、一行比单子还宽。 */
const relaunchCommand = [
  'cd ~/projects/gugu/.claude/worktrees/desktop-sidebar && GUGU_DATA_DIR=/tmp/gugu-iso GUGU_PROFILE=iso \\',
  '  pnpm --filter @gugu/desktop dev -- --user-data-dir=/tmp/gugu-iso/electron > /tmp/gugu-iso/dev.log 2>&1 &',
  'echo started',
].join('\n')

const described: BackgroundCommandEntry = {
  id: 'relaunch', launchToolCallId: 'toolu_relaunch', taskId: 'task-relaunch', name: relaunchCommand, summary: 'Relaunch isolated dev app',
}
/** 没给说明、一行放不下的命令。 */
const bare: BackgroundCommandEntry = {
  id: 'bare', launchToolCallId: 'toolu_bare', taskId: 'task-bare',
  name: 'node scripts/watch/very-long-script-name.mjs --input /tmp/some/really/long/input/path --output /tmp/another/long/output/path --retries 5',
}
/** 一行放得下、也没说明:没东西可藏,就不是开关。 */
const short: BackgroundCommandEntry = { id: 'short', launchToolCallId: 'toolu_short', taskId: 'task-short', name: 'pnpm test' }

const flat = (text: string | null | undefined) => (text ?? '').replace(/\n/g, '')

function mount(commands: ChatCommands = {}) {
  const context = createChatContext({ locale: () => 'en-US', theme: DEFAULT_THEME })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:640px;height:600px'
  document.body.append(host)
  const view = createChatView({ context, state, parent: host, commands })
  teardown.push(() => {
    view.dispose()
    state.dispose()
    context.dispose()
    host.remove()
  })
  return { state, host }
}

const settled: TranscriptTurn = {
  id: 't1', seq: 0, initiator: 'user', startedAt: Date.now() - 60_000,
  items: [
    { kind: 'message', id: 'q', seq: 0, role: 'user', text: 'Relaunch the app in the background.' },
    { kind: 'message', id: 'a', seq: 1, role: 'assistant', text: 'Relaunched; it keeps running.' },
  ],
}

const toggleOf = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('[data-slot="background-task-toggle"]') ?? null

describe('a background command in the list discloses progressively', () => {
  it('is one line until opened: the summary, or the command\'s first line cut with an ellipsis', async () => {
    const onStopBackgroundTask = vi.fn()
    const { state, host } = mount({ onStopBackgroundTask, onDismissBackgroundTask: vi.fn() })
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [described, bare, short], subagents: [] })
    await until('the background line is on screen', () => host.querySelector('[data-slot="background-tasks"]') !== null)
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')!.click()
    await until('the list opens', () => host.querySelectorAll('[data-slot="background-task"]').length === 3)

    const [describedRow, bareRow, shortRow] = [...host.querySelectorAll<HTMLElement>('[data-slot="background-task"]')]
    // 收着:三条都是一行高,❌ 七八行。
    for (const row of [describedRow, bareRow, shortRow]) expect(row.offsetHeight).toBe(BACKGROUND_TASK_ROW_H)
    // 有说明:写说明,命令一个字都不铺;悬停给整条命令。
    expect(describedRow.textContent).toContain('Relaunch isolated dev app')
    expect(describedRow.textContent).not.toContain('pnpm --filter')
    expect(describedRow.title).toBe(relaunchCommand)
    // 没说明:命令第一行,一行放不下省略号收尾(字比框宽,但框只有一行)。
    const bareToggle = toggleOf(bareRow)!
    expect(bareToggle.textContent).toBe(bare.name)
    expect(getComputedStyle(bareToggle).textOverflow).toBe('ellipsis')
    expect(bareToggle.scrollWidth).toBeGreaterThan(bareToggle.clientWidth)
    // 放得下又没说明:没东西可藏,不是开关。
    expect(toggleOf(shortRow)).toBeNull()
    expect(shortRow.textContent).toContain('pnpm test')

    // 停止不顺带开合。
    describedRow.querySelector<HTMLElement>('button[aria-label="Stop this background command"]')!.click()
    expect(onStopBackgroundTask).toHaveBeenCalledWith({ stopId: 'task-relaunch' })
    await new Promise((r) => setTimeout(r, 50))
    expect(toggleOf(host.querySelectorAll<HTMLElement>('[data-slot="background-task"]')[0])!.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens in place to the whole command and folds back on a second click', async () => {
    const { state, host } = mount({ onStopBackgroundTask: vi.fn(), onDismissBackgroundTask: vi.fn() })
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [described, bare], subagents: [] })
    await until('the background line is on screen', () => host.querySelector('[data-slot="background-tasks"]') !== null)
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')!.click()
    await until('the list opens', () => host.querySelectorAll('[data-slot="background-task"]').length === 2)

    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-slot="background-task"]')]
    toggleOf(rows()[0])!.click()
    await until('the described command opens', () => rows()[0].dataset.open !== undefined)
    // 说明留在上面(开关就是它),整条命令写在下面,一个字不少。
    expect(toggleOf(rows()[0])!.textContent).toBe('Relaunch isolated dev app')
    expect(flat(rows()[0].querySelector('[data-slot="background-task-command"]')?.textContent)).toBe(flat(relaunchCommand))
    expect(toggleOf(rows()[0])!.getAttribute('aria-expanded')).toBe('true')
    expect(rows()[0].offsetHeight).toBeGreaterThan(BACKGROUND_TASK_ROW_H)
    // 写全了就不再叠系统提示。
    expect(rows()[0].title).toBe('')
    // 另一条不受影响。
    expect(rows()[1].dataset.open).toBeUndefined()
    expect(rows()[1].offsetHeight).toBe(BACKGROUND_TASK_ROW_H)

    toggleOf(rows()[1])!.click()
    await until('the bare command opens', () => rows()[1].dataset.open !== undefined)
    // 没说明:开关那一行说「后台命令」(执行卡片「执行」+ 命令同一个样子),整条命令写在下面,一个字不少。
    expect(toggleOf(rows()[1])!.textContent).toBe('Background command')
    const bareCommand = rows()[1].querySelector<HTMLElement>('[data-slot="background-task-command"]')!
    expect(flat(bareCommand.textContent)).toBe(bare.name)
    // 整条命令不在按钮里:选得中、能复制,读屏也不会把它当按钮名念;点它不会顺带收起。
    expect(bareCommand.closest('button')).toBeNull()
    expect(getComputedStyle(bareCommand).userSelect).not.toBe('none')
    expect(toggleOf(rows()[1])!.getAttribute('aria-expanded')).toBe('true')
    bareCommand.click()
    await new Promise((r) => setTimeout(r, 50))
    expect(rows()[1].dataset.open).toBeDefined()
    // 列表与「后台」那一行都长高接住它,❌ 被行根的 overflow 裁掉。
    const list = host.querySelector<HTMLElement>('[data-slot="background-tasks"]')!
    expect(rows()[1].getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 0.5)

    toggleOf(rows()[0])!.click()
    await until('a second click folds it back to one line', () => rows()[0].dataset.open === undefined)
    expect(rows()[0].offsetHeight).toBe(BACKGROUND_TASK_ROW_H)
  })
})

describe('background command rows keep measure() === offsetHeight', () => {
  const item = (commands: BackgroundCommandEntry[]): BackgroundTasksItem => ({
    kind: 'background-tasks', id: 'background-tasks', commands, subagents: [], expanded: true,
  })
  /** Windows 那边来的命令带 CRLF:\r 量与画各算各的会让行高对不上。 */
  const crlf: BackgroundCommandEntry = { id: 'crlf', launchToolCallId: 'toolu_crlf', taskId: 'task-crlf', name: relaunchCommand.replace(/\n/g, '\r\n'), open: true }
  const variants: Array<[string, BackgroundCommandEntry[]]> = [
    ['all folded', [described, bare, short]],
    ['described open', [{ ...described, open: true }, bare, short]],
    ['bare open', [described, { ...bare, open: true }, short]],
    ['all open', [{ ...described, open: true }, { ...bare, open: true }, { ...short, open: true }]],
    ['crlf open', [crlf]],
  ]
  const hostCommands: Array<[string, ChatCommands]> = [
    ['no controls', {}],
    ['stop and dismiss', { onStopBackgroundTask: vi.fn(), onDismissBackgroundTask: vi.fn() }],
  ]

  it('at every width a phone, a narrow pane or a wide window has', async () => {
    const bad: string[] = []
    for (const width of [240, 300, 360, 390, 430, 520, 640, 900]) {
      for (const [variant, commands] of variants) {
        for (const [controls, cmds] of hostCommands) {
          const reading = await renderAndMeasureUnit(backgroundTasksUnitDef, item(commands), makeContractCtx({ width }), (host) => ({
            // 点开的那一格字没长出框:框按量出的行数排,字也正好那么多行。
            clipped: [...host.querySelectorAll<HTMLElement>('[data-slot="background-task-toggle"][aria-expanded="true"], [data-slot="background-task-command"]')]
              .filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).length,
          }), cmds)
          if (reading.dom !== reading.computed || reading.inspected.clipped) {
            bad.push(`${width}px ${variant} (${controls}): dom ${reading.dom} measured ${reading.computed}, clipped ${reading.inspected.clipped}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  // 停止键 4 + 14 + 4 = 22 高、一行量的是 20:原来每条带停止键的行(命令与子智能体同一颗)都比量的高 2px,
  // 单子底下被行根的 overflow 裁掉。子智能体那一行也钉一遍。
  it('a cancellable subagent row is no taller than measured either', async () => {
    const bad: string[] = []
    const subagent = { id: 'agent', launchToolCallId: 'toolu_agent', name: 'Audit chat perf', completedSteps: 3, calls: [], elapsedMs: 30_000, startedAt: Date.now() - 30_000, canCancel: true }
    for (const width of [300, 390, 640]) {
      const reading = await renderAndMeasureUnit(backgroundTasksUnitDef, { ...item([short]), subagents: [subagent] }, makeContractCtx({ width }), undefined,
        { onStopBackgroundTask: vi.fn(), onDismissBackgroundTask: vi.fn() })
      if (reading.dom !== reading.computed) bad.push(`${width}px: dom ${reading.dom} measured ${reading.computed}`)
    }
    expect(bad).toEqual([])
  })
})
