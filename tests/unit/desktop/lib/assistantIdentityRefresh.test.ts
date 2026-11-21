// The personal assistant marker (replica `myAssistant`, signal tier): this device's own provision / move / close writes
// read it again (`myAssistant.refresh`), a refresh during an older read reads once more, and it follows the account.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProvisionRow } from '@/lib/assistantProvision'

const reads = vi.hoisted(() => [] as Array<{ owner: string; finish: (rows: unknown[]) => void }>)
vi.mock('@/lib/supabase', () => ({
  identityDb: {
    from: () => ({ select: () => ({ eq: () => ({
      eq: (_field: string, owner: string) => new Promise(resolve => {
        reads.push({ owner, finish: rows => resolve({ data: rows, error: null }) })
      }),
    }) }) }),
  },
}))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const { myAssistant } = await import('@/lib/myAssistant')
const { publishRendererSession } = await import('@/lib/sessionPublication')
const signIn = (id: string) => publishRendererSession('SIGNED_IN', { user: { id }, access_token: 't' } as never)
const row = (phase: AssistantProvisionRow['phase']): AssistantProvisionRow => ({
  agent_user_id: 'same-agent', agent: { removed_at: null }, device_id: 'same-cloud', member_key: 'assistant', phase, created_at: '2026-10-24T00:00:00Z',
})
const agentNow = () => { const r = myAssistant.peek(); return r.state === 'value' ? r.value.agentId : r.state }

describe('assistant identity completion refresh', () => {
  beforeEach(() => { reads.length = 0; signIn('previous'); signIn('owner') })

  it('re-reads the completed marker even when retry kept the same contact and device', async () => {
    const first = myAssistant.fetch()
    reads[0]!.finish([row('failed')])
    await first
    expect(agentNow()).toBeNull()
    // Fresh for a minute: without the completion refresh the next look would not read again.
    await myAssistant.fetch()
    expect(reads).toHaveLength(1)
    await myAssistant.refresh()
    const after = myAssistant.fetch()
    reads[1]!.finish([row('completed')])
    await after
    expect(agentNow()).toBe('same-agent')
  })

  it('a completion refresh during an older read reads once more (❌ dropped behind it)', async () => {
    const first = myAssistant.fetch().catch(() => undefined)
    const refreshed = myAssistant.refresh()
    reads[0]!.finish([row('failed')])
    await first
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.finish([row('completed')])
    await refreshed
    expect(agentNow()).toBe('same-agent')
  })

  it('reads for the account signed in; another account starts unknown', async () => {
    const mine = myAssistant.fetch()
    expect(reads.map(read => read.owner)).toEqual(['owner'])
    reads[0]!.finish([row('completed')])
    await mine
    expect(agentNow()).toBe('same-agent')
    signIn('other-owner')
    expect(agentNow()).toBe('unknown')
  })

  it('forgets a closed identity after refresh while its provision remains completed', async () => {
    const first = myAssistant.fetch()
    reads[0]!.finish([row('completed')])
    await first
    expect(agentNow()).toBe('same-agent')
    await myAssistant.refresh()
    const again = myAssistant.fetch()
    reads[1]!.finish([{ ...row('completed'), agent: { removed_at: '2026-11-02T15:06:41Z' } }])
    await again
    expect(agentNow()).toBeNull()
  })
})
