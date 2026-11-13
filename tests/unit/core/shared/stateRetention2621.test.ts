import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { contains } from '../../../../packages/session-core/src/files/paths'
import { withTimeout } from '../../../../apps/desktop/src/lib/withTimeout'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const row = (): MessageItem => ({ id: 'm', chat_id: 'c', sender_user_id: 'u', to_user_ids: null, seq: 1, content: 'Hello', content_type: 'text', reply_to_message_id: null, retracted_at: null, created_at: '2026-11-13', is_mine: false, delivered: true, delivery_status: null })

it('rejects Windows paths outside the parent directory', () => { const windowsRelative = path.win32.relative; const relative = vi.spyOn(path, 'relative').mockImplementation(windowsRelative); try { expect(contains('C:/root', 'C:/outside/file.txt')).toBe(false); expect(contains('C:/root', 'C:/root/child.txt')).toBe(true) } finally { relative.mockRestore() } })
