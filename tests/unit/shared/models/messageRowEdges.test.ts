import { describe, expect, it } from 'vitest'
import { mergeMessagesById, optimisticReplyFields, shallowEqualMessage, upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import type { FileMetadata, FileRevision } from '@gugu/core/shared/fileResolver'
import { message } from '../../../support/testHarness'

describe('message row identity boundaries', () => {
  const revision: FileRevision = {
    source: 'local', item_id: 'file', version: 1, chat_id: 'chat-1', file_name: 'image.png',
    content_type: 'image/png', size_bytes: 10, sha256: 'a'.repeat(64), width: 10, height: 20,
    host_device_id: 'device', host_project_id: 'project', host_account_id: 'account',
    host_label: 'Computer', host_online: true, relative_path: 'image.png', temporary_transfer: true,
    workspace: { path: 'image.png', parent_id: null, created_at: '2026-11-10', updated_at: '2026-11-10', created_by: 'owner', source_message_ids: ['source'] },
  }
  it.each([
    { status: 'ready', revision },
    { status: 'ready', revision: { source: 'managed-object', file_name: 'old.png', content_type: 'image/png', size_bytes: 10, sha256: null,
      legacy_object: { bucket_id: 'chat-media', object_name: 'old.png', message_id: 'message-1' } } },
    ...(['gone', 'expired', 'missing'] as const).map(status => ({ status, sha256: 'a'.repeat(64) })),
  ] satisfies FileMetadata[])('preserves row identity for equal but separately fetched file objects: %j', (file_metadata) => {
    const previous = message({ file_metadata, session_file: { path: 'image.png', sha256: 'a'.repeat(64), session_id: 'session' }, image_dimensions: { width: 10, height: 20 } })
    const incoming = structuredClone(previous)
    expect(incoming.file_metadata).not.toBe(previous.file_metadata)
    expect(shallowEqualMessage(previous, incoming)).toBe(true)
    expect(mergeMessagesById([previous], [incoming], previous.chat_id)[0]).toBe(previous)
    expect(upsertMessageById([previous], incoming)[0]).toBe(previous)
  })
  it.each(Object.keys(revision) as (keyof FileRevision)[])('updates a changed file revision field: %s', (key) => {
    const previous = message({ file_metadata: { status: 'ready', revision } })
    const changed: FileRevision = { ...revision }
    // 移除一个已存在字段，覆盖每个字段改变时需要更新消息行的行为。
    delete (changed as Partial<FileRevision>)[key]
    const incoming = { ...previous, file_metadata: { status: 'ready' as const, revision: changed } }
    expect(shallowEqualMessage(previous, incoming)).toBe(false)
  })
  it('updates changed session references, dimensions and unavailable metadata', () => {
    const previous = message({ session_file: { path: 'image.png', sha256: 'a', session_id: 'session' }, image_dimensions: { width: 10, height: 20 }, file_metadata: { status: 'gone', sha256: 'a' } })
    for (const incoming of [
      { ...previous, session_file: { ...previous.session_file!, path: 'other.png' } },
      { ...previous, session_file: { ...previous.session_file!, sha256: 'b' } },
      { ...previous, session_file: { ...previous.session_file!, session_id: 'other' } },
      { ...previous, image_dimensions: { width: 11, height: 20 } },
      { ...previous, image_dimensions: { width: 10, height: 21 } },
      { ...previous, file_metadata: { status: 'gone' as const, sha256: 'b' } },
      { ...previous, file_metadata: { status: 'expired' as const, sha256: 'a' } },
    ]) expect(shallowEqualMessage(previous, incoming)).toBe(false)
  })
  it('updates changes within nested workspace and legacy metadata', () => {
    const workspace = revision.workspace!
    const previous = message({ file_metadata: { status: 'ready', revision } })
    for (const changed of [
      { ...workspace, path: 'other.png' }, { ...workspace, parent_id: 'parent' },
      { ...workspace, created_at: 'later' }, { ...workspace, updated_at: 'later' },
      { ...workspace, created_by: 'other' }, { ...workspace, source_message_ids: ['other'] },
    ]) expect(shallowEqualMessage(previous, { ...previous, file_metadata: { status: 'ready', revision: { ...revision, workspace: changed } } })).toBe(false)
    const legacy: NonNullable<FileRevision['legacy_object']> = { bucket_id: 'chat-media', object_name: 'old.png', message_id: 'message-1' }
    const old = message({ file_metadata: { status: 'ready', revision: { ...revision, legacy_object: legacy } } })
    for (const changed of [{ ...legacy, object_name: 'other.png' }, { ...legacy, message_id: 'other' }]) {
      expect(shallowEqualMessage(old, { ...old, file_metadata: { status: 'ready', revision: { ...revision, legacy_object: changed } } })).toBe(false)
    }
  })
  it('omits a retracted message body from the optimistic reply preview', () => {
    const target = message({ retracted_at: '2026-11-10T00:00:00Z', content: 'removed text' })
    expect(optimisticReplyFields([target], target.id).reply_to_content).toBeNull()
  })
  it('keeps one final row per id when a fresh page repeats it', () => {
    const first = message({ content: 'old' }), latest = message({ content: 'latest' })
    expect(mergeMessagesById([], [first, latest], first.chat_id)).toEqual([latest])
  })
  it('updates attachment identity and dimensions when the message body is unchanged', () => {
    const previous = message({ file_item_id: 'file', file_version: 1, image_dimensions: { width: 10, height: 10 } })
    const incoming = { ...previous, file_version: 2, image_dimensions: { width: 20, height: 10 } }
    expect(shallowEqualMessage(previous, incoming)).toBe(false)
    expect(mergeMessagesById([previous], [incoming], previous.chat_id)[0]).toMatchObject(incoming)
  })
  it('does not reuse a previous row from another chat with the same id', () => {
    const foreign = message({ chat_id: 'foreign', readers: ['foreign-reader'], delivery_status: 'read' })
    const fresh = message({ chat_id: 'target', readers: [], delivery_status: null })
    const [merged] = mergeMessagesById([foreign], [fresh], 'target')
    expect(merged).toBe(fresh)
    expect(merged.readers).toEqual([])
  })
})
