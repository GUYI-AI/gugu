import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_UPLOAD_IDLE_MS, AttachmentDeadlineError, runAttachmentStage } from '@gugu/core/cloud/attachmentDeadline'

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
