import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawn } from '@gugu/core/local/childProcess'
import { describe, expect, it, vi } from 'vitest'
import { createServerTaskBrowser } from '../../../../apps/desktop/electron/server/server-task-browser'

const { version } = vi.hoisted(() => ({ version: vi.fn<() => Promise<{ stdout: string; stderr: string }>>() }))
vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }))
vi.mock('@gugu/core/local/childProcess', async importOriginal => ({
  ...await importOriginal<typeof import('@gugu/core/local/childProcess')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: version }),
  spawn: vi.fn(),
}))

async function crash(stderrChunks: string[], traceProfile?: string) {
  const profile = await mkdtemp(join(tmpdir(), 'gugu-task-browser-trace-'))
  const stderr = new PassThrough()
  const requests = new PassThrough()
  const replies = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid: 120,
    stderr,
    stdio: [null, null, stderr, requests, replies],
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
  })
  version.mockResolvedValueOnce({ stdout: 'Chromium 158.0.8127.36', stderr: '' })
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess)
  requests.on('data', (chunk: Buffer) => {
    const command = JSON.parse(chunk.toString().slice(0, -1))
    const result = ({
      'Target.createTarget': { targetId: 'test-page' },
      'Target.attachToTarget': { sessionId: 'test-session' },
      'Page.getFrameTree': { frameTree: { frame: { id: 'test-frame' } } },
      'Page.getNavigationHistory': { currentIndex: 0, entries: [] },
    } as Record<string, unknown>)[command.method] ?? {}
    queueMicrotask(() => replies.write(JSON.stringify({ id: command.id, result }) + '\0'))
  })
  const log = { info: vi.fn(), warn: vi.fn() }
  const browser = createServerTaskBrowser({ binary: () => '/fixture-chrome', profile, traceProfile, log })
  try {
    await browser.pageFor('tab', undefined, new AbortController().signal)
    for (const chunk of stderrChunks) stderr.write(chunk)
    child.signalCode = 'SIGABRT'
    child.emit('exit', null, child.signalCode)
    await browser.dispose()
    return log
  } finally {
    for (const stream of [stderr, requests, replies]) stream.destroy()
    await rm(profile, { recursive: true, force: true })
  }
}

describe('task browser exit diagnostics', () => {
  it('keeps traced crash details and strips URL, path, and credentials before writing the log', async () => {
    const log = await crash([
      '[42:ERROR:chrome/browser/private-source.cc:73] Crashpad failed (EACCES)\n',
      'Request failed: https://user:pw@private.', // A URL can span stderr chunks.
      'invalid/secret?q=hidden\n',
      'Profile failed: /Users/test-user/Application Support/private-profile\n',
      'Fallback: "C:\\Users\\test-user\\Private Chrome\\state"\n',
      'Relative: ../profiles/private-relative\n',
      'Paths=none,\\\\private-network\\test-share\n',
      'Could not read the file: permission denied\n',
      'Cookie: example=sensitive-cookie\n',
      'password=private-password\n',
      'Segmentation fault (11)\n',
    ], 'fixture-profile')
    const exit = log.info.mock.calls.map(([, fields]) => fields).find(fields => fields.event === 'exit')
    expect(exit).toMatchObject({ profile: 'fixture-profile', pid: 120, code: null, signal: 'SIGABRT' })
    expect(exit.stderr).toContain(':73] Crashpad failed (EACCES)')
    expect(exit.stderr).toContain('Segmentation fault (11)')
    expect(exit.stderr).toContain('Could not read the file: permission denied')
    expect(exit.stderr).toContain('[REDACTED_URL]')
    expect(exit.stderr).toContain('[REDACTED_PATH]')
    expect(exit.stderr).not.toMatch(/chrome\/browser|private|test-user|hidden|sensitive-cookie|user:pw|Application Support/)
  })

  it('drops a clipped first line even when the complete tail is short', async () => {
    const log = await crash([
      'file:///Users/test-user/' + 'a'.repeat(3500) + 'VERY_PRIVATE_TAIL',
      '\nChromium exited unexpectedly\n',
    ], 'fixture-profile')
    const exit = log.info.mock.calls.map(([, fields]) => fields).find(fields => fields.event === 'exit')
    expect(exit.stderr).toBe('Chromium exited unexpectedly')
  })

  it('keeps at most the last 500 characters after redaction', async () => {
    const completeTail = 'z'.repeat(600) + ' exit detail'
    const log = await crash([completeTail + '\n'], 'fixture-profile')
    const exit = log.info.mock.calls.map(([, fields]) => fields).find(fields => fields.event === 'exit')
    expect(exit.stderr).toBe(completeTail.slice(-500))
  })

  it('keeps the existing warning for browsers without a trace profile', async () => {
    const log = await crash(['server crash detail\n'])
    expect(log.warn).toHaveBeenCalledWith('Task browser exited', { code: null, signal: 'SIGABRT', stderr: 'server crash detail' })
  })
})
