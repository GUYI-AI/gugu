import { createServer } from 'node:http'
import { execFile } from '../../packages/core/src/local/childProcess.ts'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TestProject } from 'vitest/node'
import { readNativeCreationSkills } from '../../apps/desktop/electron/session/main/core/agents/create-skills'
import { checkedNativeSkillReply } from './native-reply'

declare module 'vitest' {
  export interface ProvidedContext { nativeSkillsBase: string }
}

// This runs the unmodified production filesystem scanner, not a canned skill catalog.
// It does NOT boot/register a desktop host; that separate acceptance remains required.
export default async function setup(project: TestProject) {
  const supplied = process.env.GUGU_SKILLS_CAPTURE_ROOT
  if (!supplied || !isAbsolute(supplied)) throw new Error('GUGU_SKILLS_CAPTURE_ROOT must name this run\'s private task directory')
  const parent = await fs.realpath(supplied)
  const nativeReceiptPath = process.env.GUGU_SKILLS_NATIVE_RECEIPT
  if (nativeReceiptPath && (!isAbsolute(nativeReceiptPath) || dirname(await fs.realpath(nativeReceiptPath)) !== join(parent, 'results'))) throw new Error('Receipt must physically belong to this private results directory before it is read')
  const nativeReceipt = nativeReceiptPath ? JSON.parse(await fs.readFile(nativeReceiptPath, 'utf8')) as {
    isolationRoot: string; codexHome: string; sourceSha: string; appVersion: string; pid: number; expectedSkillNames: string[]
  } : null
  if (nativeReceipt && (await fs.realpath(nativeReceipt.isolationRoot) !== parent || !nativeReceiptPath || await fs.realpath(dirname(nativeReceiptPath)) !== join(parent, 'results'))) {
    throw new Error('Native receipt/capture root must belong to the same owned isolation')
  }
  const nativeInside = (path: string) => isAbsolute(path) && relative(parent, path) !== '' && !relative(parent, path).startsWith('..')
  if (nativeReceipt && (!nativeInside(nativeReceipt.codexHome) || !nativeInside(await fs.realpath(nativeReceipt.codexHome)))) throw new Error('Native fixture home escaped owned root')
  const root = await fs.mkdtemp(join(parent, 'native-skills-capture-2953-'))
  const user = nativeReceipt ? join(nativeReceipt.codexHome, 'skills') : join(root, 'user')
  const folder = join(root, 'project'), invalid = join(user, `invalid-${root.split('/').at(-1)}`)
  let sequence = 0, actualNativeCalls = 0
  const invoke = promisify(execFile)
  const nativeRead = async (operation: 'read' | 'verify') => {
    if (!nativeReceiptPath || !nativeReceipt) throw new Error('Native receipt is not configured')
    const output = join(parent, 'results', `native-ui-${++sequence}-${operation}.json`)
    let exit = 0
    try {
      await invoke(process.execPath, [resolve('capture-tools/native-skills/isolated-host-read.mjs'), nativeReceiptPath, output, operation], { maxBuffer: 64 * 1024 })
    } catch (error) { exit = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1 }
    // Missing output/identity refusal is an infrastructure failure, never a made-up skills error.
    const result = JSON.parse(await fs.readFile(output, 'utf8'))
    if (result.sourceSha !== nativeReceipt.sourceSha || result.pid !== nativeReceipt.pid || result.appVersion !== nativeReceipt.appVersion) throw new Error('Native reader lost fixed source/version/owner binding')
    if (operation === 'verify') {
      if (exit !== 0 || result.actualSkillRpcCalls !== 0 || result.verifiedOwnedHost !== true) throw new Error('Owned native host verification failed')
      return null
    }
    const reply = checkedNativeSkillReply(result, exit, nativeReceipt)
    actualNativeCalls++
    return reply
  }
  const calls: { harness: string; projectId: string | null; ok: boolean; code?: string }[] = []
  const writeSkill = async (path: string, name: string, description: string) => {
    await fs.mkdir(path, { recursive: true })
    await fs.writeFile(join(path, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nIsolated capture instructions.\n`)
  }
  if (nativeReceipt) await nativeRead('verify')
  else {
    await writeSkill(join(user, 'meeting'), '会议记录', '整理会议记录与待办事项')
    await writeSkill(join(user, '.system', 'code'), '代码检查', '检查代码中的问题')
    await writeSkill(join(folder, 'meeting'), '会议记录', '项目优先的会议记录')
  }
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', Connection: 'close' }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET') { response.writeHead(405, headers).end(); return }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/scenario') {
        if (nativeReceipt) {
          await nativeRead('verify')
          if (!nativeInside(await fs.realpath(user))) throw new Error('Native skill directory escaped private root')
        }
        const mode = url.searchParams.get('mode')
        if (mode === 'malformed') { await fs.mkdir(invalid, { recursive: true }); await fs.writeFile(join(invalid, 'SKILL.md'), 'no frontmatter') }
        else if (mode === 'ready') await fs.rm(invalid, { recursive: true, force: true })
        else { response.writeHead(400, headers).end(JSON.stringify({ error: 'Unknown scenario' })); return }
        response.writeHead(200, headers).end(JSON.stringify({ ready: true })); return
      }
      if (url.pathname === '/calls') { response.writeHead(200, headers).end(JSON.stringify(calls)); return }
      if (url.pathname !== '/skills') { response.writeHead(404, headers).end(); return }
      const harness = url.searchParams.get('harness'), projectId = url.searchParams.get('projectId')
      if (harness !== 'codex' || projectId && projectId !== 'capture-project') {
        response.writeHead(400, headers).end(JSON.stringify({ error: 'Unexpected capture context' })); return
      }
      if (nativeReceipt) {
        if (projectId) throw new Error('Native capture supports only the original private default-directory context')
        const reply = await nativeRead('read')
        if (!reply) throw new Error('Native reader returned no skill result')
        calls.push({ harness, projectId: null, ok: reply.ok, ...(!reply.ok ? { code: reply.error.code } : {}) })
        response.writeHead(200, headers).end(JSON.stringify(reply)); return
      }
      try {
        const skills = await readNativeCreationSkills(projectId ? [folder, user] : [user])
        calls.push({ harness, projectId, ok: true })
        response.writeHead(200, headers).end(JSON.stringify({ ok: true, value: { skills } }))
      } catch (error) {
        calls.push({ harness, projectId, ok: false, code: 'skills_unavailable' })
        response.writeHead(200, headers).end(JSON.stringify({ ok: false, error: { code: 'skills_unavailable', message: error instanceof Error ? error.message : String(error) } }))
      }
    })().catch(error => { response.writeHead(500, headers).end(JSON.stringify({ error: String(error) })) })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    project.provide('nativeSkillsBase', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error }
  return async () => {
    const failures: unknown[] = []
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    catch (error) { failures.push(error) }
    const cleanup = [
      ...(nativeReceipt ? [
        () => fs.writeFile(join(parent, 'results', 'ui-native-bridge.json'), JSON.stringify({ mode: 'registered-native-rpc', sourceSha: nativeReceipt.sourceSha, appVersion: nativeReceipt.appVersion, pid: nativeReceipt.pid, actualNativeCalls, calls }, null, 2), { flag: 'wx', mode: 0o600 }),
        () => fs.rm(invalid, { recursive: true, force: true }),
      ] : []),
      () => fs.rm(root, { recursive: true, force: true }),
    ]
    for (const action of cleanup) {
      try { await action() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Native capture teardown was not clean')
  }
}
