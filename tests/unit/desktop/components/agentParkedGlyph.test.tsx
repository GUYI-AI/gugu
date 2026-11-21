// @vitest-environment jsdom
// Background running (working · parked) is two yellow bars (owner 2026-11-20: the still orange dot read as the red
// error dot). Every surface that draws the state draws the same AgentParkedGlyph, never a dot; the bars sit on whole
// pixels so they stay two bars at the list badge size on 1× and 2× screens.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { AgentParkedGlyph } from '../../../../apps/desktop/src/components/AgentParkedGlyph'
import { AgentContactStatusMark } from '../../../../apps/desktop/src/components/AgentContactStatusMark'
import { AgentContactStatusChip } from '../../../../apps/desktop/src/components/contactsDetailControls'
import { agentContactAvatarBadgeClass } from '../../../../apps/desktop/src/components/contactAgentTone'
import { AgentStatusGlyph } from '../../../../apps/desktop/src/session/renderer/lib/components/agent-status-indicator'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { createNode, createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, () => {})
})
afterEach(() => {
  harness.cleanup()
  publishIdentityDirectory(null, null)
})

const glyphs = () => harness.container.querySelectorAll('[data-agent-status-glyph="parked"]')

describe('background running draws AgentParkedGlyph on every surface', () => {
  it.each([
    ['avatar badge', () => createNode(Avatar, { name: 'Agent', seed: 'agent-1', size: 32, isAgent: true, harnessBadge: false, agentStatus: 'parked' })],
    ['session page row', () => {
      const presentation = presentAgentStatus({ reading: { status: 'working', detail: 'parked' } })
      return createNode(AgentStatusGlyph, { presentation, label: presentation.label })
    }],
    ['contact row mark', () => createNode(AgentContactStatusMark, { tone: 'parked' })],
    ['contact detail chip', () => createNode(AgentContactStatusChip, { agentId: 'agent-1', tone: 'parked', label: 'Running in background' })],
  ] as const)('%s', async (_surface, node) => {
    await harness.render(node())
    expect(glyphs()).toHaveLength(1)
    // none of the dots / spinners the other states draw on these surfaces
    expect(harness.container.querySelector('.av-status__dot, .cli-spinner, .gg-c-st-dot-mark, [class~="h-[6px]"]')).toBeNull()
  })

  it('the contact row adds no pseudo-element dot of its own for parked', () => {
    expect(agentContactAvatarBadgeClass('parked')).toBe('')
  })
})

describe('AgentParkedGlyph geometry', () => {
  const rects = () => [...glyphs()[0]!.querySelectorAll('rect')].map((rect) =>
    ['x', 'y', 'width', 'height'].map((name) => Number(rect.getAttribute(name))))

  it('list badge size: 2 px bars, a 2 px gap, 6 px tall', async () => {
    await harness.render(createNode(AgentParkedGlyph, { size: 10 }))
    expect(rects()).toEqual([[2, 2, 2, 6], [6, 2, 2, 6]])
  })

  it.each([8, 9, 10, 11, 12, 13, 14, 15, 16])('size %i: whole pixels, two separate bars inside the box', async (size) => {
    await harness.render(createNode(AgentParkedGlyph, { size }))
    const [a, b] = rects()
    for (const [x, y, width, height] of [a!, b!]) {
      for (const value of [x, y, width, height]) expect(Number.isInteger(value)).toBe(true)
      expect(x! + width!).toBeLessThanOrEqual(size)
      expect(y! + height!).toBeLessThanOrEqual(size)
    }
    expect(b![0]! - (a![0]! + a![2]!)).toBe(a![2])
  })
})
