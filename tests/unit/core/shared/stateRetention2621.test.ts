import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { contains } from '../../../../packages/session-core/src/files/paths'
import { withTimeout } from '../../../../apps/desktop/src/lib/withTimeout'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const row = (): MessageItem => ({ id: 'm', chat_id: 'c', sender_user_id: 'u', to_user_ids: null, seq: 1, content: 'Hello', content_type: 'text', reply_to_message_id: null, retracted_at: null, created_at: '2026-11-13', is_mine: false, delivered: true, delivery_status: null })

it('rejects Windows paths outside the parent directory', () => { const windowsRelative = path.win32.relative; const relative = vi.spyOn(path, 'relative').mockImplementation(windowsRelative); try { expect(contains('C:/root', 'C:/outside/file.txt')).toBe(false); expect(contains('C:/root', 'C:/root/child.txt')).toBe(true) } finally { relative.mockRestore() } })

it('clears renderer timeout timers after a promise settles', async () => { vi.useFakeTimers(); vi.stubGlobal('window', globalThis); try { expect(await withTimeout(Promise.resolve(3), 1000, 'timeout')).toBe(3); expect(vi.getTimerCount()).toBe(0); await expect(withTimeout(Promise.reject(new Error('source')), 1000, 'timeout')).rejects.toThrow('source'); expect(vi.getTimerCount()).toBe(0) } finally { vi.useRealTimers(); vi.unstubAllGlobals() } })



it('keeps thread placement and edit metadata updates when merging rows', () => { const previous = { ...row(), local_send_state: null }; const incoming = { ...previous, thread_root_id: 'root', is_thread_root: true, edited_at: '2026-11-13T01:00:00Z' }; expect(mergeMessagesById([previous], [incoming], 'c')[0]).toMatchObject({ thread_root_id: 'root', is_thread_root: true, edited_at: incoming.edited_at }); expect(mergeMessagesById([previous], [{ ...previous }], 'c')[0]).toBe(previous) })

it('keeps attribution and forwarding updates when merging rows', () => { const previous = { ...row(), local_send_state: null }; const agent_sender = { id: 'a', name: 'Agent' }; const incoming = { ...previous, via_app: 'board', sent_by_agent: true, agent_sender, forwarded_from_message_id: 'origin' }; const merged = mergeMessagesById([previous], [incoming], 'c')[0]; expect(merged).toMatchObject({ via_app: 'board', sent_by_agent: true, agent_sender, forwarded_from_message_id: 'origin' }); expect(mergeMessagesById([incoming], [{ ...incoming, agent_sender: { ...agent_sender } }], 'c')[0]).toBe(incoming) })
