// 设备能力缺授权时,在调用它的 agent 的会话里发起一次审批(Ask source device-capability):答「允许」= 连上那一组再继续;
// 不允许 / 没人答 / 调用没了 都如实说;不是本机会话(unavailable)就交回设备自己的 not_granted。
import { describe, expect, it, vi } from 'vitest'
import { askForCapability } from '../../../../apps/desktop/electron/device-actions/capability-ask'

const missing = { group: 'perf', groupTitle: { 'zh-CN': '性能读数', 'en-US': 'Performance' } }
function setup(answer: unknown, connected: unknown = { ok: true }) {
  const ask = vi.fn(async () => answer)
  const runtime = { ungrantedGroup: vi.fn(() => missing), connect: vi.fn(async () => connected) }
  const run = () => askForCapability({ sessionId: 's1', action: 'perf.capture', requester: { name: 'Kip', agentUserId: 'u1' }, runtime: runtime as never, ask: ask as never })
  return { ask, runtime, run }
}

describe('device capability ask', () => {
  it('asks in the calling session with the shape the notification list reads, and connects on 允许', async () => {
    const { ask, runtime, run } = setup({ optionId: 'allow', by: 'mobile' })
    expect(await run()).toBeNull()
    expect(ask).toHaveBeenCalledWith('s1', expect.objectContaining({
      kind: 'permission',
      title: 'Kip wants to use "Performance" on this computer',
      options: [expect.objectContaining({ optionId: 'allow', kind: 'allow_always' }), expect.objectContaining({ optionId: 'decline', kind: 'reject_once' })],
      origin: { source: 'device-capability', payload: { group: 'perf', groupTitle: missing.groupTitle, action: 'perf.capture', requester: { name: 'Kip', agentUserId: 'u1' } } },
    }), {})
    expect(runtime.connect).toHaveBeenCalledWith('perf')
  })

  it('nothing missing: no ask', async () => {
    const { ask, runtime, run } = setup({ optionId: 'allow', by: 'desktop' })
    runtime.ungrantedGroup.mockReturnValue(null as never)
    expect(await run()).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('declined, timed out, withdrawn: stops with why; nothing connected', async () => {
    for (const [answer, code, text] of [
      [{ optionId: 'decline', by: 'desktop' }, 'not_granted', 'declined'],
      ['timeout', 'not_granted', 'Nobody answered'],
      ['withdrawn', 'execution_failed', 'withdrawn'],
    ] as const) {
      const { runtime, run } = setup(answer)
      expect(await run()).toMatchObject({ code, message: expect.stringContaining(text) })
      expect(runtime.connect).not.toHaveBeenCalled()
    }
  })

  it('not a session here: hands back to the device (its own not_granted says where to connect)', async () => {
    expect(await setup('unavailable').run()).toBeNull()
  })

  it('allowed but the OS refused: os_permission, said as it is', async () => {
    const { run } = setup({ optionId: 'allow', by: 'desktop' }, { ok: false, code: 'os_permission', message: 'Screen Recording is off' })
    expect(await run()).toMatchObject({ code: 'os_permission', message: expect.stringContaining('Screen Recording is off') })
  })
})
