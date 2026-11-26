// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// The record marks a turn's leading input with the turn's id (`task_started.turn_id`, codex-jsonl.ts). The live prompt
// carries the same point from its receipt on, not only from the turn's end, so the running turn and the record's copy of
// it can be told apart while it runs. A fake app-server stands in for codex; the wire is read unmodified.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let turnSeq = 0
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start') {
    const mode = process.env.HISTORY_MODE
    return out({ id: m.id, result: { thread: { id: 'th-anchor', ...(mode ? { historyMode: mode } : {}) }, model: 'm' } })
  }
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq)
    out({ method: 'item/started', params: { threadId: 'th-anchor', turnId, item: { type: 'userMessage', id: 'user-' + m.id, clientId: m.params.clientUserMessageId, content: m.params.input } } })
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: 'th-anchor', turn: { id: turnId, status: 'inProgress' } } })
    if (JSON.stringify(m.params.input ?? '').includes('FINISH')) {
      out({ method: 'turn/completed', params: { threadId: 'th-anchor', turn: { id: turnId, status: 'completed' } } })
    }
    return
  }
  if (m.method === 'turn/interrupt') {
    out({ id: m.id, result: {} })
    return out({ method: 'turn/completed', params: { threadId: 'th-anchor', turn: { id: m.params.turnId, status: 'interrupted' } } })
  }
  out({ id: m.id, result: { data: [] } })
})
`

type Update = { sessionUpdate: string; state?: string; stopReason?: string; _meta?: { guguRevert?: { before?: string } } }

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  const child = adapter
  adapter = null
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await exited
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function start(historyMode: string | undefined) {
  const raw = join(tmpdir(), `codex-receipt-anchor-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, ...(historyMode ? { HISTORY_MODE: historyMode } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, unknown>()
  const updates: Update[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    if (m.method === 'session/update') updates.push(m.params.update)
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const reply = (id: number, what: string) =>
    awaitFact(what, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  const idle = () => updates.filter((update) => update.sessionUpdate === 'state_update' && update.state === 'idle')
  return { send, reply, updates, idle }
}

async function openSession(rig: ReturnType<typeof start>) {
  await rig.reply(rig.send('initialize', { protocolVersion: 2, capabilities: {} }), 'initialize')
  const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
  return created.sessionId
}

const prompt = (text: string) => [{ type: 'text', text }]

describe('Codex ACP prompt receipt carries the turn it opened', () => {
  it('puts the turn id on the receipt while the turn is still running', async () => {
    const rig = start('paginated')
    const sessionId = await openSession(rig)
    const receipt = await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('HOLD') }), 'receipt')
    expect(receipt).toEqual({ messageId: expect.stringMatching(/^user-/), _meta: { guguRevert: { before: 'turn-1' } } })
    expect(rig.idle()).toEqual([])
  })

  it('gives the receipt the same point the turn ends with', async () => {
    const rig = start('paginated')
    const sessionId = await openSession(rig)
    const receipt = await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('FINISH') }), 'receipt') as Update
    const ended = await awaitFact('turn end', () => rig.idle()[0])
    expect(ended).toMatchObject({ stopReason: 'end_turn', _meta: { guguRevert: { before: 'turn-1' } } })
    expect(receipt._meta).toEqual(ended._meta)
  })

  it('keeps a bare receipt on a thread whose history cannot be reverted', async () => {
    const rig = start('legacy')
    const sessionId = await openSession(rig)
    const receipt = await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('FINISH') }), 'receipt')
    expect(receipt).toEqual({ messageId: expect.stringMatching(/^user-/) })
    const ended = await awaitFact('turn end', () => rig.idle()[0])
    expect(ended._meta).toBeUndefined()
  })
})
