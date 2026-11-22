// @@@vitest-environment node
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCodexPreparation } from '@gugu/core/local/codex-initialize.mjs'
import { createJsonlReader, jsonlParseError } from '../../../../apps/desktop/electron/runtime/jsonl-reader.mjs'
import { awaitFact } from '../../../support/awaitFact'

const BRIDGE = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const TEXT = 'before\u2028middle\u2029after'
type WireMessage = { id?: number | null; result?: unknown; error?: { code: number; message: string }; method?: string; params?: { update?: { content?: { text?: string } } } }
const fixture = [
  '#!/usr/bin/env node',
  'const out = m => process.stdout.write(JSON.stringify(m) + "\\n");',
  'process.on("SIGTERM",()=>{require("fs").appendFileSync(process.env.RESUME_RELEASE+".signals","SIGTERM\\n");process.exit(0)});',
  'let raw = ""; process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => { raw += chunk; let end; while ((end=raw.indexOf("\\n"))!==-1) { const m=JSON.parse(raw.slice(0,end)); raw=raw.slice(end+1); if(m.id===undefined)continue;',
  'if (m.method==="initialize") { const ready=()=>out({id:m.id,result:{userAgent:"fixture"}}); const mode=process.env.SCENARIO; if(mode==="unsupported-initialize"){out({id:m.id,error:{code:-32601,message:"Method not found"}});continue;} if(mode==="initialize-slow"){process.stderr.write("NATIVE_INITIALIZE_PENDING\\n");const t=setInterval(()=>{if(require("fs").existsSync(process.env.RESUME_RELEASE)){clearInterval(t);ready()}},10)}else if(mode==="backfill-once"){const fs=require("fs"),file=process.env.RESUME_RELEASE+".attempt";let n=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8")):0;fs.writeFileSync(file,String(++n));if(n>1)ready();else {process.stderr.write("timed out waiting for state db backfill (status: running)\\n");process.exit(1)}}else ready();}',
  'else if (m.method==="thread/resume") {',
  ' if(process.env.SCENARIO==="bad") {process.stdout.write("{broken\\n"); continue;}',
  ' if(process.env.SCENARIO==="eof") {process.exit(7);}',
  ' if(m.params.excludeTurns!==true) {out({id:m.id,error:{code:-32602,message:"excludeTurns missing"}});continue;}',
  ' const ready=()=>out({id:m.id,result:{thread:{id:"same-thread",historyMode:"paginated",turns:[],preview:"before\\u2028middle\\u2029after"},model:"gpt-6.2-sol"}}); if(process.env.SCENARIO==="slow"){process.stderr.write("NATIVE_RESUME_PENDING\\n");const waiting=setInterval(()=>{if(require("fs").existsSync(process.env.RESUME_RELEASE)){clearInterval(waiting);ready()}},10)}else ready();',
  '} else if(m.method==="model/list") out({id:m.id,result:{data:[{id:"gpt-6.2-sol",model:"gpt-6.2-sol",displayName:"GPT-6.2-Sol",supportedReasoningEfforts:[]}]}});',
  'else if(m.method==="turn/start"){',
  ' out({method:"item/started",params:{item:{type:"userMessage",id:"user-1",clientId:m.params.clientUserMessageId,content:m.params.input}}});',
  ' out({id:m.id,result:{turn:{id:"turn-1",status:"completed"}}});',
  ' out({method:"item/agentMessage/delta",params:{threadId:"same-thread",turnId:"turn-1",itemId:"answer",delta:"before\\u2028middle\\u2029after"}});',
  ' out({method:"turn/completed",params:{threadId:"same-thread",turn:{id:"turn-1",status:"completed"}}});',
  '} else out({id:m.id,result:{data:[]}});',
  '}});',
].join('\n')

