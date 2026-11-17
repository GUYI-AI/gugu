import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enterUserDataDirectory } from '../../../../apps/desktop/electron/working-directory'

const main = readFileSync(join(__dirname, '../../../../apps/desktop/electron/main.ts'), 'utf8')
const at = (needle: string): number => {
  const index = main.indexOf(needle)
  expect(index, needle).toBeGreaterThan(-1)
  return index
}

// @@@app-cwd - on Windows the launch directory is the install directory; children that inherited it pinned it, and the
// installer could not rename it at update time.
describe('the desktop process works in its userData directory', () => {
  it('creates userData before entering it', () => {
    const calls: string[] = []
    enterUserDataDirectory('/profile/user-data', {
      mkdir: (dir) => void calls.push(`mkdir ${dir}`),
      chdir: (dir) => void calls.push(`chdir ${dir}`),
    })
    expect(calls).toEqual(['mkdir /profile/user-data', 'chdir /profile/user-data'])
  })

  it('enters it as soon as userData is final, before anything is written or started', () => {
    const enter = at("if (!SERVER_MODE) enterUserDataDirectory(app.getPath('userData'))")
    expect(at("app.setPath('userData', resolve(userDataDir))")).toBeLessThan(enter)
    for (const later of ['writeSharedUserDataPointer(app.getPath', 'initLogging({', "app.on('before-quit'", 'app.whenReady()']) {
      expect(enter).toBeLessThan(at(later))
    }
  })

  it('keeps no path that meant the launch directory', () => {
    expect(main).not.toMatch(/resolve\(process\.argv\[1\]\)/)
    expect(main).not.toMatch(/process\.cwd\(\)/)
  })
})
