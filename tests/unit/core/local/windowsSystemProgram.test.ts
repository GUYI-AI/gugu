import { expect, test } from 'vitest'
import { windowsSystemProgram } from '../../../../packages/core/src/local/childProcess'

test('Windows system programs resolve under %SystemRoot%\\System32, whatever PATH says', () => {
  expect(windowsSystemProgram('reg.exe', { SystemRoot: 'D:\\Win', PATH: '' })).toBe('D:\\Win\\System32\\reg.exe')
  expect(windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe', { windir: 'E:\\W' }))
    .toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(windowsSystemProgram('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe')
})
