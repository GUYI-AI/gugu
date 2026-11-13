import { expect, it } from 'vitest'
import { FILE_LINK_IN_TEXT, groupFileLink, parseGroupFileLink, linkTargetOf, classifyFileLink, guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it('keeps quoted sheet names in extracted file references', () => { const at = { range: "'Q1 Budget'!A1" }; const link = groupFileLink(ITEM, { at }); const extracted = [...link.matchAll(FILE_LINK_IN_TEXT)][0][0]; expect(parseGroupFileLink(extracted)?.at).toEqual(at) })

it('omits revision zero from group file links', () => { expect(parseGroupFileLink(`gugu-file://${ITEM}?v=0`)).toEqual({ itemId: ITEM }); expect(parseGroupFileLink(`gugu-file://${ITEM}?v=1`)?.version).toBe(1) })

it('rejects unsafe revisions in App file targets', () => { const own = { id: 'board', contributes: { tabs: [{ name: 'main' }] } }; expect(() => linkTargetOf({ kind: 'file', file: ITEM, version: 9007199254740992 }, own)).toThrow(); expect(linkTargetOf({ kind: 'file', file: ITEM, version: 1 }, own)).toMatchObject({ version: 1 }) })
