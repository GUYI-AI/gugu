import { expect, it } from 'vitest'
import { FILE_LINK_IN_TEXT, groupFileLink, parseGroupFileLink, linkTargetOf, classifyFileLink, guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it('keeps quoted sheet names in extracted file references', () => { const at = { range: "'Q1 Budget'!A1" }; const link = groupFileLink(ITEM, { at }); const extracted = [...link.matchAll(FILE_LINK_IN_TEXT)][0][0]; expect(parseGroupFileLink(extracted)?.at).toEqual(at) })

it('omits revision zero from group file links', () => { expect(parseGroupFileLink(`gugu-file://${ITEM}?v=0`)).toEqual({ itemId: ITEM }); expect(parseGroupFileLink(`gugu-file://${ITEM}?v=1`)?.version).toBe(1) })

it('rejects unsafe revisions in App file targets', () => { const own = { id: 'board', contributes: { tabs: [{ name: 'main' }] } }; expect(() => linkTargetOf({ kind: 'file', file: ITEM, version: 9007199254740992 }, own)).toThrow(); expect(linkTargetOf({ kind: 'file', file: ITEM, version: 1 }, own)).toMatchObject({ version: 1 }) })

it('classifies trimmed file paths consistently', () => { expect(classifyFileLink('  notes/a.md  ')).toEqual({ kind: 'workspace-file', path: 'notes/a.md' }); expect(classifyFileLink('  notes/a.md#L10  ')).toEqual({ kind: 'workspace-file', path: 'notes/a.md', at: { L10: '' } }) })

it('writes Markdown-safe session and project link destinations', () => { for (const kind of ['session', 'project'] as const) { const target = kind === 'session' ? { kind, sessionId: 'session(1)' } : { kind, projectId: 'project(1)' }; const link = guguLink(target, 'gugu'); expect(link).not.toMatch(/[()]/); expect(parseGuguLink(link)).toEqual(target) } })

it('writes Markdown-safe App path destinations', () => { const target = { kind: 'app' as const, extensionId: 'board', tab: 'main', path: 'sheet(1)/notes', query: {}, place: null }; const link = guguLink(target, 'gugu'); expect(link).not.toMatch(/[()]/); expect(parseGuguLink(link)).toEqual(target) })
