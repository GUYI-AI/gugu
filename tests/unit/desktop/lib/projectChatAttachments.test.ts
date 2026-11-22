import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitPreparedChatAttachment, prepareChatAttachment } from '../../../../apps/desktop/src/lib/attachmentsEndpoint'
import { i18n } from '../../../../apps/desktop/src/i18n'
const f = vi.hoisted(() => ({ plan: vi.fn(), commit: vi.fn(), begin: vi.fn(), keep: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'published-test-token', observeRendererSession: () => () => {} }))
vi.mock('@gugu/core/cloud/attachmentsApi', () => ({ planAttachmentUpload: f.plan, commitAttachment: f.commit,
  declareAttachment: async (endpoint: unknown, file: { bytes: Blob; contentType: string }, scope: unknown, signal?: AbortSignal) => {
    const plan = await f.plan(endpoint, { size: file.bytes.size, contentType: file.contentType }, scope, signal)
    return { staging_key: plan.staging_key, sha256: 'sha', size_bytes: file.bytes.size, plan }
  },
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }) }))
vi.mock('../../../../apps/desktop/src/lib/attachmentUploads', () => ({ beginAttachmentUpload: f.begin }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ keepSentAttachment: f.keep }))
const endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'published-test-token' }
const args = { message_id: 'message', chat_id: 'group', sender_user_id: 'owner', file_name: 'selected.pdf', to_user_ids: ['agent'], thread_root_id: 'thread', caption: 'caption' }
const message = { id: 'message', chat_id: 'group', sender_user_id: 'owner', file_item_id: 'item', file_version: 3 }
const file = () => new File(['pdf'], 'selected.pdf', { type: 'application/pdf' })
function native(local = true) {
  const invoke = vi.fn(async (channel: string, request: { file?: unknown }): Promise<unknown> => channel === 'attachments:declare' ? { staging_key: 'staging', sha256: 'sha', size_bytes: 3 } : request.file ? { id: 'item', version: 3, message } : local)
  const getPathForFile = vi.fn(() => '/project/actual.pdf')
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile } })
  return { invoke, getPathForFile }
}
beforeEach(() => { vi.resetAllMocks(); f.plan.mockResolvedValue({ staging_key: 'staging', url: 'https://bucket', fields: {}, max_bytes: 10 }); f.begin.mockResolvedValue(undefined); f.commit.mockResolvedValue({ id: 'cloud-message' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('project composer attachments use the group-file publisher', () => {
  it('a cancelled native prepare drops its upload even if the IPC declaration returns later', async () => {
    const n = native(false), controller = new AbortController()
    let release!: (value: never) => void
    n.invoke.mockImplementation(async channel => channel === 'attachments:declare' ? await new Promise(resolve => { release = resolve }) : false)
    const preparation = prepareChatAttachment(endpoint, file(), { chat_id: 'group', as: 'owner', message_id: 'message' }, controller.signal)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort(new Error('cancelled'))
    release({ staging_key: 'staging', sha256: 'sha', size_bytes: 3 } as never)
    await expect(preparation).rejects.toThrow('cancelled')
    expect(n.invoke).toHaveBeenCalledWith('attachments:drop', { messageId: 'message' })
    expect(f.begin).not.toHaveBeenCalled()
  })

  it('planning leaves the file private; ordered commit sends path and message together without whole-file IPC', async () => {
    const n = native(), selected = file(), arrayBuffer = vi.spyOn(selected, 'arrayBuffer').mockRejectedValue(new Error('No whole-file IPC'))
    const prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner', message_id: 'message' })
    expect(prepared).toEqual({ local: selected })
    expect(n.invoke).toHaveBeenCalledExactlyOnceWith('files:publish', { chatId: 'group' })
    expect(n.getPathForFile).not.toHaveBeenCalled()
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).resolves.toEqual(message)
    expect(n.invoke).toHaveBeenLastCalledWith('files:publish', { chatId: 'group', file: { name: 'selected.pdf', path: '/project/actual.pdf', size: 3, contentType: 'application/pdf' }, message: args })
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('declares a cloud file in its commit and uploads its bytes behind the message, for an ordinary or cloud-enabled group', async () => {
    const n = native(false), selected = file()
    const prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner', message_id: 'message' })
    expect(prepared).toEqual({ staging_key: 'staging', sha256: 'sha', size_bytes: 3 }); await commitPreparedChatAttachment(endpoint, prepared, args)
    expect(n.invoke).toHaveBeenCalledTimes(2)
    expect(n.invoke).toHaveBeenLastCalledWith('attachments:declare', { file: { name: 'selected.pdf', path: '/project/actual.pdf', size: 3, contentType: 'application/pdf' }, chatId: 'group', as: 'owner', messageId: 'message' })
    expect(f.plan).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled()
    expect(f.commit).toHaveBeenCalledWith(endpoint, { ...args, staging_key: 'staging', sha256: 'sha', size_bytes: 3 })
    expect(f.keep, 'the main process knows where these bytes are: the renderer copies nothing').not.toHaveBeenCalled()
  })
  it('publishes an image as it does any other file of a project chat', async () => {
    const n = native(), image = new File(['png'], 'shot.png', { type: 'image/png' })
    await expect(prepareChatAttachment(endpoint, image, { chat_id: 'group', as: 'owner', message_id: 'message' })).resolves.toEqual({ local: image })
    expect(n.invoke).toHaveBeenCalledOnce(); expect(f.plan).not.toHaveBeenCalled()
  })
  it('does not put a whisper into the shared project folder', async () => {
    const n = native(), selected = file(), prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner', is_whisper: true, message_id: 'message' })
    expect(n.invoke).toHaveBeenCalledOnce(); expect(n.invoke.mock.calls[0]![0]).toBe('attachments:declare'); expect(prepared).toEqual({ staging_key: 'staging', sha256: 'sha', size_bytes: 3 })
    await expect(commitPreparedChatAttachment(endpoint, { local: selected }, { ...args, is_whisper: true })).rejects.toThrow('audience changed')
    expect(n.invoke).toHaveBeenCalledOnce()
  })
  it('reauthorizes through the same cloud uploader when the sender\'s storage setting changed after planning', async () => {
    const n = native(), selected = file(), prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner', message_id: 'message' })
    n.invoke.mockResolvedValueOnce(null as never)
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).resolves.toEqual({ id: 'cloud-message' })
    expect(n.invoke).toHaveBeenLastCalledWith('attachments:declare', expect.objectContaining({ chatId: 'group', messageId: 'message' }))
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(endpoint, { ...args, staging_key: 'staging', sha256: 'sha', size_bytes: 3 })
  })
  it('propagates a publication or atomic message refusal without falling back to cloud', async () => {
    const n = native(), prepared = await prepareChatAttachment(endpoint, file(), { chat_id: 'group', as: 'owner', message_id: 'message' })
    n.invoke.mockRejectedValueOnce(new Error('outside workspace'))
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    n.invoke.mockRejectedValueOnce(new Error('not a member'))
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    expect(f.plan).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it.each([{ ...message, file_item_id: 'other' }, { ...message, file_version: 4 }, { ...message, sender_user_id: 'other' }, { ...message, chat_id: 'other' }, { ...message, id: 'other' }, undefined])('rejects a substituted message or version receipt', async value => {
    const n = native(), prepared = await prepareChatAttachment(endpoint, file(), { chat_id: 'group', as: 'owner', message_id: 'message' })
    n.invoke.mockResolvedValueOnce({ id: 'item', version: 3, message: value } as never)
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow('not committed')
    expect(f.plan).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
})
