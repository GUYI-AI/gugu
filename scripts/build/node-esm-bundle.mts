import type { BuildOptions } from 'esbuild'

/**
 * Options for a standalone Node adapter bundled as one ESM file (dist-electron/runtime/*.mjs). Bundled CommonJS
 * dependencies call `require` for Node built-ins (`ws` needs `events`, `yaml` needs `process`), and an ESM file has no
 * `require`: without this banner the adapter dies at load with `Dynamic require of "events" is not supported`.
 */
export const NODE_ESM_BUNDLE = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
} satisfies BuildOptions
