import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { build, createServer, loadConfigFromFile } from 'vite'
import { PDFJS_RESOURCE_DIRECTORIES, pdfjsResources } from '../../../scripts/build/pdfjs-resources.mts'

const roots: string[] = []
const source = resolve('apps/desktop/node_modules/pdfjs-dist')
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gugu-pdfjs-resources-'))
  roots.push(root)
  writeFileSync(join(root, 'entry.js'), 'export const value = 1\n')
  return root
}

it('enables the pdf.js resources in the real renderer build configuration', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'test' },
    resolve('vite.config.mts')
  )
  expect(
    loaded?.config.plugins?.some(
      (plugin) =>
        plugin &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'gugu-pdfjs-resources'
    )
  ).toBe(true)
})

it.each(['./', '/nested/'])(
  'packages every installed pdf.js resource and its licenses with original names (base %s)',
  async (base) => {
    const root = fixture()
    const built = await build({
      configFile: false,
      root,
      base,
      logLevel: 'silent',
      plugins: [pdfjsResources()],
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, 'entry.js'), formats: ['es'] }
      }
    })
    const result = Array.isArray(built) ? built[0] : built
    if (!('output' in result)) throw new Error('Expected a completed renderer build')
    const emitted = new Map(
      result.output
        .filter((asset) => asset.type === 'asset')
        .map((asset) => [asset.fileName, asset.source])
    )
    const names = PDFJS_RESOURCE_DIRECTORIES.flatMap((directory) =>
      readdirSync(join(source, directory)).map((name) => `${directory}/${name}`)
    )
    for (const name of ['cmaps/Adobe-GB1-UCS2.bcmap', 'cmaps/LICENSE', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/LICENSE_FOXIT', 'wasm/openjpeg.wasm', 'wasm/LICENSE_OPENJPEG', 'iccs/CGATS001Compat-v2-micro.icc', 'iccs/LICENSE']) {
      expect(names).toContain(name)
    }
    expect(emitted.size).toBe(names.length)
    for (const name of names) {
      expect(Buffer.from(emitted.get(`pdfjs/${name}`)!)).toEqual(readFileSync(join(source, name)))
    }
  }
)

it.each(['/', '/nested/'])(
  'serves the pdf.js resources from the configured development base %s',
  async (base) => {
    const server = await createServer({
      configFile: false,
      root: fixture(),
      base,
      appType: 'custom',
      logLevel: 'silent',
      plugins: [pdfjsResources()],
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: [] }
    })
    try {
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string') throw new Error('Expected a loopback server')
      const prefix = `http://127.0.0.1:${address.port}${base}pdfjs/`
      const request = (name: string) =>
        fetch(`${prefix}${name}`, { headers: { connection: 'close' } })
      for (const [name, type] of [
        ['cmaps/Adobe-GB1-UCS2.bcmap', 'application/octet-stream'],
        ['standard_fonts/FoxitSerif.pfb', 'application/octet-stream'],
        ['wasm/openjpeg.wasm', 'application/wasm'],
        ['wasm/openjpeg_nowasm_fallback.js', 'text/javascript'],
        ['iccs/CGATS001Compat-v2-micro.icc', 'application/octet-stream']
      ]) {
        const response = await request(name)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(type)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(join(source, name)))
      }
      expect((await request('cmaps/unknown.bcmap')).status).toBe(404)
      expect((await request('cmaps/..%2F..%2Fpackage.json')).status).toBe(404)
      expect((await request('package.json')).status).toBe(404)
    } finally {
      await server.close()
    }
  }
)
