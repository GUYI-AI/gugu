import { createRequire } from 'node:module'
import path from 'node:path'
import type { Configuration } from 'electron-builder'
import { afterEach, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const { Packager } = builderRequire('app-builder-lib/out/packager') as {
  Packager: new (options: { projectDir: string; config: Configuration }) => {
    validateConfig(): Promise<void>
    metadata: { desktopName?: string }
  }
}
const { LinuxPackager } = builderRequire('app-builder-lib/out/linuxPackager') as {
  LinuxPackager: new (info: InstanceType<typeof Packager>) => {
    executableName: string
    platformSpecificBuildOptions: Configuration['linux']
  }
}
const { LinuxTargetHelper } = builderRequire('app-builder-lib/out/targets/LinuxTargetHelper') as {
  LinuxTargetHelper: new (packager: InstanceType<typeof LinuxPackager>) => {
    getDesktopFileName(): string
    computeDesktopEntry(options: Configuration['linux']): Promise<string>
  }
}
const repoRoot = path.resolve(__dirname, '../../..')
const configFile = path.join(repoRoot, 'electron-builder.cjs')

afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[configFile]
})

test.each([
  ['production', 'gugu', '咕咕'],
  ['beta', 'gugu-beta', '咕咕 Beta'],
  ['acceptance', 'gugu-acceptance', '咕咕 验收'],
  ['acceptance-local', 'gugu-acceptance-local', '咕咕 验收 local'],
])('%s: Electron identity matches the actual Linux desktop entry', async (tier, name, productName) => {
  vi.stubEnv('GUGU_TIER', tier)
  delete require.cache[configFile]
  const config = require(configFile) as Configuration
  const info = new Packager({ projectDir: repoRoot, config })
  await info.validateConfig()
  const linux = new LinuxPackager(info)
  const helper = new LinuxTargetHelper(linux)
  const entry = await helper.computeDesktopEntry(linux.platformSpecificBuildOptions)

  // Exercise the installed packager rather than duplicating its filename and WM_CLASS rules.
  expect(info.metadata.desktopName).toBe(`${helper.getDesktopFileName()}.desktop`)
  expect(helper.getDesktopFileName()).toBe(name)
  expect(linux.executableName).toBe(name)
  expect(entry).toContain(`StartupWMClass=${name}\n`)
  expect(entry).toContain(`Name=${productName}\n`)
  expect(entry).toContain(`Icon=${name}\n`)
  expect(entry).toMatch(new RegExp(`^Exec=.*/${name}"? %U$`, 'm'))
  expect(entry).toContain(`MimeType=x-scheme-handler/${name};\n`)
})
