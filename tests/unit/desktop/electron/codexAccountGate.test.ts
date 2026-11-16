// @@@vitest-environment node
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  probeHarnessModelCatalog,
  setAcpSpawnResolver,
  setProbeConnectionModelResolver,
  setProbePlatformEnvResolver,
} from '../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog'

/**
 * Codex lists its built-in catalog without any login, so a signed-out user used to get a full "your Codex
 * models" group. The bridge now asks Codex (`account/read`) before opening a session. The fake app-server
 * answers `account/read` in the shapes measured on codex 0.163.0 / 0.169.0, chosen by FAKE_CODEX_ACCOUNT.
 */
const BRIDGE = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const FAKE_CODEX = `#!/usr/bin/env node
const out = m => process.stdout.write(JSON.stringify(m) + '\\n')
const accounts = {
  none: { account: null, requiresOpenaiAuth: true },
  apiKey: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
  custom: { account: null, requiresOpenaiAuth: false },
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'account/read') return out({ id: m.id, result: accounts[process.env.FAKE_CODEX_ACCOUNT] })
  if (m.method === 'thread/start' || m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: 'thread', turns: [] }, model: 'gpt-6.1-sol', reasoningEffort: 'medium' } })
  if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }] } })
  if (m.id !== undefined) out({ id: m.id, result: { data: [] } })
})
`

function fakeCodex(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'codex-account-gate-')), 'codex.cjs')
  writeFileSync(file, FAKE_CODEX)
  chmodSync(file, 0o755)
  return file
}

function bridgeEnv(account: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', GUGU_CODEX_BIN: fakeCodex(), FAKE_CODEX_ACCOUNT: account }
}

/** Raw ACP over the bridge's stdio: one request at a time, the answer (result or error) as sent. */
async function withBridge<T>(account: string, run: (request: (method: string, params: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }>) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [BRIDGE], { env: bridgeEnv(account), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, (message: { result?: unknown; error?: { code: number; message: string } }) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && !message.method) pending.get(message.id)?.(message)
  })
  let nextId = 1
  const request = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: { code: number; message: string } }>((done) => {
    const id = nextId++
    pending.set(id, done)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await request('initialize', { protocolVersion: 2 })
    return await run(request)
  } finally {
    child.kill('SIGKILL')
  }
}

describe('codex account gate at the ACP boundary', () => {
  it.each(['session/new', 'session/resume'])('signed-out own route: %s answers ACP authRequired', async (method) => {
    const answer = await withBridge('none', (request) => request(method, { cwd: tmpdir(), mcpServers: [], sessionId: 'thread' }))
    expect(answer.error).toMatchObject({ code: -32000, message: expect.stringContaining('Authentication required') })
  })

  it.each(['apiKey', 'custom'])('a Codex account or a custom provider (%s) still opens the session', async (account) => {
    const answer = await withBridge(account, (request) => request('session/new', { cwd: tmpdir(), mcpServers: [] }))
    expect(answer.error).toBeUndefined()
    expect(answer.result).toMatchObject({ sessionId: 'thread' })
  })

  it('session discovery stays open when signed out', async () => {
    const answer = await withBridge('none', (request) => request('session/list', {}))
    expect(answer).toMatchObject({ result: { sessions: [] } })
  })
})

describe('codex model catalog probe through the real bridge', () => {
  beforeEach(() => {
    setProbeConnectionModelResolver(async () => null)
  })
  afterEach(() => {
    setAcpSpawnResolver(async () => null)
    setProbePlatformEnvResolver(async () => ({ env: {} }))
  })

  it('signed out: auth-required (no own-model list), efforts still filled by the platform pass', async () => {
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [BRIDGE], env: bridgeEnv('none') }))
    // The second pass carries placeholder platform credentials; to Codex that is a custom provider.
    setProbePlatformEnvResolver(async () => ({ env: { FAKE_CODEX_ACCOUNT: 'custom' } }))
    const state = await probeHarnessModelCatalog('codex', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.efforts.map((effort) => effort.id)).toEqual(['low', 'medium'])
  })

  it('signed in: the own catalog is ready', async () => {
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [BRIDGE], env: bridgeEnv('apiKey') }))
    const state = await probeHarnessModelCatalog('codex', 'acp')
    expect(state).toMatchObject({ kind: 'ready', models: [expect.objectContaining({ id: 'gpt-6.1-sol' })] })
  })
})
