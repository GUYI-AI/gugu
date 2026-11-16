import { readFile, writeFile, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, relative } from 'node:path'

// Read one real RPC from an ALREADY launched, owned, isolated Electron. Never launches,
// authenticates, creates work, restarts, closes, or attaches to the owner's desktop.
const [receiptPath, outputPath] = process.argv.slice(2)
if (!receiptPath || !outputPath) throw new Error('Usage: node isolated-host-read.mjs <owned-launch-receipt.json> <result.json>')
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
const root = await realpath(receipt.isolationRoot)
const inside = path => isAbsolute(path) && relative(root, path) !== '' && !relative(root, path).startsWith('..')
for (const path of [receipt.executable, receipt.guguHome, receipt.userData, receipt.osHome, receipt.codexHome, outputPath]) {
  if (typeof path !== 'string' || /\s/.test(path) || !inside(path)) throw new Error('Every input/output must be inside this owned isolation root, without whitespace')
}
for (const path of [receipt.executable, receipt.guguHome, receipt.userData, receipt.osHome, receipt.codexHome, dirname(outputPath)]) {
  const resolved = await realpath(path)
  if (resolved !== root && !inside(resolved)) throw new Error('A receipt path resolves outside this owned isolation root')
}
if (!Number.isInteger(receipt.pid) || receipt.pid <= 1 || receipt.pid === 48621) throw new Error('Refusing an unowned desktop PID')
if (!/^[a-f0-9]{40}$/.test(receipt.sourceSha) || typeof receipt.appVersion !== 'string') throw new Error('Missing fixed source/version')
if (!Array.isArray(receipt.expectedSkillNames) || !receipt.expectedSkillNames.length || receipt.expectedSkillNames.some(name => typeof name !== 'string' || !name)) throw new Error('Expected private fixture skill names are required')
const actualComm = execFileSync('/bin/ps', ['-p', String(receipt.pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
const actualStart = execFileSync('/bin/ps', ['-p', String(receipt.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
if (actualComm !== receipt.executable || actualStart !== receipt.startTime) throw new Error('Launch PID identity no longer matches')
// Only after private executable/PID/birth identity passes, inspect this owned child's
// effective merged environment. Raw environment is never emitted or saved.
const raw = execFileSync('/bin/ps', ['eww', '-p', String(receipt.pid), '-o', 'command='], { encoding: 'utf8' })
const env = key => new RegExp(`(?:^|\\s)${key}=([^\\s]+)(?:\\s|$)`).exec(raw)?.[1]
const required = { GUGU_HOME: receipt.guguHome, GUGU_USER_DATA_DIR: receipt.userData, HOME: receipt.osHome, CODEX_HOME: receipt.codexHome, GUGU_DEBUG_PORT: String(receipt.cdpPort) }
for (const [key, value] of Object.entries(required)) if (env(key) !== value) throw new Error(`Effective ${key} does not match isolation receipt`)
const override = /--user-data-dir=([^\s]+)/.exec(raw)?.[1]
if (override && override !== receipt.userData) throw new Error('CLI userData overrides isolated environment')
if (!Number.isInteger(receipt.cdpPort) || receipt.cdpPort < 1024 || receipt.cdpPort > 65535) throw new Error('Invalid private CDP port')
const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${receipt.cdpPort}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/)
if (listeners.length !== 1 || Number(listeners[0]) !== receipt.pid) throw new Error('CDP listener is not this owned launch')
const targets = await (await fetch(`http://127.0.0.1:${receipt.cdpPort}/json/list`, { signal: AbortSignal.timeout(15_000) })).json()
const target = targets.find(one => one.id === receipt.targetId && one.type === 'page' && (one.url.startsWith('gugu-app://') || one.url.startsWith('file://')))
if (!target) throw new Error('Owned application target is missing')
const debuggerUrl = new URL(target.webSocketDebuggerUrl)
if (debuggerUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(debuggerUrl.hostname) || Number(debuggerUrl.port) !== receipt.cdpPort) throw new Error('Debugger target escaped the private listener')
const socket = new WebSocket(debuggerUrl)
let seq = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data)), waiting = pending.get(message.id)
  if (!waiting) return
  clearTimeout(waiting.timer)
  pending.delete(message.id)
  message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result)
})
const command = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Isolated diagnostic command exceeded 30 seconds; no retry')) }, 30_000)
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error('Private debugger connection did not open; no retry')) }, 15_000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
  socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
})
try {
  const version = await command('Runtime.evaluate', { expression: 'window.electronAPI.getAppVersion()', awaitPromise: true, returnByValue: true })
  if (version.exceptionDetails || version.result?.value !== receipt.appVersion) throw new Error('Loaded application version differs from fixed receipt')
  const result = await command('Runtime.evaluate', {
    expression: `(async()=>{try{return {transport:'returned',reply:await window.electronAPI.invoke('sessionTimeline.sessionCreateSkills',{harness:'codex'})}}catch(error){return {transport:'rejected',error:{name:error?.name,code:error?.code,message:String(error?.message??error)}}}})()`,
    awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error('Isolated renderer evaluation failed before returning a skill RPC result')
  const value = result.result.value
  const skills = value.reply?.value?.skills
  if (Array.isArray(skills) && skills.some(skill => typeof skill.id !== 'string' || !inside(skill.id))) throw new Error('Native catalog escaped private isolation; no catalog data saved')
  const expectedSkillsPresent = Array.isArray(skills) && receipt.expectedSkillNames.every(name => skills.some(skill => skill.name === name))
  await writeFile(outputPath, JSON.stringify({ sourceSha: receipt.sourceSha, appVersion: receipt.appVersion, pid: receipt.pid, startTime: receipt.startTime, isolation: required, context: { harness: 'codex', projectId: null }, actualSkillRpcCalls: 1, expectedSkillsPresent, result: value }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  if (value.transport !== 'returned' || !value.reply?.ok || !expectedSkillsPresent) process.exitCode = 1
} finally { socket.close() }
