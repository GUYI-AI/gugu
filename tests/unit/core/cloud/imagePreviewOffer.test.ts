import { describe, expect, it, vi } from 'vitest'
import { attachmentSha256, declareAttachment, drawImagePreviews, withUploadedAttachment, type AttachmentsEndpoint } from '../../../../packages/core/src/cloud/attachmentsApi'

// The upload alone: `use` hands back its key.
const uploadAttachmentBytes = (endpoint: AttachmentsEndpoint, file: { bytes: Uint8Array; name: string; contentType: string }, scope: { chat_id: string | null; as: string }) =>
  withUploadedAttachment(endpoint, file, scope, async key => key)

const plan = (key: string) => new Response(JSON.stringify({ staging_key: key, url: 'https://storage.example/scoped', method: 'PUT', fields: {}, max_bytes: 1 << 20 }))
const routes = () => {
  const seen: { route: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const route = url.split('/functions/v1/attachments/')[1]
    if (!route) return new Response(null, { status: 204 })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    seen.push({ route, body })
    return route === 'upload' ? plan(`staging/u/${body.content_type === 'image/webp' ? 'preview' : 'original'}-${seen.length}`) : new Response('{"status":"ready"}')
  })
  return { seen, endpoint: { supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch: fetcher as typeof fetch } }
}

describe('image previews offered by every upload', () => {
  const draw = vi.fn(async () => new Blob([new Uint8Array([9, 9])], { type: 'image/webp' }))
  const warn = vi.fn()
  drawImagePreviews({ draw, warn })
  const original = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

  it('an uploaded image (an App writing a file, an agent sending as its owner) offers its preview for its own bytes', async () => {
    const { seen, endpoint } = routes()
    await uploadAttachmentBytes(endpoint, { bytes: original, name: 'shot.png', contentType: 'image/png' }, { chat_id: 'chat', as: 'agent' })
    await vi.waitFor(() => expect(seen.some(call => call.route === 'file-preview')).toBe(true))
    const offer = seen.find(call => call.route === 'file-preview')!
    expect(offer.body.sha256).toBe(await attachmentSha256(original))
    expect(seen.filter(call => call.route === 'upload').map(call => [call.body.chat_id, call.body.as, call.body.content_type]))
      .toEqual([['chat', 'agent', 'image/png'], [null, 'agent', 'image/webp']])
    expect(offer.body.staging_key).toMatch(/^staging\/u\/preview-/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a declared image (a phone-hosted or desktop agent, a composer) offers it as soon as its index is known', async () => {
    const { seen, endpoint } = routes()
    const declared = await declareAttachment(endpoint, { bytes: original, contentType: 'image/jpeg' }, { chat_id: 'chat', as: 'person', request_id: crypto.randomUUID() })
    await vi.waitFor(() => expect(seen.find(call => call.route === 'file-preview')?.body.sha256).toBe(declared.sha256))
  })

  it('a file that is not an image, and the preview itself, offer nothing', async () => {
    draw.mockClear()
    const { seen, endpoint } = routes()
    await uploadAttachmentBytes(endpoint, { bytes: original, name: 'data.bin', contentType: 'application/octet-stream' }, { chat_id: 'chat', as: 'agent' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(draw).not.toHaveBeenCalled()
    expect(seen.map(call => call.route)).toEqual(['upload'])
  })

  it('a format the drawer cannot decode uploads without a preview', async () => {
    draw.mockResolvedValueOnce(null as never)
    const { seen, endpoint } = routes()
    await uploadAttachmentBytes(endpoint, { bytes: original, name: 'a.heic', contentType: 'image/heic' }, { chat_id: 'chat', as: 'agent' })
    await vi.waitFor(() => expect(draw).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(seen.map(call => call.route)).toEqual(['upload'])
  })
})
