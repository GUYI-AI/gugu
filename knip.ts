// Dead-code scan (knip). Entries come from the build's own entry tables, so a new worker or preload
// is seen here without editing this file. Every finding is a candidate, not a verdict: dynamic imports
// by string, App/MCP surfaces and CD-called scripts must be checked before anything is deleted.
import type { KnipConfig } from 'knip'
import {
  desktopMainEntries,
  desktopPreloadEntry,
  extensionPreloadEntry,
  webHostEntries,
} from './scripts/build/product-build-entries.mts'

// Paths below are relative to the apps/desktop workspace.
const desktop = (path: string) => path.replace(/^.*?apps\/desktop\//, '')

const desktopEntries = [
  // Main, server, bridge and every worker (the build's own entry tables).
  ...Object.values(desktopMainEntries).map(desktop),
  ...Object.values(webHostEntries).map(desktop),
  desktop(desktopPreloadEntry),
  desktop(extensionPreloadEntry),
  // Renderer HTML entries (apps/desktop/index.html, session-embedded.html) load these scripts.
  'src/main.tsx',
  'src/lib/engine-polyfills.ts',
  'src/lib/startup-motion-bootstrap.ts',
  'src/session/renderer/embedded.tsx',
  // esbuild / fork / App-runtime entries named `*-entry.ts` and built one by one in vite.config.mts.
  '**/*-entry.{ts,mts,tsx}',
  '**/entry.{ts,mts}',
]

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: ['scripts/**/*.{ts,mts,mjs,cjs,js}', '*.config.{ts,mts,cjs,mjs}', 'electron-builder.cjs'],
      project: ['scripts/**/*.{ts,mts,mjs,cjs,js}', 'tests/**/*.{ts,tsx,mts,mjs}'],
      ignore: ['examples/**'],
    },
    'apps/desktop': {
      entry: desktopEntries,
      project: ['**/*.{ts,tsx,mts,mjs,cjs,js}'],
      ignore: ['preinstalled-apps/**', 'session-tooling/node-deps/**', '**/__generated__/**'],
    },
    'apps/mobile': {},
    'packages/*': {},
  },
}

export default config
