// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// `/goal` is codex's own thread goal: the adapter turns the typed line into `thread/goal/*` and shows the goal's status
// changes. A fake app-server stands in for codex and logs every request it receives, so the test reads the wire.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let goal = null
const thread = 'th-goal'
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  fs.appendFileSync(process.env.WIRE_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\\n')
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: thread }, model: 'm' } })
  if (m.method === 'skills/list') return out({ id: m.id, result: { data: [] } })
  if (m.method === 'thread/goal/set') {
    if (process.env.NO_GOALS) return out({ id: m.id, error: { code: -32601, message: 'method not found' } })
    const p = m.params
    goal = { threadId: thread, objective: p.objective ?? goal.objective, status: p.status ?? goal.status,
      tokenBudget: 'tokenBudget' in p ? p.tokenBudget : (goal ? goal.tokenBudget : null), tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
    const answer = { id: m.id, result: { goal } }
    // LATE_SET: codex's notifications reach the adapter before the answer to the set request.
    if (!process.env.LATE_SET) out(answer)
    out({ method: 'thread/goal/updated', params: { threadId: thread, turnId: null, goal } })
    if (goal.tokenBudget) {
      goal = { ...goal, status: 'budgetLimited', tokensUsed: goal.tokenBudget + 5 }
      out({ method: 'thread/goal/updated', params: { threadId: thread, turnId: 't1', goal } })
    }
    if (process.env.LATE_SET) out(answer)
    return
  }
  if (m.method === 'thread/goal/get') return out({ id: m.id, result: { goal } })
  if (m.method === 'thread/goal/clear') { const cleared = !!goal; goal = null; out({ id: m.id, result: { cleared } }); return out({ method: 'thread/goal/cleared', params: { threadId: thread } }) }
  out({ id: m.id, result: { data: [] } })
})
`

type Update = { sessionUpdate: string; title?: string; description?: string; availableCommands?: { name: string; input?: { type?: string; hint?: string } }[]; content?: unknown }

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

function start(extraEnv: Record<string, string> = {}) {
  const raw = join(tmpdir(), `codex-goal-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  const wire = join(dir, 'wire.jsonl')
  writeFileSync(fake, FAKE_CODEX)
  writeFileSync(wire, '')
  chmodSync(fake, 0o755)
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, WIRE_LOG: wire, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, { error?: { message: string } } | unknown>()
  const errors = new Map<number, { message: string }>()
  const updates: Update[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) {
      if (m.error) errors.set(m.id, m.error)
      responses.set(m.id, m.error ?? m.result)
    }
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
  const goalWire = () => readFileSync(wire, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter((entry) => entry.method.startsWith('thread/goal/') || entry.method === 'turn/start')
  const notices = () => updates.filter((update) => update.sessionUpdate === 'notice').map((update) => update.title)
  return { send, reply, updates, errors, goalWire, notices }
}

async function openSession(rig: ReturnType<typeof start>) {
  await rig.reply(rig.send('initialize', { protocolVersion: 2, capabilities: {} }), 'initialize')
  const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
  return created.sessionId
}

const prompt = (text: string) => [{ type: 'text', text }, { type: 'text', text: 'host context that is not the goal' }]

describe('Codex ACP /goal is codex thread goal', () => {
  it('advertises /goal with its token budget argument', async () => {
    const rig = start()
    await openSession(rig)
    const commands = await awaitFact('commands', () => rig.updates.find((update) => update.sessionUpdate === 'available_commands_update'))
    // The client reads commands through the ACP v2 schema, which drops an input that has no `type`.
    const goal = commands.availableCommands?.find((command) => command.name === 'goal')
    expect(goal?.input).toEqual({ type: 'text', hint: expect.stringContaining('--tokens') })
  })

  it('sets the goal with its token budget on codex and shows when codex stops it at the budget', async () => {
    const rig = start()
    const sessionId = await openSession(rig)
    const receipt = await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal --tokens 200k ship the fix') }), 'receipt')
    expect(receipt).toEqual({ messageId: expect.stringMatching(/^goal:/) })
    expect(rig.goalWire()).toEqual([{ method: 'thread/goal/set', params: {
      threadId: 'th-goal', origin: 'user', objective: 'ship the fix', status: 'active', tokenBudget: 200_000 } }])
    // The receipt follows the set answer's own notice; the budget notice is the last one codex sends. Both are in.
    await awaitFact('budget notice', () => rig.notices().find((title) => title?.startsWith('Goal stopped, token budget reached')))
    expect(rig.notices()).toEqual(['Goal active: 0 / 200,000 tokens', 'Goal stopped, token budget reached: 200,005 / 200,000 tokens'])
    expect(rig.updates.find((update) => update.sessionUpdate === 'user_message')?.content).toEqual(prompt('/goal --tokens 200k ship the fix'))
  })

  it('does not show the set answer\'s older state after a newer one that arrived first', async () => {
    const rig = start({ LATE_SET: '1' })
    const sessionId = await openSession(rig)
    await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal --tokens 200k ship the fix') }), 'receipt')
    // The receipt is sent only after the late answer was handled, so every notice is already in.
    expect(rig.notices()).toEqual(['Goal active: 0 / 200,000 tokens', 'Goal stopped, token budget reached: 200,005 / 200,000 tokens'])
    const shown = await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal') }), 'show')
    expect(shown).toEqual({ messageId: expect.stringMatching(/^goal:/) })
    expect(rig.notices().at(-1)).toBe('Goal stopped, token budget reached: 200,005 / 200,000 tokens')
  })

  it('leaves the budget to codex when none is typed, and clears the goal on codex', async () => {
    const rig = start()
    const sessionId = await openSession(rig)
    await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal ship it') }), 'set')
    await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal pause') }), 'pause')
    await rig.reply(rig.send('session/prompt', { sessionId, prompt: prompt('/goal clear') }), 'clear')
    expect(rig.goalWire().map((entry) => entry.params)).toEqual([
      { threadId: 'th-goal', origin: 'user', objective: 'ship it', status: 'active' },
      { threadId: 'th-goal', origin: 'user', status: 'paused' },
      { threadId: 'th-goal', origin: 'user' },
    ])
    expect(rig.notices()).toEqual(['Goal active: 0 tokens used', 'Goal paused: 0 tokens used', 'Goal cleared'])
  })

  it('refuses a malformed budget without touching codex', async () => {
    const rig = start()
    const sessionId = await openSession(rig)
    const id = rig.send('session/prompt', { sessionId, prompt: prompt('/goal --tokens lots ship it') })
    await rig.reply(id, 'refusal')
    expect(rig.errors.get(id)?.message).toContain('--tokens needs a positive token count')
    expect(rig.goalWire()).toEqual([])
  })

  it('says so when this codex has no goals', async () => {
    const rig = start({ NO_GOALS: '1' })
    const sessionId = await openSession(rig)
    const id = rig.send('session/prompt', { sessionId, prompt: prompt('/goal ship it') })
    await rig.reply(id, 'refusal')
    expect(rig.errors.get(id)?.message).toContain('This Codex version has no /goal')
  })
})
