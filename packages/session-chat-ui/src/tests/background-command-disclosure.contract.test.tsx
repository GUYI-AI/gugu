
import type { ChatCommands } from '@session-chat/commands'
import { backgroundTasksUnitDef } from '@session-chat/components/rows/background-tasks/background-tasks.def'
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster'
import type { BackgroundTasksItem,  } from '@session-chat/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
