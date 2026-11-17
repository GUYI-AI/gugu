// @@@vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { awaitFact } from '../../../support/awaitFact'

const ADAPTER = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const SOURCE = `#!/usr/bin/env node
const fs = require('node:fs')
const out = m => process.stdout.write(JSON.stringify(m) + '\\n')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
let turn = null, count = 0
fs.watch(process.env.FAST_CONTROL, () => {
 if (!turn) return
 out({ method: 'turn/completed', params: { threadId: 'thread', turn: { ...turn, status: 'completed' } } })
 turn = null
})
rl.on('line', line => {
 const m = JSON.parse(line)
 if (m.id === undefined || !m.method) return
 fs.appendFileSync(process.env.FAST_RECORD, JSON.stringify(m) + '\\n')
 let result = { data: [] }
 if (m.method === 'thread/start') result = { thread: { id: 'thread' }, model: 'unlisted-model', modelProvider: 'OpenAI' }
 if (m.method === 'model/list') result = { data: [
  { id: 'unlisted-model', serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  { id: 'standard-only', serviceTiers: [{ id: 'ultrafast', name: 'Ultrafast' }] },
 ] }
 if (m.method === 'turn/start') {
  turn = { id: 'turn-' + ++count, status: 'inProgress' }
  out({ method: 'turn/started', params: { threadId: 'thread', turn } })
  out({ method: 'item/started', params: { threadId: 'thread', turnId: turn.id, item: { type: 'userMessage', id: 'user-' + count, clientId: m.params.clientUserMessageId, content: m.params.input } } })
  result = { turn }
 }
 out({ id: m.id, result })
})
`

it('uses live model tiers, arms only the next turn, clears inherited Fast and hides unsupported models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-fast-'))
  const fake = join(dir, 'native.cjs'), record = join(dir, 'requests.jsonl'), control = join(dir, 'control')
  writeFileSync(fake, SOURCE); chmodSync(fake, 0o755)
  writeFileSync(record, ''); writeFileSync(control, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FAST_RECORD: record, FAST_CONTROL: control },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  type Reply = { result?: { configOptions?: Array<{ configId: string; currentValue: string }> }; error?: { code: number } }
  const replies = new Map<number, Reply>(), states: string[] = []
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) replies.set(m.id, m)
    const u = m.params?.update
    if (u?.sessionUpdate === 'state_update') states.push(u.state)
  })
  let nextId = 0
  const call = async (method: string, params: unknown) => {
    const id = ++nextId
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => replies.get(id), { producer: child })
  }
  const set = (configId: string, value: string) => call('session/set_config_option', { sessionId: 'thread', type: 'id', configId, value })
  const fast = (reply: Reply) => reply.result?.configOptions?.find(option => option.configId === 'fast')
  const requests = () => readFileSync(record, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> })
  const finish = async () => {
    const idleCount = states.filter(state => state === 'idle').length
    writeFileSync(control, String(Date.now()))
    await awaitFact('native turn completed', () => states.filter(state => state === 'idle').length > idleCount || undefined, { producer: child })
  }
  try {
    await call('initialize', { protocolVersion: 2, clientCapabilities: {} })
    expect(fast(await call('session/new', { cwd: dir, mcpServers: [] }))?.currentValue).toBe('off')
    expect(requests().find(r => r.method === 'thread/start')?.params.serviceTier).toBe('default')
    await call('session/prompt', { sessionId: 'thread', prompt: [{ type: 'text', text: 'first' }] })
    expect(states.at(-1)).toBe('running')
    expect(fast(await set('fast', 'on'))?.currentValue).toBe('on')
    expect(requests().filter(r => r.method === 'turn/start').map(r => r.params.serviceTierForTurn)).toEqual(['default'])
    expect(requests().filter(r => r.method === 'thread/settings/update')).toEqual([])
    await finish()
    await call('session/prompt', { sessionId: 'thread', prompt: [{ type: 'text', text: 'second' }] })
    expect(requests().filter(r => r.method === 'turn/start').at(-1)?.params.serviceTierForTurn).toBe('priority')
    await finish()
    expect(fast(await set('model', 'standard-only'))).toBeUndefined()
    expect((await set('fast', 'on')).error?.code).toBe(-32602)
    await call('session/prompt', { sessionId: 'thread', prompt: [{ type: 'text', text: 'third' }] })
    expect(requests().filter(r => r.method === 'turn/start').at(-1)?.params.serviceTierForTurn).toBe('default')
    await finish()
    await set('model', 'unlisted-model')
    expect(fast(await set('fast', 'off'))?.currentValue).toBe('off')
  } finally {
    const exited = once(child, 'close'); child.kill('SIGTERM'); await exited
    rmSync(dir, { recursive: true, force: true })
  }
})
