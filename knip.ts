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
  // Tests run from the root vitest projects; knip does not credit another workspace's test files.
  '**/*.test.{ts,tsx,mts}',
  'native/**/*.node-test.mjs',
  'session-tooling/generate-fixtures.ts',
  'electron/session/drizzle.config.ts',
]
const testEntries = ['**/*.test.{ts,tsx,mts}', '**/tests/**/*.{ts,tsx}', '**/fixtures/**/*.{mjs,ts,tsx}']

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: [
        'scripts/**/*.{ts,mts,mjs,cjs,js}', '*.config.{ts,mts,cjs,mjs}', 'electron-builder.cjs',
        'tests/**/*.test.{ts,tsx,mts}', 'tests/**/*.typecheck.ts', 'tests/fixtures/**', 'tests/mutation/**',
        'tests/unit/**/fixtures/**',
      ],
      project: ['scripts/**/*.{ts,mts,mjs,cjs,js}', 'tests/**/*.{ts,tsx,mts,mjs}'],
      ignore: ['examples/**'],
    },
    'apps/desktop': {
      entry: desktopEntries,
      project: ['**/*.{ts,tsx,mts,mjs,cjs,js}'],
      ignore: ['preinstalled-apps/**', 'session-tooling/node-deps/**', '**/__generated__/**'],
    },
    // The Android/iOS shells load the phone runtime by path.
    'apps/mobile': { entry: ['runtime/**/*.{mjs,js}'] },
    'packages/*': { entry: testEntries },
  },
}

export default config
