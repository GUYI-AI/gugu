import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { NODE_CRYPTO_IMPORT, RELEASE_CONTRACT_FILE, RELEASE_CONTRACT_WEB_FILE, WEB_CRYPTO_IMPORT, webContractFrom } from '../../../scripts/build/release-contract-web.mts'

// #1931 The page (the desktop renderer, the phone) never loads a Node built-in for the release check. The mirrored contract
// imports `node:crypto`; in the desktop renderer that import became a shim calling `require`, and the window never started.
// So the page runs the contract's web copy, which differs from the mirror in that one import only.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const RELEASE_DIR = 'apps/desktop/src/session/shared/extensions/release'
const PAGE_ENTRIES = [
  `${RELEASE_DIR}/release-trust-web.ts`,
  'apps/desktop/src/components/appSlot/phoneMarket.ts',
  'apps/desktop/src/components/appSlot/phoneAssistantRules.ts',
  'apps/desktop/src/components/appSlot/phoneApps.ts',
]
const BUILTINS = new Set(builtinModules)
const isBuiltin = (specifier: string) => specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0]!)

/**
 * The Node built-ins `entry` reaches when bundled for a browser, as the page bundle is. Counted: any import of one, and any
 * use by this repository's own code. Not counted: a `require()` call inside a dependency (libsodium's guarded fallback for a
 * random source runs only where `crypto.getRandomValues` is missing; an import, by contrast, runs as the page loads).
 */
async function builtinsReached(entry: string): Promise<string[]> {
  const reached: string[] = []
  await build({
    entryPoints: [join(root, entry)], bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
    tsconfig: join(root, 'tsconfig.json'), absWorkingDir: root,
    plugins: [{
      name: 'node-builtins',
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, (args) => {
          if (!isBuiltin(args.path)) return undefined
          const ours = !relative(root, args.importer).split('/').includes('node_modules')
          if (ours || args.kind !== 'require-call') reached.push(`${args.path} <- ${relative(root, args.importer)} (${args.kind})`)
          return { path: args.path, external: true }
        })
      },
    }],
  })
  return reached
}

describe('the page\'s copy of the release contract', () => {
  it('is the mirrored contract with only its crypto import changed', () => {
    const mirror = readFileSync(RELEASE_CONTRACT_FILE, 'utf8')
    const web = readFileSync(RELEASE_CONTRACT_WEB_FILE, 'utf8')
    expect(web).toBe(webContractFrom(mirror))
    const changed = mirror.split('\n').flatMap((line, at) => (line === web.split('\n')[at] ? [] : [[line, web.split('\n')[at]]]))
    expect(changed).toEqual([[NODE_CRYPTO_IMPORT, WEB_CRYPTO_IMPORT]])
  })

  it('refuses a contract whose imports changed, rather than copying a new Node import into the page', () => {
    const mirror = readFileSync(RELEASE_CONTRACT_FILE, 'utf8')
    expect(() => webContractFrom(mirror.replace(NODE_CRYPTO_IMPORT, ''))).toThrow(/exactly/)
    expect(() => webContractFrom(mirror.replace(NODE_CRYPTO_IMPORT, `${NODE_CRYPTO_IMPORT}\nimport { readFileSync } from 'node:fs';`))).toThrow(/line 3/)
    expect(() => webContractFrom(mirror.replace(NODE_CRYPTO_IMPORT, "import { createHash, createPublicKey, verify } from 'crypto';"))).toThrow(/exactly/)
  })

  it('page code never imports the mirror itself; only main does', () => {
    const files = execFileSync('git', ['ls-files', 'apps/desktop/src', 'packages'], { cwd: root, encoding: 'utf8' }).split('\n')
      .filter((file) => /\.(m?[jt]sx?)$/.test(file) && !file.endsWith('.d.mts') && !/\.test\.tsx?$/.test(file))
    const importers = files.filter((file) => {
      const text = readFileSync(join(root, file), 'utf8')
      if (!text.includes('release-contract.mjs')) return false
      // Type-only imports are erased from the bundle; any other import or re-export of the mirror loads it.
      return ts.createSourceFile(file, text, ts.ScriptTarget.Latest).statements.some((statement) =>
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
          || ts.isExportDeclaration(statement) && !statement.isTypeOnly)
        && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text.endsWith('release-contract.mjs'))
    })
    expect(importers).toEqual([])
    // The check sees a value import of the mirror where there is one (main's binding).
    const main = 'apps/desktop/electron/session/main/core/extensions/release/market-release.ts'
    expect(readFileSync(join(root, main), 'utf8')).toMatch(/^import \{ verifyReleaseSignature \} from '@shared\/extensions\/release\/release-contract\.mjs'/m)
  })
})

describe('what the page loads for the release check', () => {
  it.each(PAGE_ENTRIES)('%s reaches no Node built-in', async (entry) => {
    expect(await builtinsReached(entry)).toEqual([])
  }, 30_000)

  it('the detector sees the mirror\'s own import (the path that took the desktop window down)', async () => {
    expect(await builtinsReached(`${RELEASE_DIR}/release-contract.mjs`)).toEqual([`node:crypto <- ${RELEASE_DIR}/release-contract.mjs (import-statement)`])
  })
})
