import { describe, expect, it } from 'vitest'
import type { TimelineBatch, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { applyBatch, applySnapshot, emptyAgentWatchTimeline } from '../../../../../src/mobile/agent-watch/agent-watch-store'

const step = (toolCallId: string, status: 'running' | 'done') =>
  ({ kind: 'read-tool-call' as const, id: toolCallId, seq: 0, toolCallId, title: toolCallId, status })
const cursor = (seq: number) => ({ epoch: 'e', seq })
const batch = (from: number, subagents: TimelineBatch['subagents']): TimelineBatch =>
  ({ from, cursor: cursor(from + 1), turns: [], removedTurnIds: [], settlements: [], subagents })

/** #2500: the phone keeps each running subagent's calls and merges the changed ones a batch brings. */
describe('subagent steps in the phone timeline', () => {
  it('replaces a changed call in place, appends a new one, keeps unchanged text, and drops a settled subagent', () => {
    const snapshot: TimelineSnapshot = { cursor: cursor(1), turns: [], settlements: [], hasOlder: false,
      subagents: [{ toolCallId: 'launch', completedSteps: 1, steps: [step('a', 'done'), step('b', 'running')], reasoning: 'thinking' }] }
    let state = applySnapshot(emptyAgentWatchTimeline(), snapshot)
    expect(state.subagents[0]!.steps.map((s) => 'toolCallId' in s && [s.toolCallId, s.status])).toEqual([['a', 'done'], ['b', 'running']])

    state = applyBatch(state, batch(1, [{ toolCallId: 'launch', completedSteps: 2, steps: [step('b', 'done'), step('c', 'running')] }]))
    expect(state.subagents).toEqual([{ toolCallId: 'launch', completedSteps: 2, reasoning: 'thinking',
      steps: [step('a', 'done'), step('b', 'done'), step('c', 'running')] }])

    state = applyBatch(state, batch(2, [{ toolCallId: 'launch', completedSteps: 2, steps: [], output: 'so far' }]))
    expect(state.subagents[0]).toMatchObject({ output: 'so far', reasoning: 'thinking' })
    expect(state.subagents[0]!.steps).toHaveLength(3)

    state = applyBatch(state, batch(3, []))
    expect(state.subagents).toEqual([])
  })

  it('keeps what it holds when an older host sends no subagents field', () => {
    const snapshot: TimelineSnapshot = { cursor: cursor(1), turns: [], settlements: [], hasOlder: false,
      subagents: [{ toolCallId: 'launch', completedSteps: 0, steps: [step('a', 'running')] }] }
    const state = applyBatch(applySnapshot(emptyAgentWatchTimeline(), snapshot), batch(1, undefined))
    expect(state.subagents).toHaveLength(1)
  })
})
