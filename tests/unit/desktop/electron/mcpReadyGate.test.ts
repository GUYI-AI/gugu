import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guguMcpToolsListedGate, hostedMcpToolsListedGate } from '../../../../apps/desktop/electron/sessionpage/mcp-ready-gate'

function source() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    onToolsListed(key: string, listener: () => void) {
      const set = listeners.get(key) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(key, set)
      return () => { set.delete(listener) }
    },
    list(key: string) { for (const listener of [...(listeners.get(key) ?? [])]) listener() },
    count(key: string) { return listeners.get(key)?.size ?? 0 },
  }
}

describe('guguMcpToolsListedGate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens exactly when this grant lists its tools, and unsubscribes', async () => {
    const host = source()
    let opened = false
    const gate = guguMcpToolsListedGate(host, 'grant-A', 'conv-A').then(() => { opened = true })
    host.list('grant-B')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(opened).toBe(false)
    host.list('grant-A')
    await gate
    expect(opened).toBe(true)
    expect(host.count('grant-A')).toBe(0)
  })

  it('opens at the budget when tools/list never comes, so messages are not stuck forever', async () => {
    const host = source()
    let opened = false
    void guguMcpToolsListedGate(host, 'grant-A', 'conv-A', 5_000).then(() => { opened = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(opened).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened).toBe(true)
    expect(host.count('grant-A')).toBe(0)
  })
})

describe('hostedMcpToolsListedGate (#4038)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const hosted = (urls: Record<string, string>) => ({ ...source(), grantKeyFor: (url: string) => urls[url] })
  const servers = [
    { url: 'http://127.0.0.1:1/a', owner: 'gugu' },
    { url: 'http://127.0.0.1:2/b', owner: 'integration' },
    { url: 'https://example.invalid/mcp', owner: 'integration' },
    { owner: 'user' },
  ]

  it('waits for every server Gugu hosts, and for none it cannot see', async () => {
    const gugu = hosted({ 'http://127.0.0.1:1/a': 'conv' })
    const apps = hosted({ 'http://127.0.0.1:2/b': 'conv:browser' })
    let opened = false
    const gate = hostedMcpToolsListedGate([gugu, null, apps], servers, 'conv')().then(() => { opened = true })
    gugu.list('conv')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(opened).toBe(false)
    apps.list('conv:browser')
    await gate
    expect(opened).toBe(true)
  })

  it('waits for Gugu\'s own server longer than for the others', async () => {
    const gugu = hosted({ 'http://127.0.0.1:1/a': 'conv' })
    const apps = hosted({ 'http://127.0.0.1:2/b': 'conv:browser' })
    let opened = false
    void hostedMcpToolsListedGate([gugu, apps], servers, 'conv')().then(() => { opened = true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(apps.count('conv:browser')).toBe(0)
    expect(gugu.count('conv')).toBe(1)
    expect(opened).toBe(false)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(opened).toBe(true)
  })

  it('subscribes at once but starts the budget only when the wait begins', async () => {
    const gugu = hosted({ 'http://127.0.0.1:1/a': 'conv' })
    const apps = hosted({ 'http://127.0.0.1:2/b': 'conv:browser' })
    const wait = hostedMcpToolsListedGate([gugu, apps], servers, 'conv')
    // The engine starts and replays for longer than any budget; a list that arrives meanwhile counts.
    await vi.advanceTimersByTimeAsync(120_000)
    gugu.list('conv')
    expect(apps.count('conv:browser')).toBe(1)
    let opened = false
    void wait().then(() => { opened = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(opened).toBe(false)
    apps.list('conv:browser')
    await vi.advanceTimersByTimeAsync(0)
    expect(opened).toBe(true)
  })
})
