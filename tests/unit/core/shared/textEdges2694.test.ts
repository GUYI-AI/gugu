import { expect, it } from 'vitest'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'
import { readFrontmatter } from '@gugu/core/shared/assistantMemory'
import { basename } from '../../../../packages/session-chat-ui/src/lib/path'

it('reads Windows file basenames in transcript rows', () => { expect(basename('C:\\repo\\note.md')).toBe('note.md'); expect(basename('src/note.md')).toBe('note.md') })
