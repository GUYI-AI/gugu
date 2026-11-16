import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TestProject } from 'vitest/node'
import { readNativeCreationSkills } from '../../apps/desktop/electron/session/main/core/agents/create-skills'

declare module 'vitest' {
  export interface ProvidedContext { nativeSkillsBase: string }
}

// This runs the unmodified production filesystem scanner, not a canned skill catalog.
// It does NOT boot/register a desktop host; that separate acceptance remains required.
export default async function setup(project: TestProject) {
  const supplied = process.env.GUGU_SKILLS_CAPTURE_ROOT
  if (!supplied || !isAbsolute(supplied)) throw new Error('GUGU_SKILLS_CAPTURE_ROOT must name this run\'s private task directory')
  const parent = await fs.realpath(supplied)
  const root = await fs.mkdtemp(join(parent, 'native-skills-capture-2953-'))
  const user = join(root, 'user'), folder = join(root, 'project'), invalid = join(user, 'invalid')
  const calls: { harness: string; projectId: string | null; ok: boolean; code?: string }[] = []
  const writeSkill = async (path: string, name: string, description: string) => {
    await fs.mkdir(path, { recursive: true })
    await fs.writeFile(join(path, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nIsolated capture instructions.\n`)
  }
  await writeSkill(join(user, 'meeting'), '会议记录', '整理会议记录与待办事项')
  await writeSkill(join(user, '.system', 'code'), '代码检查', '检查代码中的问题')
  await writeSkill(join(folder, 'meeting'), '会议记录', '项目优先的会议记录')
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', Connection: 'close' }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET') { response.writeHead(405, headers).end(); return }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/scenario') {
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
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    finally { await fs.rm(root, { recursive: true, force: true }) }
  }
}
