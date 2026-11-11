import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Rollup } from 'vite'
import renderer from 'vite-plugin-electron-renderer'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeShimsIn, rendererNodeShimGuard } from '../../../scripts/build/renderer-node-shim-guard.mts'

// #1931 The desktop window stayed on the splash screen: the release contract's `node:crypto` became a shim calling
// `require`, which the renderer does not have. The guard refuses such a build; here it runs with the real Electron
// renderer plugin, minified, as the renderer build does.
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'renderer-node-shim-'))
// The plugin writes its shims under the nearest node_modules: this one, removed with `work`.
mkdirSync(join(work, 'node_modules'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function rendererBuild(name: string, source: string): Promise<string[]> {
  const entry = join(work, `${name}.ts`)
  writeFileSync(entry, source)
  const output = await build({
    configFile: false, logLevel: 'silent', root: work, cacheDir: join(work, 'node_modules', '.vite'),
    resolve: { alias: { '@gugu/core': join(repo, 'packages/core/src') } },
    build: { outDir: join(work, 'out', name), write: false, minify: true, rollupOptions: { input: entry, preserveEntrySignatures: 'strict' } },
    plugins: [renderer(), rendererNodeShimGuard(repo)],
  }) as Rollup.RollupOutput
  return output.output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds : []))
}

describe('the renderer build refuses Node built-ins', () => {
  it('names the shimmed built-ins and who imported them; leaves the guarded electron shim alone', () => {
    const importers = (id: string) => (id.endsWith('crypto.mjs') ? ['src/contract.mjs'] : [])
    expect(nodeShimsIn([
      '/r/apps/desktop/src/main.tsx',
      '/r/apps/desktop/node_modules/.vite-electron-renderer/crypto.mjs',
      '/r/apps/desktop/node_modules/.vite-electron-renderer/electron.mjs',
      '/r/apps/desktop/node_modules/.vite-electron-renderer/fs/promises.mjs',
    ], importers)).toEqual([{ module: 'crypto', importers: ['src/contract.mjs'] }, { module: 'fs/promises', importers: [] }])
  })

  it('fails a real renderer build that imports node:crypto', async () => {
    await expect(rendererBuild('node-crypto', "import { createHash } from 'node:crypto'\nexport const h = (s: string) => createHash('sha256').update(s).digest('hex')\n"))
      .rejects.toThrow(/\[renderer-node-shim\].*crypto \(imported by .*node-crypto\.ts\)/)
  }, 60_000)

  it('builds the page\'s release check: the contract\'s web copy, not the mirror and no shim', async () => {
    const web = join(repo, 'apps/desktop/src/session/shared/extensions/release/release-trust-web.ts')
    const modules = await rendererBuild('release', `export { verifyMarketRelease, verifyReleaseProof } from '${web}'\n`)
    expect(modules.some((id) => id.endsWith('/release-contract-web.mjs'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/release-crypto-web.ts'))).toBe(true)
    expect(modules.filter((id) => id.endsWith('/release-contract.mjs') || id.includes('.vite-electron-renderer'))).toEqual([])
  }, 60_000)
})
