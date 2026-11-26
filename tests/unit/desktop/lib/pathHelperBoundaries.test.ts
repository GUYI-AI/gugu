import { expect, it } from 'vitest'
import { safePathSegment, shortHome } from '../../../../apps/desktop/src/session/shared/path-name'
import { sameFolder } from '../../../../apps/desktop/src/session/shared/core/projects/folder-path'
import { normalizeFileTreePath } from '../../../../apps/desktop/src/session/renderer/features/sessions/file-tree/tree-utils'
import { displayPathForChange } from '../../../../apps/desktop/src/session/renderer/features/sessions/diff-view/changes-panel/components/changes-tree-utils'
import { remotePageRoot } from '../../../../apps/desktop/src/session/shared/preview/remote-page-url'

it('rejects reserved device names followed by an extension', () => {
  expect(safePathSegment('CON.txt')).toBe('project')
  expect(safePathSegment('lpt9.log')).toBe('project')
  expect(safePathSegment('console.txt')).toBe('console.txt')
})

it('rejects superscript COM and LPT device names', () => {
  expect(safePathSegment('COM¹')).toBe('project')
  expect(safePathSegment('LPT².txt')).toBe('project')
  expect(safePathSegment('COM³')).toBe('project')
})
