// @vitest-environment jsdom
// Background running (working · parked) is the running glyph held still (owner 2026-11-23: the snake turning = running,
// the snake stopped = running out of sight). Every surface that draws the state draws the same AgentParkedGlyph, never
// a dot and never the turning glyph.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { AgentParkedGlyph } from '../../../../apps/desktop/src/components/AgentParkedGlyph'
import { AgentContactStatusMark } from '../../../../apps/desktop/src/components/AgentContactStatusMark'
import { AgentContactStatusChip } from '../../../../apps/desktop/src/components/contactsDetailControls'
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
    ['avatar badge', () => createNode(Avatar, { name: 'Agent', seed: 'agent-1', size: 32, isAgent: true, agentStatus: 'parked' })],
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
    expect(harness.container.querySelector('.av-status__dot, .gg-running-glyph:not(.gg-running-glyph--still), .gg-c-st-dot-mark, [class~="h-[6px]"]')).toBeNull()
  })

  it('is the running glyph with its motion taken away', async () => {
    await harness.render(createNode(AgentParkedGlyph, { size: 10 }))
    const glyph = glyphs()[0]!
    expect(glyph.className).toBe('gg-running-glyph gg-running-glyph--still')
    expect(glyph.querySelector('.gg-running-glyph__strip')).not.toBeNull()
    expect((glyph as HTMLElement).style.fontSize).toBe('10px')
  })
})
