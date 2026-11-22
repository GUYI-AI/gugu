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

  // What `reg export` writes (decoded from its UTF-16LE file): Path is REG_EXPAND_SZ, so it comes as hex(2) bytes.
  const hex2 = (value: string) =>
    [...Buffer.from(`${value}\0`, 'utf16le')].map((byte) => byte.toString(16).padStart(2, '0')).join(',')
  const regFile = (key: string, pathLine: string) =>
    `\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[${key}]\r\n"TEMP"=hex(2):25,00,00,00\r\n${pathLine}\r\n`
  const wrap = (hex: string) => hex.replace(/((?:[0-9a-f]{2},){24})/g, '$1\\\r\n  ')

  it('reads system then user PATH from the Windows registry, non-ASCII and %VAR% intact, keeping entries Gugu added', async () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm', USERPROFILE: 'C:\\Users\\张三' }
    const keys: string[] = []
    const read = await refreshUserPath({
      platform: 'win32',
      env,
      exportKey: async (key) => {
        keys.push(key)
        return key.startsWith('HKLM')
          ? regFile(key, `"Path"=hex(2):${wrap(hex2('C:\\windows\\;C:\\Program Files\\nodejs'))}`)
          : regFile(key, `"PATH"=hex(2):${wrap(hex2('%USERPROFILE%\\.local\\bin;%UNSET%\\x'))}`)
      },
    })
    expect(keys).toEqual(['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'])
    expect(read).toMatchObject({ from: 'windows-registry', hydrated: true })
    expect(env.Path).toBe(
      'C:\\windows\\;C:\\Program Files\\nodejs;C:\\Users\\张三\\.local\\bin;%UNSET%\\x;C:\\Users\\u\\AppData\\Roaming\\npm',
    )
  })

  it('reads a REG_SZ user Path as written, and a user without one', async () => {
    const machine = regFile('HKLM', `"Path"="C:\\\\Windows"`)
    const withSz: NodeJS.ProcessEnv = { Path: '' , USERPROFILE: 'C:\\u' }
    await refreshUserPath({ platform: 'win32', env: withSz, exportKey: async (key) => key.startsWith('HKLM') ? machine : regFile('HKCU', `"Path"="%USERPROFILE%\\\\bin"`) })
    expect(withSz.Path).toBe('C:\\Windows;%USERPROFILE%\\bin')
    const without: NodeJS.ProcessEnv = { Path: '' }
    const read = await refreshUserPath({ platform: 'win32', env: without, exportKey: async (key) => key.startsWith('HKLM') ? machine : regFile('HKCU', '') })
    expect(read.hydrated).toBe(true)
    expect(without.Path).toBe('C:\\Windows')
  })

  it('says how the registry read failed: a timeout, or what reg.exe printed', async () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const timedOut = await refreshUserPath({
      platform: 'win32', env,
      exportKey: async () => { throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) },
    })
    expect(timedOut).toMatchObject({ from: 'windows-registry', hydrated: false, reason: 'timed-out', detail: 'timed out after 5000 ms (SIGTERM)' })
    const denied = await refreshUserPath({
      platform: 'win32', env,
      exportKey: async () => { throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'ERROR: Access is denied.\r\n' }) },
    })
    expect(denied).toMatchObject({ hydrated: false, reason: 'probe-failed', detail: 'exit 1: ERROR: Access is denied.' })
    const empty = await refreshUserPath({ platform: 'win32', env, exportKey: async (key) => regFile(key, '') })
    expect(empty).toMatchObject({ hydrated: false, reason: 'invalid-output' })
    expect(env.Path).toBe('C:\\Windows')
  })

  it('says the read failed and leaves the PATH as it was', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' }
    const read = await refreshUserPath({ platform: 'darwin', env, probe: async () => { throw new Error('spawn /bin/zsh ENOENT') } })
    expect(read).toMatchObject({ from: 'login-shell', hydrated: false, reason: 'probe-failed', detail: 'spawn /bin/zsh ENOENT' })
    expect(env.PATH).toBe('/usr/bin')
  })
})
