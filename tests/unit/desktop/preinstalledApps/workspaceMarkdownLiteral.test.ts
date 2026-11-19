// The Files App inserts an uploaded file's name into the markdown it edits. It cannot import the host's markdownLiteral
// (an App page loads its own files and gugu.*), so it carries a copy; the two must write the same text.
import { describe, expect, it } from 'vitest'
import { markdownLiteral } from '@gugu/core/shared/markdownLiteral'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { markdownLiteral as appMarkdownLiteral } from '../../../../apps/desktop/preinstalled-apps/workspace/markdown-literal.js'

describe("the Files App's markdownLiteral", () => {
  it('writes what the host writes', () => {
    for (const name of ['shot [1].png', 'a\\b $x$.md', '*_`~<&[]$', '普通文件.txt']) {
      expect(appMarkdownLiteral(name)).toBe(markdownLiteral(name))
    }
  })
})
