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

function audit(files: Record<string, string>, exceptions: object = {}, errorRoots: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'gugu-cjk-audit-'))
  directories.push(root)
  for (const [file, text] of Object.entries({ ...files, 'exceptions.json': JSON.stringify(exceptions) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  mkdirSync(join(root, 'apps/desktop/src'), { recursive: true })
  return auditHardcodedCjk(root, { roots: ['apps/desktop/src'], errorRoots, exceptionsFile: 'exceptions.json' })
}

describe('hardcoded CJK audit', () => {
  it('checks core error messages without treating prompts and data as UI errors', () => {
    const result = audit({ 'packages/core/src/errors.ts': `
      export const prompt = '请整理会话';
      export const example = { title: '示例数据' };
      throw new Error('读取失败');
      const failure = TypeError(\`目录不存在：\${name}\`);
      throw new DomainError('没有权限');
      throw '无法继续';
      throw new AggregateError([], '操作失败');
      throw new Error(/* 诊断备注 */ 'English diagnostic');
    ` }, {}, ['packages/core/src'])
    expect(result.failures.map(row => row.text)).toEqual([
      "'读取失败'", '`目录不存在：${name}`', "'没有权限'", "'无法继续'", "'操作失败'",
    ])
  })

  it('pins core debt to an exact expression and a single occurrence', () => {
    const file = 'packages/core/src/errors.ts'
    const result = audit({ [file]: "throw new Error('旧诊断'); throw new Error('旧诊断'); throw new Error('新诊断');" }, {
      coreErrorDebt: [{ file, text: "'旧诊断'", reason: 'Existing diagnostic' }],
    }, ['packages/core/src'])
    expect(result.categories['legacy-core-error']).toBe(1)
    expect(result.failures.map(row => row.text)).toEqual(["'旧诊断'", "'新诊断'"])
    expect(result.staleExceptions).toEqual([])
  })

  it('rejects a removed debt expression instead of retaining an unused allowance', () => {
    const file = 'packages/core/src/errors.ts'
    const result = audit({ [file]: "throw new Error('English now');" }, {
      coreErrorDebt: [{ file, text: "'旧诊断'", reason: 'Existing diagnostic' }],
    }, ['packages/core/src'])
    expect(result.staleExceptions).toEqual([`coreErrorDebt ${file} '旧诊断' matches no error message`])
  })

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

  it('fails CJK that the main process puts on screen, and leaves its agent text and logs alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-cjk-audit-'))
    directories.push(root)
    const file = 'apps/desktop/electron/window.ts'
    mkdirSync(join(root, 'apps/desktop/electron'), { recursive: true })
    writeFileSync(join(root, 'exceptions.json'), '{}')
    writeFileSync(join(root, file), `
      export const TITLE = '咕咕无法启动'
      export const toolDescription = '列出这台电脑上的文件'
      dialog.showMessageBox(win, { type: 'error', message: TITLE, detail })
      new Notification({ title: '后台运行', body: copy.body })
      Menu.buildFromTemplate([{ label: '打开', click: () => log.info('点了打开') }, { label: labels.quit }])
      const item: MenuItemConstructorOptions = { label: '退出' }
      tray.setToolTip(catalog.tray.tooltip)
      throw new Error('任务页运行时不可用')
    `)
    const result = auditHardcodedCjk(root, { roots: [], errorRoots: [], sinkRoots: ['apps/desktop/electron'], exceptionsFile: 'exceptions.json' })
    expect(result.failures.map(row => row.text)).toEqual(['咕咕无法启动', '后台运行', '打开', '退出'])
  })
})
