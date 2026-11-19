import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_UPLOAD_IDLE_MS, AttachmentDeadlineError, runAttachmentStage } from '@gugu/core/cloud/attachmentDeadline'
import { uploadAttachmentPlan, type AttachmentUploadTransport } from '@gugu/core/cloud/attachmentsApi'
import { withServerClock } from '@gugu/core/shared/serverClock'

afterEach(() => vi.useRealTimers())

describe('attachment write inactivity', () => {
  it('resets the idle timer only when the request advances', async () => {
    vi.useFakeTimers()
    let progress!: (sent: number, total: number) => void
    let requestSignal!: AbortSignal
    const result = runAttachmentStage('upload', (signal, _cap, advance) => {
      requestSignal = signal
      progress = advance
      return new Promise(() => {})
    }, undefined, { timeoutMs: null, watchUpload: true })
    const failed = expect(result).rejects.toBeInstanceOf(AttachmentDeadlineError)
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_MS - 1)
    progress(1, 4)
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_MS - 1)
    expect(requestSignal.aborted).toBe(false)
    progress(1, 4)
    progress(0, 4)
    await vi.advanceTimersByTimeAsync(1)
    await failed
  })

  it('stops watching writes after the full body has been accepted', async () => {
    vi.useFakeTimers()
    const response = Promise.withResolvers<string>()
    const result = runAttachmentStage('upload', (_signal, _cap, progress) => {
      progress(4, 4)
      return response.promise
    }, undefined, { timeoutMs: null, watchUpload: true })
    await vi.advanceTimersByTimeAsync(2 * ATTACHMENT_UPLOAD_IDLE_MS)
    response.resolve('stored')
    await expect(result).resolves.toBe('stored')
  })
})

// An upload permit's `expires_at` is on the backend's clock; the stage deadline runs on this device's (`@@@server-clock`).
describe('attachment upload permit expiry, with this device’s clock off the backend’s', () => {
  const SERVER = Date.parse('2026-11-16T12:00:00.000Z')
  const FAST = (4 * 60 + 17) * 60_000, SLOW = -4 * 60 * 60_000
  const file = { bytes: new Uint8Array([1, 2, 3]), name: 'a.bin', contentType: 'application/octet-stream' }
  const plan = (lifetimeMs: number) => ({ url: 'https://storage.test/put', method: 'PUT' as const, fields: {}, max_bytes: 1024, expires_at: new Date(SERVER + lifetimeMs).toISOString() })
  async function skewed(skew: number) {
    vi.useFakeTimers()
    vi.setSystemTime(SERVER + skew)
    await withServerClock(async (_url: string) => new Response('[]', { headers: { date: new Date(SERVER).toUTCString() } }))('https://db.test/rest/v1/ping')
  }
  const endpoint = (upload: AttachmentUploadTransport) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'user', upload })

  it('a clock 4 h 17 min fast neither refuses a fresh permit nor aborts its upload', async () => {
    await skewed(FAST)
    const done = uploadAttachmentPlan(endpoint(async (_url, _init, progress) => {
      progress?.({ loaded: 3, total: 3 })
      await new Promise(resolve => setTimeout(resolve, 5_000))
      return { status: 200 }
    }), plan(10 * 60_000), file)
    let outcome: unknown = 'pending'
    const settled = done.then(() => { outcome = 'uploaded' }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(outcome).toBe('uploaded')
    await settled
  })

  it('a clock 4 h slow refuses a permit the backend already expired', async () => {
    await skewed(SLOW)
    const upload = vi.fn()
    await expect(uploadAttachmentPlan(endpoint(upload), plan(-1_000), file)).rejects.toMatchObject({ code: 'expired' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('a clock 4 h slow still stops at the permit’s expiry', async () => {
    await skewed(SLOW)
    let outcome: unknown = 'pending'
    const settled = uploadAttachmentPlan(endpoint((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })), plan(10_000), file).then(() => { outcome = 'uploaded' }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(10_500)
    expect(outcome).toMatchObject({ code: 'expired' })
    await settled
  })
})
