// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { JoinGroupById } from '../../../../apps/desktop/src/components/contacts/JoinGroupById'
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import { createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

const input = () => harness.container.querySelector('[data-testid="join-group-id-input"]') as HTMLInputElement
const $ = (testId: string) => harness.container.querySelector(`[data-testid="${testId}"]`)
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
const group = { id: 'g1', public_id: 229136, kind: 'group' as const, name: 'Design crit', member_count: 2, is_member: false, is_muted: null, join_mode: 'approval' as const, join_request_status: null }

// 群号边打边查:群号从 200001 起,不到 6 位不查;停顿后才查;不是数字就当场说清该填什么,❌ 按 Enter 静默。
describe('JoinGroupById looks a group up as the number is typed', () => {
  it('waits for a full group number and the pause, then shows the group', async () => {
    const lookup = vi.spyOn(contactsService, 'lookupPublicGroupInvite').mockResolvedValue({ status: 'available', group } as never)
    await renderWithAppProviders(harness, createNode(JoinGroupById, {}), { contacts: {} })
    await typeInto(input(), '2291')
    await pause(500)
    expect(lookup).not.toHaveBeenCalled()
    await typeInto(input(), '229136')
    expect(lookup).not.toHaveBeenCalled()
    await waitForCondition(() => $('join-group-result') !== null, 'group not shown after the pause')
    expect(lookup).toHaveBeenCalledWith(229136)
    expect($('join-group-result')?.textContent).toContain('Design crit')
  })

  it('says what a group number looks like instead of ignoring letters', async () => {
    const lookup = vi.spyOn(contactsService, 'lookupPublicGroupInvite')
    await renderWithAppProviders(harness, createNode(JoinGroupById, {}), { contacts: {} })
    await typeInto(input(), 'abc')
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect($('join-group-invalid')).not.toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})
