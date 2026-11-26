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

it('does not return a portable folder name ending in periods', () => {
  expect(safePathSegment('report...')).toBe('report')
  expect(safePathSegment('...')).toBe('project')
})

it('abbreviates Windows home paths with forward and mixed slashes', () => {
  expect(shortHome('C:/Users/me/code')).toBe('~/code')
  expect(shortHome('C:\\Users/me\\code')).toBe('~\\code')
  expect(shortHome('C:/Users/me')).toBe('~')
})

it('compares equivalent Windows slash spellings without folding case', () => {
  expect(sameFolder('C:\\work\\repo', 'C:/work/repo/')).toBe(true)
  expect(sameFolder('/Work', '/work')).toBe(false)
})

it('preserves an absolute drive root when normalizing file-tree paths', () => {
  expect(normalizeFileTreePath('C:/')).toBe('C:/')
  expect(normalizeFileTreePath('C:\\')).toBe('C:/')
  expect(normalizeFileTreePath('/')).toBe('/')
})
