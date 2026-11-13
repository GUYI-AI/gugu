import { expect, it } from 'vitest'
import { FILE_LINK_IN_TEXT, groupFileLink, parseGroupFileLink, linkTargetOf, classifyFileLink, guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it('keeps quoted sheet names in extracted file references', () => { const at = { range: "'Q1 Budget'!A1" }; const link = groupFileLink(ITEM, { at }); const extracted = [...link.matchAll(FILE_LINK_IN_TEXT)][0][0]; expect(parseGroupFileLink(extracted)?.at).toEqual(at) })
