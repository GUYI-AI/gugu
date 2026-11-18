import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installerFailureLogPath,
  reportInstallerFailures,
  unreportedInstallerFailures,
} from '../../../../apps/desktop/electron/installer-failure-log'

let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

const line = (n: number) => JSON.stringify({ time: `2026-11-16T08:22:${String(n).padStart(2, '0')}Z`, phase: 'commit', error: `denied ${n}` })

describe('installer failure log', () => {
  it('is named after the executable, the same name the installer helper derives', () => {
    expect(installerFailureLogPath('C:\\ProgramData', 'C:\\Program Files\\gugu-beta\\gugu-beta.exe'))
      .toBe(win32.join('C:\\ProgramData', 'gugu', 'installer', 'gugu-beta.log'))
  })

  it('reports only lines after the last reported one, without comparing clocks', () => {
    expect(unreportedInstallerFailures([line(1), line(2), ''], null)).toEqual([line(1), line(2)])
    expect(unreportedInstallerFailures([line(1), line(2), line(3)], line(2))).toEqual([line(3)])
    expect(unreportedInstallerFailures([line(1), line(2)], line(2))).toEqual([])
    // The reported line fell off the installer's 50-line cap: what is left is all newer.
    expect(unreportedInstallerFailures([line(7), line(8)], line(2))).toEqual([line(7), line(8)])
  })

  it('copies each new failure into the app log once', () => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-installer-log-'))
    const logPath = join(dir, 'gugu-beta.log')
    const seenPath = join(dir, 'seen')
    const reported: unknown[] = []
    const report = (entry: unknown) => { reported.push(entry) }

    expect(reportInstallerFailures({ logPath, seenPath, report })).toBe(0)
    writeFileSync(logPath, `${line(1)}\r\n${line(2)}\r\n`)
    expect(reportInstallerFailures({ logPath, seenPath, report })).toBe(2)
    expect(reported).toEqual([JSON.parse(line(1)), JSON.parse(line(2))])
    expect(reportInstallerFailures({ logPath, seenPath, report })).toBe(0)

    writeFileSync(logPath, `${line(1)}\r\n${line(2)}\r\nnot json\r\n`)
    expect(reportInstallerFailures({ logPath, seenPath, report })).toBe(1)
    expect(reported.at(-1)).toBe('not json')
    expect(readFileSync(seenPath, 'utf8')).toBe('not json')
  })
})
