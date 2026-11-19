import type { Plugin } from 'vite'

// #1931 The desktop renderer has no Node: `require` is undefined there. vite-plugin-electron-renderer aliases every Node
// built-in the renderer imports to a shim module under `.vite-electron-renderer/`, whose first statement is
// `const avoid_parse_require = require; const _M_ = avoid_parse_require("crypto")` (minified: `const a=require,e=a("crypto")`).
// It throws as its chunk loads, and the window never leaves the splash screen: the release contract's `node:crypto` did
// exactly that. The alias decides it at build time and minification hides the name, so this checks the modules each chunk
// is made of. The `electron` shim is left alone: it asks `typeof require` before calling it.
const BUILTIN_SHIM = /[\\/]\.vite-electron-renderer[\\/](.+)\.mjs$/

export interface ShimmedImport { module: string; importers: readonly string[] }

/** The built-in shims the given chunk modules contain, with who imported each. */
export function nodeShimsIn(moduleIds: Iterable<string>, importersOf: (id: string) => readonly string[] = () => []): ShimmedImport[] {
  const found: ShimmedImport[] = []
  for (const id of moduleIds) {
    const module = BUILTIN_SHIM.exec(id)?.[1]
    if (module && module !== 'electron') found.push({ module, importers: importersOf(id) })
  }
  return found
}

export function rendererNodeShimGuard(root = process.cwd()): Plugin {
  return {
    name: 'gugu-renderer-node-shim-guard',
    generateBundle(_options, bundle) {
      const importersOf = (id: string) => (this.getModuleInfo(id)?.importers ?? []).map((importer) => importer.replace(root, '').replace(/^[\\/]/, ''))
      const shims = Object.values(bundle).flatMap((chunk) => (chunk.type === 'chunk' ? nodeShimsIn(chunk.moduleIds, importersOf) : []))
      if (shims.length > 0) {
        const what = shims.map(({ module, importers }) => `${module} (imported by ${importers.join(', ') || 'unknown'})`).join('; ')
        throw new Error(`[renderer-node-shim] the renderer imports Node built-ins it does not have, so it would crash as it loads: ${what}. Use a web implementation in page code.`)
      }
    },
  }
}
