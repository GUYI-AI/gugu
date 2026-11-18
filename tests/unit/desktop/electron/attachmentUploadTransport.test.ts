import { afterEach, expect, it, vi } from 'vitest'
import { uploadAttachmentPlan } from '@gugu/core/cloud/attachmentsApi'
import { net } from '../../../../apps/desktop/electron/server/server-electron-shim'
import { hostAttachmentsEndpoint } from '../../../../apps/desktop/electron/attachmentUploadTransport'

vi.mock('electron', () => import('../../../../apps/desktop/electron/server/server-electron-shim'))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('uploads attachments on the headless server through net.fetch without reaching net.request', async () => {
  const request = vi.spyOn(net, 'request')
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  const endpoint = await hostAttachmentsEndpoint({
    supabaseUrl: 'https://db.test', anonKey: 'anon', getAccessToken: async () => 'token',
  }, net.fetch, true)

  const url = 'https://store.test/attachment'
  await uploadAttachmentPlan(endpoint, { url, fields: { key: 'pending' }, max_bytes: 100 }, {
    bytes: new Blob(['attachment']), name: 'file.txt', contentType: 'text/plain',
  })

  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'POST' }))
  const form = fetch.mock.calls[0]![1]?.body as FormData
  expect(form.get('key')).toBe('pending')
  expect(await (form.get('file') as File).text()).toBe('attachment')
  expect(request).not.toHaveBeenCalled()
})