let dir = ''
let child: ChildProcess | undefined
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(done => child!.once('exit', done))
    child.kill('SIGTERM')
    await ended
  }
  child = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function bridge(scenario = 'unicode') {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-jsonl-')))
  const fake = join(dir, 'codex.cjs')
  writeFileSync(fake, fixture); chmodSync(fake, scenario === 'permission' ? 0o600 : 0o755)
  // Expire deadlines only after the native fixture acknowledges the in-flight resume.
  // The bridge's clock: the 45 s / 120 s deadlines can be expired on demand, and the 5 s wait before a backfill retry
  // (backfill-once) is 10 ms. What is proven is the retry, not the length of the wait.
  const shim = join(dir, 'clock.mjs')
  writeFileSync(shim, "const realSet=globalThis.setTimeout, realClear=globalThis.clearTimeout, deadlines=new Map();\nglobalThis.setTimeout=(fn,ms,...args)=>{if(ms===5000&&process.env.SCENARIO==='backfill-once')ms=10;const timer=realSet(()=>{deadlines.delete(timer);fn(...args)},ms);if(ms===45000 || ms===120000)deadlines.set(timer,{fire:()=>fn(...args),ms});return timer;};\nglobalThis.clearTimeout=timer=>{deadlines.delete(timer);return realClear(timer);};\nprocess.on('message',message=>{if(message?.type!=='expire-deadlines')return;const pending=[...deadlines].filter(([,value])=>value.ms===message.ms);for(const [timer,value]of pending){deadlines.delete(timer);realClear(timer);value.fire()}process.send('deadlines-expired');});")
  const release = join(dir, 'release-resume')
  const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: join(dir, 'gugu'), GUGU_USER_DATA_DIR: join(dir, 'userdata'),
    CODEX_HOME: join(dir, 'codex-home'), GUGU_CODEX_BIN: fake, SCENARIO: scenario, RESUME_RELEASE: release }
  delete env.GUGU_PLATFORM_MODELS
  child = spawn(process.execPath, (scenario === 'slow' || scenario === 'backfill-once' || scenario.startsWith('initialize-')) ? ['--import', shim, BRIDGE] : [BRIDGE], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  const processChild = child
  const { stdin, stdout, stderr: errorOutput } = processChild
  if (!stdin || !stdout || !errorOutput) throw new Error('Bridge fixture requires piped stdio')
  const replies = new Map<number | null, WireMessage>()
  const updates: WireMessage[] = []
  let stderr = ''
  errorOutput.on('data', bytes => { stderr += bytes.toString() })
  createJsonlReader({ input: stdout, onLine: (line: string) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) replies.set(m.id, m)
    else updates.push(m)
  } })
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = ++seq
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => replies.get(id), { producer: processChild })
  }
  await request('initialize', { protocolVersion: 2 })
  return { request, updates, replies, processChild, stdin, stderr: () => stderr,
    release: () => writeFileSync(release, 'ready'),
    expireDeadlines: (ms = 45000) => new Promise<void>(resolve => { processChild.once('message', () => resolve()); processChild.send({type:'expire-deadlines',ms}) }),
  }
}

describe('JSONL framing', () => {
  it('keeps Unicode separators inside responses and notifications, including split UTF-8 and CRLF', () => {
    const input = new PassThrough(), messages: unknown[] = []
    createJsonlReader({ input, onLine: (line: string) => messages.push(JSON.parse(line)) })
    const values = [{ id: 1, result: TEXT }, { method: 'delta', params: { text: TEXT } }]
    const bytes = Buffer.from(values.map(v => JSON.stringify(v)).join('\r\n') + '\r\n')
    for (const byte of bytes) input.write(Buffer.from([byte]))
    expect(messages).toEqual(values)
    input.end()
  })
  it('bounds parse diagnostics to byte length and 80-byte hex ends', () => {
    const error = jsonlParseError('native', 'x'.repeat(200))
    expect(error.message).toBe('Invalid JSONL from native: bytes=200 headHex=' + '78'.repeat(80) + ' tailHex=' + '78'.repeat(80))
  })
})

