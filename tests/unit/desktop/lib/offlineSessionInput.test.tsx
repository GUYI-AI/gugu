// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer } from '../../../support/composerEditor'
import { stubVisibleIntersection } from '../../../support/visibleIntersection'
import { OutboxHost as SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useOutboxHost'
import { installOutboxCore } from '../../../helpers/sessionInputOutbox'
import { SessionTimelinePage } from '../../../../apps/desktop/src/components/session-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/components/session-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { handoffNativeComposer } from '../../../../apps/desktop/src/lib/nativeComposerHandoff'
const scope = vi.hoisted(() => ({ pendingPrompt: null as import('@session-chat/state/pending-prompt').PendingPrompt | null, devices: [{ device_id: 'offline-host', is_online: false, capabilities: {} }] }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', async original => ({ ...await original<object>(), getRendererSession: () => ({ user: { id: 'offline-owner' } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => false, readMobileShell: () => false }))
vi.mock('../../../../apps/desktop/src/components/session-watch/sessionpage-rpc', () => ({ SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})), setSessionOption: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/session-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: ({ composerContent, pendingPrompt }: { composerContent: import('react').ReactNode; pendingPrompt: import('@session-chat/state/pending-prompt').PendingPrompt | null }) => { scope.pendingPrompt = pendingPrompt; return <div>{composerContent}</div> } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions', async (importOriginal) => ({ ...await importOriginal<object>(), useInstalledApps: () => ({ state: 'value', value: { enabledTabContributions: [] }, stale: false, error: null }) }))
vi.mock('../../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', async original => ({ ...await original<object>(), translateSessionMessage: () => 'Waiting for host' }))
vi.mock('../../../../apps/desktop/src/lib/outbox/kinds/assistantNotice', () => ({ assistantNoticeOutboxKind: { name: 'assistantNotice', lane: () => 'assistant', send: async () => {} } }))
vi.mock('../../../../apps/desktop/src/lib/outbox/legacy', () => ({ importLegacyWrites: async () => {} }))
const harness = createReactHarness()
// The window's one outbox for this account (the app's follows the replica's account).
let core: ReturnType<typeof installOutboxCore> | undefined
afterEach(() => { core?.dispose(); core = undefined; harness.cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
it('accepts and visibly retains a native message without any mounted remote workspace', async () => {
  stubVisibleIntersection()
  core = installOutboxCore({ accountId: 'offline-owner' })
  const session = { conversationId: 'cold-session', projectId: 'project', title: 'Offline task', runtime: 'acp', nativeInputVersion: 2, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <><SessionInputOutboxHost accountId="offline-owner" /><SessionTimelinePage device={device('offline-host', [], { is_online: false })} session={session} onBack={() => {}} /></>)
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  await vi.waitFor(() => expect(field()).not.toBeNull())
  await act(async () => { await handoffNativeComposer('cold-session', { text: 'Send when the host returns' }) })
  await vi.waitFor(() => expect(readComposer(field())).toBe('Send when the host returns'))
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!.click() })
  await vi.waitFor(() => expect(scope.pendingPrompt).toMatchObject({ text: 'Send when the host returns', delivery: { state: 'waiting', retryable: false } }))
  expect(scope.pendingPrompt?.delivery).toMatchObject({ state: 'waiting', error: expect.any(String), reason: expect.any(String) })
  // The transcript owns this ordinary input, so the footer must not draw a second copy.
  expect(harness.container.querySelector('[data-native-input-id]')).toBeNull()
  expect(readComposer(field())).toBe('')
})
