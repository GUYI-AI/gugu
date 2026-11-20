import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditHardcodedCjk } from '../../../scripts/checks/hardcoded-cjk-audit.mts'

let directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories = []
})

function audit(files: Record<string, string>, exceptions: object = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gugu-cjk-audit-'))
  directories.push(root)
  for (const [file, text] of Object.entries({ ...files, 'exceptions.json': JSON.stringify(exceptions) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return auditHardcodedCjk(root, { roots: ['apps/desktop/src'], exceptionsFile: 'exceptions.json' })
}

describe('hardcoded CJK audit', () => {
  it('fails a Chinese JSX literal that has no English counterpart', () => {
    const result = audit({ 'apps/desktop/src/Save.tsx': 'export const Save = () => <button>保存</button>\n' })
    expect(result.failures).toMatchObject([{ file: 'apps/desktop/src/Save.tsx', line: 1, category: 'user-visible', text: '保存' }])
  })

  it('passes Chinese inside a logger call', () => {
    const result = audit({ 'apps/desktop/src/log.ts': "console.warn('读取失败')\nexport const log = { warn: (_: string) => {} }\nlog.warn('读取失败')\n" })
    expect(result.failures).toEqual([])
    expect(result.categories.developer).toBe(2)
  })

  it('passes a file listed as an exception, and fails an exception that matches nothing', () => {
    const result = audit({
      'apps/desktop/src/tool.ts': "export const description = '查手机日历里的日程'\n",
      'apps/desktop/src/plain.ts': "export const plain = 'English only'\n",
    }, {
      exceptions: [
        { file: 'apps/desktop/src/tool.ts', class: 'D', reason: 'tool description read by the agent' },
        { file: 'apps/desktop/src/plain.ts', class: 'E', reason: 'no longer has Chinese' },
      ],
    })
    expect(result.failures).toEqual([])
    expect(result.categories.excepted).toBe(1)
    expect(result.staleExceptions).toEqual(['exception apps/desktop/src/plain.ts matches no CJK literal'])
  })

  it('fails a CJK value in an en-US catalog and lets an allowed language name through', () => {
    const result = audit({
      'apps/desktop/src/i18n/locales/en-US/main.ts': "export default { tabs: { left: '移至左侧面板' }, language: { zhCN: '简体中文' } }\n",
      'apps/desktop/src/i18n/locales/zh-CN/main.ts': "export default { tabs: { left: '移至左侧面板' }, language: { zhCN: '简体中文' } }\n",
    }, { englishCatalogAllowed: [{ text: '简体中文', reason: 'a language name' }] })
    expect(result.failures).toMatchObject([{ file: 'apps/desktop/src/i18n/locales/en-US/main.ts', category: 'english-catalog', text: '移至左侧面板' }])
  })

  it('reads a locale-keyed object as a catalog: the zh side passes, CJK on the en side fails', () => {
    const result = audit({
      'apps/desktop/src/copy.ts': "export const copy = { 'zh-CN': { save: '保存', close: '关闭' }, 'en-US': { save: 'Save', close: '关闭' } }\n",
      'apps/desktop/src/half.ts': "export const half = { 'zh-CN': { save: '保存' } }\n",
    })
    expect(result.failures.map(({ file, category, text }) => ({ file, category, text }))).toEqual([
      { file: 'apps/desktop/src/copy.ts', category: 'english-catalog', text: '关闭' },
      { file: 'apps/desktop/src/half.ts', category: 'user-visible', text: '保存' },
    ])
  })
})
