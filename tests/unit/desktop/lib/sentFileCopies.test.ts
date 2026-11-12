import { afterEach, expect, it, vi } from 'vitest'
import { formatAttachmentMetadata } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { adoptSentFile, dropSentFile, forgetSentFiles, holdSentFile, sentFileCopy } from '../../../../apps/desktop/src/lib/sentFileCopies'

afterEach(() => { forgetSentFiles(); vi.useRealTimers(); vi.restoreAllMocks() })
const committed = (id: string): MessageItem => ({
  id, chat_id: 'chat', sender_user_id: 'me', to_user_ids: null, is_whisper: false, seq: 7, content_type: 'attachment',
  // A committed row's content names the file; its bytes are the folder item the row points at (no URL line).
  content: formatAttachmentMetadata({ kind: 'file', fileName: 'clip.mov', mimeType: 'video/quicktime', sizeBytes: 5, url: 'x' }).split('\n').filter((_line, index) => index !== 1).join('\n'),
  file_item_id: 'item-1', file_version: 2, reply_to_message_id: null, thread_root_id: null, is_thread_root: false,
  retracted_at: null, created_at: '2026-11-12T00:00:00Z', reactions: [], is_mine: true, delivered: true, delivery_status: null,
})

it('reads a sent file from this device while it uploads and, once delivered, under its committed address', () => {
  vi.useFakeTimers()
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const file = new File(['bytes'], 'clip.mov', { type: 'video/quicktime' })
  holdSentFile('m1', file, 'blob:preview-1')
  expect(sentFileCopy({ kind: 'url', url: 'blob:preview-1' })).toBe(file)
  expect(sentFileCopy({ kind: 'url', url: 'blob:from-an-earlier-run' }), 'a preview this run did not make has no bytes').toBeNull()
  adoptSentFile('m1', committed('m1'))
  expect(sentFileCopy({ kind: 'item', itemId: 'item-1', version: 2 })).toBe(file)
  expect(sentFileCopy({ kind: 'url', url: 'blob:preview-1' }), 'the sending row still reads it until the committed row replaces it').toBe(file)
  vi.advanceTimersByTime(1000)
  expect(revoke).toHaveBeenCalledWith('blob:preview-1')
  forgetSentFiles()
  expect(sentFileCopy({ kind: 'item', itemId: 'item-1', version: 2 })).toBeNull()
})

it('a discarded row forgets its file', () => {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  holdSentFile('m2', new Blob(['x']), 'blob:preview-2')
  dropSentFile('m2')
  expect(sentFileCopy({ kind: 'url', url: 'blob:preview-2' })).toBeNull()
})
