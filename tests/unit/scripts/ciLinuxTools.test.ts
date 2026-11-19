import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import YAML from 'yaml'
import { verifiedArchive } from '../../../scripts/ci/setup-linux-tools.mjs'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const cache = await mkdtemp(join(tmpdir(), 'linux-ci-tools-'))
  cleanups.push(() => rm(cache, { recursive: true, force: true }))
  const bytes = Buffer.from('verified archive fixture')
  let requests = 0
  const server = createServer((_, response) => { requests++; response.end(bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address() as { port: number }
  return { cache, bytes, tool: { url: `http://127.0.0.1:${address.port}/tool`, sha256: createHash('sha256').update(bytes).digest('hex') }, requests: () => requests }
}

it('verifies a cold HTTP download and reuses a verified cache without network access', async () => {
  const { cache, bytes, tool, requests } = await fixture()
  expect(await verifiedArchive(tool, cache)).toEqual(bytes)
  expect(await readFile(join(cache, tool.sha256))).toEqual(bytes)
  expect(await verifiedArchive(tool, cache, () => { throw new Error('Network must not be needed on a cache hit') })).toEqual(bytes)
  expect(requests()).toBe(1)
})

it('rejects a corrupt cache before using it or silently replacing it', async () => {
  const { cache, tool, requests } = await fixture()
  await writeFile(join(cache, tool.sha256), 'corrupt')
  await expect(verifiedArchive(tool, cache)).rejects.toThrow('SHA256 mismatch')
  expect(requests()).toBe(0)
})

it('rejects a mismatched download without saving unverified bytes', async () => {
  const { cache, tool } = await fixture()
  await expect(verifiedArchive({ ...tool, sha256: '0'.repeat(64) }, cache)).rejects.toThrow('SHA256 mismatch')
  expect(await readdir(cache)).toEqual([])
})

it('keeps upstream HTTP failures fatal rather than using an empty artifact', async () => {
  const { cache, tool } = await fixture()
  await expect(verifiedArchive(tool, cache, async () => new Response('unavailable', { status: 503 }))).rejects.toThrow('HTTP 503')
  expect(await readdir(cache)).toEqual([])
})

it('keeps runtime Ubuntu dependency setup out of all CI workflow steps', async () => {
  for (const name of await readdir('.github/workflows')) {
    if (!name.endsWith('.yml')) continue
    const workflow = YAML.parse(await readFile(join('.github/workflows', name), 'utf8'))
    for (const job of Object.values(workflow.jobs) as { steps?: { run?: string; with?: Record<string, unknown> }[] }[]) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '', name).not.toMatch(/\bapt(?:-get|-install\.sh)?\b/)
        expect(step.with?.['with-deps'], name).not.toBe('true')
      }
    }
  }
})
