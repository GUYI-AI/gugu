// #6264 咕咕 server 上会话里的程序要「打开网页」($BROWSER,如 `gh auth login --web`):照 VS Code 远端的
// $BROWSER,推到正看着这条会话的咕咕桌面上打开;不属于任何会话的进程(模型探针、安装器)开的网页到不了谁。
//
// 两段,都用真东西:
//  · 助手脚本与环境:真的写到临时目录、真的用 /bin/sh 跑(起法换成一个把参数原样打出来的假 gugu-server);
//  · `gugu-server open-url` → 真的 attach 套接字 → 账号进程里的应答 → 真的路由(remote-pane.ts),看哪台桌面收到。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPtyAttachServer, type AttachDeps } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import { OPEN_EXTERNAL_CALL } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import {
  browserHelperScripts,
  installServerBrowserHelpers,
  sessionBrowserEnv,
  setServerBrowserHelpers,
  withSessionBrowserEnv,
} from '../../../../apps/desktop/electron/session/main/core/pty/server-browser-env'
import { buildAgentEnv } from '../../../../apps/desktop/electron/session/main/core/pty/pty-env'
import { getSessionEnvVars } from '../../../../apps/desktop/electron/session/main/core/workspaces/workspace-env'
import { createRemotePaneRoute } from '../../../../apps/desktop/electron/session/main/core/session-timeline/remote-pane'
import type { SessionpagePaneOpenEvent } from '@gugu/session-core/session-record/contract'
import { quoteShellArg as shQuote } from '../../../../apps/desktop/electron/session/main/utils/shellEscape'
import { answerOpenExternal, type OpenExternalDeps } from '../../../../apps/desktop/electron/session/main/core/session-timeline/remote-open-external'
import { parseOpenUrlArgs, runOpenUrl } from '../../../../apps/desktop/electron/server/open-url-cli'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const ACCOUNT = '0f8fad5b-d9cb-469f-a165-70867728950e'

function sink() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
  return { stream, text: () => text }
}

describe('助手脚本与会话环境($BROWSER)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-browser-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    setServerBrowserHelpers(null)
  })

  // 假 gugu-server:把收到的参数一行一个打出来。路径里带空格与单引号,验证脚本的引号。
  function fakeLauncher(): string {
    const launcherDir = path.join(dir, "it's here")
    fs.mkdirSync(launcherDir)
    const file = path.join(launcherDir, 'gugu-server')
    fs.writeFileSync(file, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 })
    return file
  }

  it('gugu-browser hands its argument to `gugu-server open-url` verbatim', () => {
    const home = path.join(dir, 'home')
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: [fakeLauncher()] })
    const out = execFileSync('/bin/sh', [path.join(helpers, 'gugu-browser'), 'https://github.com/login/device?a=1&b=2'], {
      encoding: 'utf8',
    })
    expect(out.trim().split('\n')).toEqual(['open-url', '--', 'https://github.com/login/device?a=1&b=2'])
  })

  it('prefers the installed launcher (current/bin/gugu-server) so upgrades need no rewrite', () => {
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, 'current', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'current', 'bin', 'gugu-server'), '#!/bin/sh\necho installed "$@"\n', { mode: 0o755 })
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: ['/nope'] })
    expect(execFileSync('/bin/sh', [path.join(helpers, 'gugu-browser'), 'https://x.test/'], { encoding: 'utf8' }).trim()).toBe(
      'installed open-url -- https://x.test/'
    )
  })

  it('writes only gugu-browser and removes the xdg-open stand-in an older server left on PATH', () => {
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'xdg-open'), '#!/bin/sh\n', { mode: 0o755 })
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: [fakeLauncher()] })
    expect(fs.readdirSync(helpers)).toEqual(['gugu-browser'])
  })

  // The only door to a person's desktop is a session's own BROWSER: what is not a session never has it.
  it('only session processes carry BROWSER and their session; the shared agent env (probes, installers) does not', () => {
    expect(sessionBrowserEnv('conv-7')).toEqual({})
    expect(withSessionBrowserEnv('conv-7', undefined)).toBeUndefined()
    setServerBrowserHelpers({ dir: '/h/.gugu-server/bin', account: ACCOUNT })
    const session = { BROWSER: '/h/.gugu-server/bin/gugu-browser', GUGU_SERVER_ACCOUNT: ACCOUNT, GUGU_TASK_ID: 'conv-7' }
    expect(sessionBrowserEnv('conv-7')).toEqual(session)
    // ACP legs: merged into the session's capability spawn env.
    expect(withSessionBrowserEnv('conv-7', { A: '1' })).toEqual({ A: '1', ...session })
    // PTY legs, session terminals and scripts: the session env every one of them already gets.
    expect(getSessionEnvVars({ session: { id: 'conv-7', title: 'T' }, sessionPath: '/srv/app', folderPath: '/srv/app' })).toMatchObject(session)
    const shared = buildAgentEnv({ includeUserShellEnv: false })
    expect(shared.BROWSER).toBeUndefined()
    expect(shared.GUGU_TASK_ID).toBeUndefined()
  })

  it('quotes launcher words for sh', () => {
    expect(shQuote("a'b c")).toBe(`'a'\\''b c'`)
    expect(browserHelperScripts(['/x y/gugu-server'])['gugu-browser']).toContain(`exec '/x y/gugu-server' open-url -- "$@"`)
  })
})

