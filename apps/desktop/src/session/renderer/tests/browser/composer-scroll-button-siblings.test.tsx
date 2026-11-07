import { mountComposerBandFrame } from '../../../../../../../tests/fixtures/composer-band-scroll/mount'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AgentFailureSlot } from '@/components/AgentFailureSlot'
import { AgentTurnFailureBar } from '@/components/AgentTurnFailureBar'
import { ConversationCreditNotice } from '@/components/chat/ConversationCreditNotice'
import { SessionInputQueue } from '@/components/chat/SessionInputQueue'
import { SessionHostQuestion } from '@renderer/features/extensions/session-host-question'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { type FrameOptions } from '../../../../../../../tests/fixtures/composer-band-scroll/frame'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerSettingsCatalog'

// External data sources only: the band components, portals and CSS stay real.
vi.mock('@/lib/billing', async original => ({ ...(await original<object>()), useSpendingPower: () => ({ power: { spendable: 0.5 } }) }))
vi.mock('@renderer/features/extensions/use-session-host-ask', () => ({ useSessionHostAsk: () => ({
  itemId: 'controlled-question', kind: 'question', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
  origin: { source: 'agent-question' }, questions: [{ question: 'Controlled layout question?', multiSelect: false, options: [{ optionId: 'a', name: 'Choice A' }] }],
}) }))

let host: HTMLDivElement | undefined
let fixture: ReturnType<typeof mountComposerBandFrame> | undefined
afterEach(() => {
  fixture?.dispose(); host?.remove(); fixture = undefined; host = undefined
  publishSelfIdentity(null)
  Object.assign(state(), { accountId: null, rows: EMPTY, valid: () => false }); changed()
})

function FailureBand() {
  const [slot, setSlot] = useState<Element | null>(null)
  useLayoutEffect(() => { setSlot(host!.querySelector('[data-agent-failure-slot]')) }, [])
  return <><AgentFailureSlot agentUserId="controlled-layout-agent" />{slot ? createPortal(<AgentTurnFailureBar
    failure={{ agentUserId: 'controlled-layout-agent', commandId: 'controlled-command', departed: false, at: 1, reason: 'generic' }}
    displayName="Controlled layout agent" avatar={null} onDismiss={() => {}} />, slot) : null}</>
}

async function mount(options: FrameOptions, selector: string) {
  await page.viewport(900, 800)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;top:180px;left:80px;width:640px'
  fixture = mountComposerBandFrame(host, options)
  await until('actual sibling band and recovery button mounted', () => !!host!.querySelector(selector)?.textContent && !!host!.querySelector('[data-slot="aui-thread-scroll-to-bottom"] button'))
  await untilStable('sibling layout painted', () => [...host!.querySelectorAll(`${selector}, [data-slot="aui-thread-scroll-to-bottom"]`)].map(node => node.getBoundingClientRect().top))
}

async function expectClear(selector: string) {
  const band = host!.querySelector(selector)!.getBoundingClientRect()
  const button = host!.querySelector<HTMLButtonElement>('[data-slot="aui-thread-scroll-to-bottom"] button')!
  const rect = button.getBoundingClientRect()
  expect(band.height, 'the real band must have content and height').toBeGreaterThan(0)
  expect(rect.bottom, 'the whole button clears the topmost content band').toBeLessThanOrEqual(band.top + 1)
  for (const fraction of [.15, .5, .85]) expect(button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * fraction))).toBe(true)
  await page.getByRole('button', { name: 'Return to bottom', exact: true }).click()
}

it.each(['failure', 'credit', 'pending', 'question'] as const)('clears the real %s sibling band', async kind => {
  publishSelfIdentity({ userId: 'controlled-layout-owner', displayName: null, guguNumber: null })
  Object.assign(state(), { accountId: 'controlled-layout-owner', valid: () => true, rows: [{
    id: 'controlled-pending', accountId: 'controlled-layout-owner', deviceId: 'controlled-host', sessionId: 'controlled-layout', text: 'Controlled pending input', createdAt: 1,
  }] })
  const bands: Record<typeof kind, [ReactNode, string]> = {
    failure: [<FailureBand />, '[data-agent-failure-slot]'],
    credit: [<ConversationCreditNotice modelOptionId="platform:test" />, '[data-testid="conversation-credit-notice"]'],
    pending: [<SessionInputQueue sessionId="controlled-layout" waitingForConnection />, '[data-native-input-queue]'],
    question: [<SessionHostQuestion sessionId="controlled-layout" session={{ status: 'needs_user', detail: 'question' }} />, '[data-testid="session-host-question"]'],
  }
  const [band, selector] = bands[kind]
  await mount({ band }, selector)
  await expectClear(selector)
})

it.each(['permission', 'notice'] as const)('clears the real composer %s band', async kind => {
  const composerProps: FrameOptions['composerProps'] = kind === 'permission'
    ? { permissionRequest: { requestId: 'controlled', title: 'Controlled permission', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] }, onResolvePermission: () => {} }
    : { notice: { variant: 'error', title: 'Controlled notice', message: 'Controlled layout evidence' } }
  const selector = `[data-slot="composer-${kind === 'permission' ? 'permission-request' : 'notice'}"]`
  await mount({ composerProps }, selector)
  await expectClear(selector)
})

it('keeps an empty failure portal at the original no-band position', async () => {
  await mount({ band: <AgentFailureSlot agentUserId="controlled-empty-slot" /> }, '[data-slot="composer"]')
  const button = host!.querySelector('button.aui-thread-scroll-to-bottom')!.getBoundingClientRect()
  const composer = host!.querySelector('[data-slot="composer"]')!.getBoundingClientRect()
  expect(button.bottom - composer.top).toBeCloseTo(button.height / 2, 0)
})

it('does not treat a retained but hidden notice as a visible band', async () => {
  await mount({ composerProps: { notice: { variant: 'error', message: 'Controlled notice' } } }, '[data-slot="composer-notice"]')
  fixture!.render({ composerProps: { notice: null } })
  await until('notice is marked hidden', () => host!.querySelector('[aria-hidden="true"]') !== null && host!.querySelector('[data-composer-top-band]') === null)
  await untilStable('notice closing transition finished', () => host!.querySelector('[data-slot="composer"]')!.getBoundingClientRect().top)
  const button = host!.querySelector('button.aui-thread-scroll-to-bottom')!.getBoundingClientRect()
  const composer = host!.querySelector('[data-slot="composer"]')!.getBoundingClientRect()
  expect(host!.querySelector('[data-slot="composer-notice"]'), 'the retained content remains mounted').not.toBeNull()
  expect(button.bottom - composer.top).toBeCloseTo(button.height / 2, 0)
})
