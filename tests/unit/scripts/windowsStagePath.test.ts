// @@@short-stage - the Windows installer extracts every packaged file to `<install dir>.new\<file>`, and its extractor
// fails past MAX_PATH. Packaging measures the deepest file against that prefix; these pin the measurement and that the
// installer and the measurement use the same stage name.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repo = resolve(__dirname, '../../..')
const paths = require('../../../scripts/build/windows-install-paths.cjs') as {
  STAGE_SUFFIX: string
  MAX_PATH: number
  MARGIN: number
  INSTALL_PARENT: string
  windowsInstallDirName(appInfo: { productFilename: string; sanitizedName: string }): string
  deepestRelativePath(root: string): string
  checkWindowsStagePaths(input: { appOutDir: string; installDirName: string }): { length: number; budget: number; deepest: string }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A packaged tree whose deepest file is `resources\app\<padding>` of exactly `length` characters. */
function tree(length: number): string {
  const root = mkdtempSync(join(tmpdir(), 'stage-path-'))
  roots.push(root)
  const prefix = 'resources\\app\\'
  const name = 'f'.repeat(length - prefix.length)
  mkdirSync(join(root, 'resources', 'app'), { recursive: true })
  writeFileSync(join(root, 'resources', 'app', name), '')
  writeFileSync(join(root, 'shallow.dll'), '')
  return root
}

describe('Windows stage path budget', () => {
  it('the installer stages at the name the packaging check measures', () => {
    const helper = readFileSync(join(repo, 'build-resources/nsis/install-transaction.ps1'), 'utf8')
    const nsis = readFileSync(join(repo, 'build-resources/nsis/zip-transaction.nsh'), 'utf8')
    expect(helper).toContain(`$stage = "$Target${paths.STAGE_SUFFIX}"`)
    expect(nsis).toContain(`StrCpy $guguStage "$INSTDIR${paths.STAGE_SUFFIX}"`)
  })

  it('measures the deepest relative path with Windows separators', () => {
    expect(paths.deepestRelativePath(tree(40))).toBe(`resources\\app\\${'f'.repeat(26)}`)
  })

  it('fails packaging exactly when the deepest extraction path passes the budget', () => {
    const installDirName = 'gugu-acceptance-windows-test'
    const fixed = paths.INSTALL_PARENT.length + installDirName.length + paths.STAGE_SUFFIX.length + 1
    const fits = paths.MAX_PATH - paths.MARGIN - fixed
    expect(paths.checkWindowsStagePaths({ appOutDir: tree(fits), installDirName }).length).toBe(paths.MAX_PATH - paths.MARGIN)
    expect(() => paths.checkWindowsStagePaths({ appOutDir: tree(fits + 1), installDirName })).toThrow(/windows-stage-path/)
  })

  it("keeps today's deepest packaged file (140 characters, 0.3.10) inside the budget for every tier", () => {
    for (const installDirName of ['gugu', 'gugu-beta', 'gugu-acceptance-windows-test']) {
      expect(() => paths.checkWindowsStagePaths({ appOutDir: tree(140), installDirName })).not.toThrow()
    }
  })

  it('names the install folder the way electron-builder does', () => {
    expect(paths.windowsInstallDirName({ productFilename: '咕咕 验收 windows-test', sanitizedName: 'gugu-acceptance-windows-test' })).toBe('gugu-acceptance-windows-test')
    expect(paths.windowsInstallDirName({ productFilename: 'Gugu', sanitizedName: 'gugu' })).toBe('Gugu')
  })
})
