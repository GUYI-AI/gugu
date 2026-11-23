import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { drawImagePreviews, withUploadedAttachment } from '../../../../packages/core/src/cloud/attachmentsApi'

// Every uploading process registers a drawer; this one never finishes a preview, so only the upload's own requests are seen.
drawImagePreviews({ draw: () => new Promise(() => {}), warn: () => {} })

// The upload alone: `use` hands back its key.
const uploadAttachmentBytes = (...[endpoint, file, scope, options]: [Parameters<typeof withUploadedAttachment>[0], Parameters<typeof withUploadedAttachment>[1], Parameters<typeof withUploadedAttachment>[2], Parameters<typeof withUploadedAttachment>[4]?]) =>
  withUploadedAttachment(endpoint, file, scope, async key => key, options)

describe('attachment upload transports', () => {
  it.each([{ retry: false, request_id: 'reservation' }, { retry: true, request_id: undefined }])('does not accept a storage conflict without a retry of the same reservation (%j)', async options => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024,
    }))).mockResolvedValueOnce(new Response(null, { status: 409 }))
    await expect(uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'chat', as: 'sender', request_id: options.request_id }, { retry: options.retry })).rejects.toThrow('409')
  })
  it('reports the signed expiry before transferring bytes and preserves the reservation ID', async () => {
    const plan = { staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024, expires_at: '2030-01-01T01:00:00Z' }
    const onPlan = vi.fn()
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/upload')) {
        expect(JSON.parse(init.body as string).request_id).toBe('reservation-id')
        return new Response(JSON.stringify(plan))
      }
      expect(onPlan).toHaveBeenCalledExactlyOnceWith(plan)
      return new Response(null, { status: 204 })
    })
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher as typeof fetch }, {
      bytes: new Uint8Array([1]), name: 'file.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'chat', as: 'sender', request_id: 'reservation-id' }, { onPlan })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('uses a raw PUT body for a Supabase signed upload', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        staging_key: 'staging/u/file', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024,
      })))
      .mockResolvedValueOnce(new Response('{}'))
    const key = await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([1, 2, 3]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: 'source-chat', as: 'sender-agent', request_id: '12345678-1234-4234-8234-123456789abc' })
    expect(key).toBe('staging/u/file')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      size_bytes: 3, sha256: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), content_type: 'application/octet-stream', chat_id: 'source-chat', as: 'sender-agent', request_id: '12345678-1234-4234-8234-123456789abc',
    })
    const upload = fetcher.mock.calls[1][1] as RequestInit
    expect(upload.method).toBe('PUT')
    expect(upload.body).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (upload.body as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(upload.headers).not.toHaveProperty('Authorization')
  })

  it('keeps the existing multipart POST contract when method is omitted', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        staging_key: 'staging/u/file', url: 'https://storage.example/form', fields: { policy: 'scoped' }, max_bytes: 1024,
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Blob([new Uint8Array([1])]), name: 'data.bin', contentType: 'application/octet-stream',
    }, { chat_id: null, as: 'private-sender' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      size_bytes: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), content_type: 'application/octet-stream', chat_id: null, as: 'private-sender', request_id: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
    })
    const upload = fetcher.mock.calls[1][1] as RequestInit
    expect(upload.method).toBe('POST')
    expect((upload.body as FormData).get('policy')).toBe('scoped')
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob)
  })

  it('declares the content type, so a project chat that keeps files local can admit an image', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ staging_key: 'staging/u/img', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024 })))
      .mockResolvedValueOnce(new Response('{}'))
    await uploadAttachmentBytes({ supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher }, {
      bytes: new Uint8Array([137, 80, 78, 71]), name: 'image.png', contentType: 'image/png',
    }, { chat_id: 'project-chat', as: 'member' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ content_type: 'image/png', chat_id: 'project-chat' })
  })
  it('a given id whose permit was used or lapsed uploads once more under a fresh id; without one, or on another refusal, it is said', async () => {
    const plan = { staging_key: 'staging/u/fresh', url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1024 }
    const ids: string[] = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (!url.endsWith('/upload')) return new Response(null, { status: init.method === 'PUT' && ids.length ? 409 : 204 })
      ids.push(JSON.parse(init.body as string).request_id)
      return ids.length === 1 ? new Response(JSON.stringify({ error: 'expired', message: 'Upload permit expired' }), { status: 410 }) : new Response(JSON.stringify(plan))
    })
    const endpoint = { supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher as typeof fetch }
    const bytes = { bytes: new Uint8Array([1]), name: 'f.bin', contentType: 'application/octet-stream' }
    // A fresh id is a new upload: a storage conflict is not taken for "already stored", even on a retry.
    await expect(uploadAttachmentBytes(endpoint, bytes, { chat_id: 'c', as: 'a', request_id: 'row-id' }, { retry: true })).rejects.toThrow('409')
    expect(ids[0]).toBe('row-id')
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/)
    for (const [answer, scope] of [[{ status: 410, error: 'expired' }, { chat_id: 'c', as: 'a' }], [{ status: 403, error: 'denied' }, { chat_id: 'c', as: 'a', request_id: 'row-id' }]] as const) {
      const once = vi.fn(async () => new Response(JSON.stringify({ error: answer.error, message: 'no' }), { status: answer.status }))
      await expect(uploadAttachmentBytes({ ...endpoint, fetch: once as typeof fetch }, bytes, scope)).rejects.toMatchObject({ code: answer.error })
      expect(once).toHaveBeenCalledOnce()
    }
  })
})