describe('gugu-server open-url → attach 套接字 → 账号进程', () => {
  let home: string
  let server: { socketPath: string; close: () => Promise<void> } | null = null
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-openurl-'))
  })
  afterEach(async () => {
    await server?.close()
    server = null
    fs.rmSync(home, { recursive: true, force: true })
  })

  const account = (): ServerAccount => ({
    userId: ACCOUNT,
    email: 'a@example.com',
    addedAt: null,
    dir: home,
    dataDir: home,
    homeDir: home,
    signedIn: true,
    signedOut: null,
  })

  async function serve(deps: OpenExternalDeps) {
    const attachDeps: AttachDeps = {
      warn: vi.fn(),
      call: async (type, payload) =>
        type === OPEN_EXTERNAL_CALL ? answerOpenExternal(payload, deps) : { error: { code: 'unsupported_call', message: type } },
    }
    server = await startPtyAttachServer(home, attachDeps)
  }

  function fakeDeps(outcome: 'opened' | 'queued') {
    const open = vi.fn(async () => (outcome === 'opened' ? { opened: true as const } : { queued: true as const }))
    const deps: OpenExternalDeps = {
      route: { open },
      sessionRoot: async (sessionId) => (sessionId === 'conv-7' ? '/srv/app' : null),
      isFile: async () => true,
    }
    return { deps, open }
  }

  // The real route with desktops watching sessions; each desktop answers "opened" for what it is pushed.
  function realRoute(watching: Record<string, string>) {
    const route = createRemotePaneRoute()
    const pushed: Array<{ desktop: string; event: SessionpagePaneOpenEvent }> = []
    for (const [desktop, sessionId] of Object.entries(watching)) {
      route.subscribe({ subscriptionId: desktop, sessionId, browser: true, pages: true, external: true }, (event) => {
        pushed.push({ desktop, event })
        queueMicrotask(() => route.ack({ requestId: event.request.requestId, subscriptionId: desktop, ok: true }))
      })
    }
    const deps: OpenExternalDeps = { route, sessionRoot: async () => '/srv/app', isFile: async () => true }
    return { route, pushed, deps }
  }

  async function openUrl(target: string, env: NodeJS.ProcessEnv) {
    const err = sink()
    const code = await runOpenUrl([target], { stdout: sink().stream, stderr: err.stream }, {
      env: { GUGU_SERVER_ACCOUNT: ACCOUNT, ...env },
      cwd: () => '/srv/app',
      account: () => account(),
    })
    return { code, stderr: err.text() }
  }

  it('a session tool opens the page only on the desktop watching that session', async () => {
    const { pushed, deps } = realRoute({ mine: 'conv-7', other: 'conv-2' })
    await serve(deps)
    const { code, stderr } = await openUrl('https://github.com/login/device', { GUGU_TASK_ID: 'conv-7' })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(pushed.map(({ desktop, event }) => [desktop, event.request.target])).toEqual([
      ['mine', { kind: 'external', url: 'https://github.com/login/device' }],
    ])
  })

  // A model probe runs a CLI that wants to sign in; it is no session, even with a desktop watching another one.
  it('a program outside any session reaches no desktop: exit 1 and the URL printed', async () => {
    const { pushed, deps } = realRoute({ other: 'conv-2' })
    await serve(deps)
    const { code, stderr } = await openUrl('https://sign-in.test/cli-auth', {})
    expect(code).toBe(1)
    expect(stderr).toContain('https://sign-in.test/cli-auth')
    expect(pushed).toEqual([])
  })

  it('nobody watching the session: no_viewer, exit 1 with the URL, and nothing opens later', async () => {
    const { route, pushed, deps } = realRoute({})
    await serve(deps)
    const { code, stderr } = await openUrl('https://x.test/', { GUGU_TASK_ID: 'conv-7' })
    expect(code).toBe(1)
    expect(stderr).toContain('https://x.test/')
    expect(route.subscribe({ subscriptionId: 'late', sessionId: 'conv-7', browser: true, external: true }, () => undefined).pending).toEqual([])
    expect(pushed).toEqual([])
  })

  it('a file the session asks for while nobody looks is kept for the session (exit 0, said plainly)', async () => {
    const { deps, open } = fakeDeps('queued')
    await serve(deps)
    const { code, stderr } = await openUrl('report.html', { GUGU_TASK_ID: 'conv-7' })
    expect(code).toBe(0)
    expect(stderr).toContain('report.html')
    expect(open).toHaveBeenCalledWith('conv-7', { kind: 'browser', url: 'file:///srv/app/report.html' }, 'pinned')
  })

  it('fails with exit 1 and the URL when the account process is not running', async () => {
    const err = sink()
    const code = await runOpenUrl(['https://x.test/'], { stdout: sink().stream, stderr: err.stream }, {
      env: {},
      cwd: () => '/',
      account: () => (account()),
    })
    expect(code).toBe(1)
    expect(err.text()).toContain('https://x.test/')
  })

  it('parses args: --account, the env fallback, and -- before the target', () => {
    expect(parseOpenUrlArgs(['--account', ACCOUNT, 'https://a/'], {})).toEqual({ account: ACCOUNT, target: 'https://a/' })
    expect(parseOpenUrlArgs(['--', '--account'], { GUGU_SERVER_ACCOUNT: ACCOUNT })).toEqual({ account: ACCOUNT, target: '--account' })
    expect(parseOpenUrlArgs([], {})).toMatchObject({ error: expect.any(String) })
    expect(parseOpenUrlArgs(['--account', 'bad id', 'x'], {})).toMatchObject({ error: expect.any(String) })
  })
})
