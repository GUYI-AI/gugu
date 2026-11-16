// fileFamily: the one judgement every file icon reads (packages/session-shared/src/file-marks.ts draws it).
import { describe, expect, test } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { markOf } from '../../../../apps/desktop/preinstalled-apps/workspace/list.js'

const CASES: [string, string, string][] = [
  ['report.pdf', '', 'pdf'], ['brief.DOCX', '', 'word'], ['budget.xlsx', '', 'sheet'], ['data.csv', '', 'sheet'],
  ['deck.pptx', '', 'slides'], ['archive.zip', '', 'archive'], ['logs.tar.gz', '', 'archive'], ['photo.png', '', 'image'],
  ['clip.mov', '', 'video'], ['voice.m4a', '', 'audio'], ['analyze.py', '', 'code'], ['notes.md', '', 'text'],
  ['config.yaml', '', 'text'], ['page.html', '', 'text'], ['scan', 'application/pdf', 'pdf'], ['shot', 'image/png; q=1', 'image'],
  ['notes', 'text/markdown', 'text'], ['photo.png', 'application/octet-stream', 'image'], ['mystery.bin', 'application/zip', 'archive'],
  ['mystery.bin', '', 'other'], ['', '', 'other'], ['dir/a.b/README', '', 'other'],
]

describe('fileFamily', () => {
  test.each(CASES)('%s (%s) → %s', (name, mime, family) => expect(fileFamily(name, mime)).toBe(family))

  // The Files App cannot import core, so its list.js keeps a copy of the table until <gugu-file-mark> replaces it
  // (next batch); delete this test together with that copy.
  test('the Files App copy (list.js markOf) gives the same family', () => {
    for (const [name, mime] of CASES) expect(markOf({ name, contentType: mime }).family, `${name} ${mime}`).toBe(fileFamily(name, mime))
  })
})
