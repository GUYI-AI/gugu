import { expect, it } from 'vitest'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'
import { readFrontmatter } from '@gugu/core/shared/assistantMemory'
import { basename } from '../../../../packages/session-chat-ui/src/lib/path'

it('reads Windows file basenames in transcript rows', () => { expect(basename('C:\\repo\\note.md')).toBe('note.md'); expect(basename('src/note.md')).toBe('note.md') })

it('drops a cut Unicode pair from card previews', () => { expect(composerCardPreview('{"v":1,"type":"task","text":"Hello\\ud83d\\ude')).toEqual({ type: 'task', text: 'Hello' }); expect(composerCardPreview('{"v":1,"type":"task","text":"Hello\\ud83d\\ude42')).toEqual({ type: 'task', text: 'Hello🙂' }) })

it('drops a cut Unicode pair from widget previews', () => { expect(widgetMessagePreview('{"v":2,"text":"Hello\\ud83d\\ude')).toBe('Hello'); expect(widgetMessagePreview('{"v":2,"text":"Hello\\ud83d\\ude42')).toBe('Hello🙂') })

it('omits tilde fenced blocks from plain previews', () => { expect(markdownPlainText('Before\n~~~ts\nconst x = 1\n~~~\nAfter')).toBe('Before After') })

it('omits closing ATX header markers', () => { expect(markdownPlainText('## Title ##')).toBe('Title'); expect(markdownPlainText('## C#')).toBe('C#') })

it('omits parenthesized ordered list markers', () => { expect(markdownPlainText('1) First\n2) Second')).toBe('First Second') })

it('decodes double quoted memory scalars', () => { expect(readFrontmatter("---\nname: \"Quoted \\\"name\\\"\"\n---\nBody").fields.name).toBe('Quoted "name"') })
