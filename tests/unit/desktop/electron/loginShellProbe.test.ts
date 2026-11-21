import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hydrateLoginShellPath, loginShellEnvSnapshot, loginShellProbeArgs, refreshUserPath } from '../../../../apps/desktop/electron/shellPath'

// #6264 登录 shell 是 csh/tcsh 时也采得到环境(照 VS Code shellEnv.ts:tcsh/csh 走 `-ic`,其余 `-i -l -c`)。
describe('login shell probe args', () => {
  it('csh / tcsh use -ic and a script without the POSIX-only 2> redirect', () => {
    for (const shell of ['/bin/csh', '/usr/bin/tcsh']) {
      const [flag, script] = loginShellProbeArgs(shell)
      expect(flag).toBe('-ic')
      expect(script).not.toContain('2>')
    }
  })

  it('bash / zsh / fish keep -lic', () => {
    for (const shell of ['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh']) expect(loginShellProbeArgs(shell)[0]).toBe('-lic')
  })

  const realShell = (path: string) =>
    it.skipIf(!fs.existsSync(path))(`really captures PATH and the whole env from ${path}`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env, SHELL: path, GUGU_PROBE_MARK: 'x-1' }
      const result = hydrateLoginShellPath({
        platform: 'linux',
        env,
        probe: (shell, args, probeEnv) =>
          execFileSync(shell, args, { encoding: 'utf8', timeout: 10_000, env: { ...probeEnv, GUGU_PROBE_MARK: 'x-1' } }),
      })
      expect(result.hydrated).toBe(true)
      expect(loginShellEnvSnapshot()?.GUGU_PROBE_MARK).toBe('x-1')
    })
  realShell('/bin/tcsh')
  realShell('/bin/csh')
  realShell('/usr/bin/fish')
  realShell('/opt/homebrew/bin/fish')
})

// Every detection re-reads the user's current PATH: a CLI installed while Gugu runs must be found without a restart.
describe('refreshUserPath', () => {
  it('reads the current login-shell PATH ahead of the one Gugu started with', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/bash', PATH: '/usr/bin:/tmp/gugu-own' }
    const read = await refreshUserPath({
      platform: 'linux',
      env,
      probe: async () => '\x1f/home/u/.npm-global/bin:/usr/bin\x1f\x1f',
    })
    expect(read).toMatchObject({ from: 'login-shell', shell: '/bin/bash', hydrated: true })
    expect(env.PATH).toBe('/home/u/.npm-global/bin:/usr/bin:/tmp/gugu-own')
  })

  it('reads system then user PATH from the Windows registry, keeping entries Gugu added', async () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm' }
    const read = await refreshUserPath({
      platform: 'win32',
      env,
      probe: async (command) => {
        expect(command).toBe('powershell.exe')
        return 'C:\\windows\\;C:\\Program Files\\nodejs\x1fC:\\Users\\u\\.local\\bin'
      },
    })
    expect(read).toMatchObject({ from: 'windows-registry', hydrated: true })
    expect(env.Path).toBe('C:\\windows\\;C:\\Program Files\\nodejs;C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm')
  })

  it('says the read failed and leaves the PATH as it was', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' }
    const read = await refreshUserPath({ platform: 'darwin', env, probe: async () => { throw new Error('timeout') } })
    expect(read).toMatchObject({ from: 'login-shell', hydrated: false, reason: 'probe-failed' })
    expect(env.PATH).toBe('/usr/bin')
  })
})
