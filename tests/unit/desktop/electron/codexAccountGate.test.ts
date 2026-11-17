// @@@vitest-environment node
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'
import {
  probeHarnessModelCatalog,
  setAcpSpawnResolver,
  setProbeConnectionModelResolver,
  setProbePlatformEnvResolver,
} from '../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog'

/**
 * The bridge asks Codex (`account/read`) before opening a session. The fake app-server answers in the shapes
 * measured on codex 0.163.0 / 0.169.0 (isolated CODEX_HOME), chosen by FAKE_CODEX_ACCOUNT: signed out, and
 * signed out with only OPENAI_API_KEY set, read `none`; `codex login --with-api-key` reads `apiKey`; a custom
 * provider reads `custom`.
 */
const BRIDGE = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const FAKE_CODEX = cachedFixtureExecutable('codex-account-gate.cjs', `#!/usr/bin/env node
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
`)

const bridgeEnv = (account: string) => ({ PATH: process.env.PATH ?? '', GUGU_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_ACCOUNT: account })

type Answer = { result?: unknown; error?: { code: number; message: string } }

/** Raw ACP over the bridge's stdio: `initialize`, then one request; its answer (result or error) as sent. */
async function askBridge(account: string, method: string): Promise<Answer> {
  const child = spawn(process.execPath, [BRIDGE], { env: bridgeEnv(account), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, (message: Answer) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && !message.method) pending.get(message.id)?.(message)
  })
  const request = (id: number, method: string, params: unknown) => new Promise<Answer>((done) => {
    pending.set(id, done)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await request(1, 'initialize', { protocolVersion: 2 })
    return await request(2, method, { cwd: tmpdir(), mcpServers: [], sessionId: 'thread' })
  } finally {
    child.kill('SIGKILL')
  }
}

describe('codex account gate at the ACP boundary', () => {
  it.each([
    ['session/new', 'none', true],
    ['session/resume', 'none', true],
    ['session/new', 'apiKey', false],
    ['session/new', 'custom', false],
    ['session/list', 'none', false],
  ])('%s with account %s: authRequired=%s', async (method, account, refused) => {
    const answer = await askBridge(account, method)
    if (refused) expect(answer.error).toMatchObject({ code: -32000, message: expect.stringContaining('Authentication required') })
    else expect(answer).toMatchObject({ result: expect.anything() })
  })
})

describe('codex model catalog probe through the real bridge', () => {
  afterEach(() => {
    setAcpSpawnResolver(async () => null)
    setProbePlatformEnvResolver(async () => ({ env: {} }))
  })

  it('signed out: auth-required (no own-model list), efforts still filled by the platform pass', async () => {
    setProbeConnectionModelResolver(async () => null)
    setAcpSpawnResolver(async () => ({ command: process.execPath, args: [BRIDGE], env: bridgeEnv('none') }))
    // The second pass carries placeholder platform credentials; to Codex that is a custom provider.
    setProbePlatformEnvResolver(async () => ({ env: { FAKE_CODEX_ACCOUNT: 'custom' } }))
    const state = await probeHarnessModelCatalog('codex', 'acp')
    expect(state.kind).toBe('auth-required')
    if (state.kind !== 'auth-required') return
    expect(state.efforts.map((effort) => effort.id)).toEqual(['low', 'medium'])
  })
})
