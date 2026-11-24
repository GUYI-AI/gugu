
import { describe, expect, it } from 'vitest'
import { enterUserDataDirectory } from '../../../../apps/desktop/electron/working-directory'

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
})
