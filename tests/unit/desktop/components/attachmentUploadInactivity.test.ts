// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentSendTiming, attachmentUploadTimeoutMs, AttachmentStageTimeout } from '../../../../apps/desktop/src/lib/attachmentSendTiming'
import { withServerClock } from '@gugu/core/shared/serverClock'

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
afterEach(() => vi.useRealTimers())

describe('attachment upload inactivity (#1002)', () => {
  it('allows 25 seconds for connection and preflight before the first bytes', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      async (_signal, _cap, progress) => {
        await new Promise(resolve => setTimeout(resolve, 25_000))
        progress(32_768, 65_536)
        await new Promise(resolve => setTimeout(resolve, 10_000))
        progress(65_536, 65_536)
        await new Promise(resolve => setTimeout(resolve, 5_000))
        return 'uploaded'
      }).then(value => { outcome = value }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(40_000)
    await done
    expect(outcome).toBe('uploaded')
  })

  it('times out a 64 KiB upload without a response 20 seconds after its last bytes', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      (_signal, _cap, progress) => {
        progress(65_536, 65_536)
        return new Promise(() => {})
      }).catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(20_001)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })

  it('allows a response within the short post-byte deadline', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      async (_signal, _cap, progress) => {
        progress(1_048_576, 1_048_576)
        await new Promise(resolve => setTimeout(resolve, 18_000))
        return 'committed'
      }).then(value => { outcome = value }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(18_000)
    await done
    expect(outcome).toBe('committed')
  })

  it('does not count repeated zero-byte events as progress', async () => {
    vi.useFakeTimers()
    let progress!: (sent: number) => void
    const done = attachmentSendTiming('m', 'c').stage('upload', 1,
      (_signal, _cap, report) => { progress = report; return new Promise(() => {}) }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(5000); progress(0) }
    await vi.advanceTimersByTimeAsync(5000)
    expect(await done).toBeInstanceOf(AttachmentStageTimeout)
  })
  it('fails a 1 MiB attempt promptly when it never makes any progress', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      () => new Promise(() => {}), undefined, { timeoutMs: attachmentUploadTimeoutMs(1_048_576) })
      .catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })

  it('keeps the size allowance while bytes continue advancing, then fails when they stop', async () => {
    vi.useFakeTimers()
    let progress!: (sent: number) => void
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      (_signal, _cap, report) => { progress = report; return new Promise(() => {}) },
      undefined, { timeoutMs: attachmentUploadTimeoutMs(1_048_576) })
      .catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(1)
    for (let sent = 1; sent <= 5; sent++) {
      await vi.advanceTimersByTimeAsync(10_000)
      progress(sent * 64 * 1024)
      expect(outcome).toBe('pending')
    }
    await vi.advanceTimersByTimeAsync(15_001)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })
})

// The upload permit's `expires_at` is on the backend's clock; the stage deadline runs on this device's.
describe('attachment upload permit expiry, with this device’s clock off the backend’s', () => {
  const SERVER = Date.parse('2026-11-16T12:00:00.000Z')
  async function skewed(skew: number) {
    vi.useFakeTimers()
    vi.setSystemTime(SERVER + skew)
    await withServerClock(async (_url: string) => new Response('[]', { headers: { date: new Date(SERVER).toUTCString() } }))('https://db.test/rest/v1/ping')
  }

  it('a clock 4 h 17 min fast does not abort the upload the moment its permit arrives', async () => {
    await skewed((4 * 60 + 17) * 60_000)
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      async (_signal, cap, progress) => {
        cap(new Date(SERVER + 10 * 60_000).toISOString())
        progress(65_536, 65_536)
        await new Promise(resolve => setTimeout(resolve, 5_000))
        return 'uploaded'
      }).then(value => { outcome = value }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(5_000)
    await done
    expect(outcome).toBe('uploaded')
  })

  it('a clock 4 h slow still stops at the permit’s expiry', async () => {
    await skewed(-4 * 60 * 60_000)
    let outcome: unknown = 'pending'
    const done = attachmentSendTiming('message', 'chat').stage('upload', 1,
      (_signal, cap, progress) => {
        cap(new Date(SERVER + 10_000).toISOString())
        progress(0, 65_536)
        return new Promise(() => {})
      }).catch(error => { outcome = error })
    await vi.advanceTimersByTimeAsync(10_500)
    expect(outcome).toBeInstanceOf(AttachmentStageTimeout)
    await done
  })
})