describe('Codex bridge native preparation', () => {
  it('an initialize slower than the old 45 second budget remains alive and completes before 120 seconds', async () => {
    const h = await bridge('initialize-slow');
    const opening = h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] });
    await awaitFact('native initializing', () => h.stderr().includes('NATIVE_INITIALIZE_PENDING') || undefined, { producer: h.processChild });
    await h.expireDeadlines(45000);
    expect(h.processChild.exitCode).toBeNull();
    h.release();
    expect(await opening).toHaveProperty('result');
  });
  it('keeps the same native process beyond 120 seconds without SIGTERM and eventually initializes', async () => {
    const h = await bridge('initialize-slow');
    const opening = h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] });
    await awaitFact('native initializing', () => h.stderr().includes('NATIVE_INITIALIZE_PENDING') || undefined, { producer: h.processChild });
    await h.expireDeadlines(120000);
    await awaitFact('120 second progress', () => h.stderr().split('\n').map(parseCodexPreparation).filter(p => p !== undefined).length >= 2 || undefined, { producer: h.processChild });
    expect(existsSync(join(dir, 'release-resume.signals'))).toBe(false);
    expect(h.processChild.exitCode).toBeNull();
    h.release();
    expect(await opening).toHaveProperty('result');
    expect(existsSync(join(dir, 'release-resume.signals'))).toBe(false);
    expect(h.stderr().match(/NATIVE_INITIALIZE_PENDING/g)).toHaveLength(1);
  });
  it('stops native preparation when the host cancels it', async () => {
    const h = await bridge('initialize-slow');
    const opening = h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] }).catch(() => undefined);
    await awaitFact('native initializing', () => h.stderr().includes('NATIVE_INITIALIZE_PENDING') || undefined, { producer: h.processChild });
    h.stdin.end();
    await awaitFact('native SIGTERM on cancellation', () => existsSync(join(dir, 'release-resume.signals')) || undefined, { producer: h.processChild });
    expect(readFileSync(join(dir, 'release-resume.signals'), 'utf8')).toBe('SIGTERM\n');
    await opening;
  });
  it('session/list also recovers a busy backfill lease without reporting upgrade', async () => {
    const h = await bridge('backfill-once');
    expect(await h.request('session/list', { cwd: dir })).toHaveProperty('result');
    expect(readFileSync(join(dir, 'release-resume.attempt'), 'utf8')).toBe('2');
    const progress = h.stderr().split('\n').map(parseCodexPreparation).filter(p => p !== undefined);
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'history' }));
    expect(progress.at(-1)).toBeNull();
    expect(h.stderr()).not.toContain('请升级');
  });
});

describe('Codex bridge JSONL boundary', () => {
  it('resumes metadata and preserves Unicode in host input and live notifications', async () => {
    const h = await bridge()
    expect(await h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] }))
      .toMatchObject({ result: { configOptions: [expect.objectContaining({ configId: 'model', currentValue: 'gpt-6.2-sol' })] } })
    expect(await h.request('session/prompt', { sessionId: 'same-thread', prompt: [{ type: 'text', text: TEXT }] }))
      .toHaveProperty('result.messageId')
    await awaitFact('Unicode delta', () => h.updates.find(m => m.params?.update?.content?.text === TEXT), { producer: h.processChild })
    expect(h.stderr()).not.toContain('Invalid JSONL')
  })
  it('keeps a live resume pending beyond the old deadline instead of reporting start failure', async () => {
    const h = await bridge('slow')
    const restoring = h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] })
    await awaitFact('native resume pending', () => h.stderr().includes('NATIVE_RESUME_PENDING') || undefined, { producer: h.processChild })
    await h.expireDeadlines()
    h.release()
    expect(await restoring)
      .toMatchObject({ result: { configOptions: [expect.objectContaining({ configId: 'model', currentValue: 'gpt-6.2-sol' })] } })
  })
  it('rejects corrupt native frames immediately with byte diagnostics', async () => {
    const h = await bridge('bad')
    const reply = await h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] })
    expect(reply).toMatchObject({ error: { message: expect.stringContaining('Invalid JSONL from Codex app-server stdout: bytes=7'), data: { codexStartupKind: 'protocol' } } })
    expect(h.stderr()).toContain('ERROR:')
    expect(h.stderr()).toContain('headHex=7b62726f6b656e')
  })
  it('preserves the real spawn permission failure as a permission reason', async () => {
    const h = await bridge('permission')
    expect(await h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] }))
      .toMatchObject({ error: { data: { codexStartupKind: 'permission' } } })
  })
  it('keeps an unsupported native initialize method as a protocol failure, without guessing its version', async () => {
    const h = await bridge('unsupported-initialize')
    expect(await h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] }))
      .toMatchObject({ error: { data: { codexStartupKind: 'protocol' } } })
  })
  it('reports true native exit immediately', async () => {
    const h = await bridge('eof')
    expect(await h.request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [] }))
      .toMatchObject({ error: { message: expect.stringContaining('exited (code=7'), data: { codexStartupKind: 'exited' } } })
  })
  it('reports corrupt host input as a parse error and terminates the broken channel', async () => {
    const h = await bridge()
    const ended = new Promise(resolve => h.processChild.once('exit', resolve))
    h.stdin.write('{broken\n')
    await ended
    expect(h.replies.get(null)).toMatchObject({ error: { code: -32700, message: expect.stringContaining('Invalid JSONL from ACP stdin') } })
    expect(h.processChild.exitCode).toBe(1)
  })
})
