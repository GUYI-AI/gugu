// Import graph rules (dependency-cruiser). Severities are `warn` while the baseline is being paid down;
// CI compares counts against the last summary rather than failing on the existing debt.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Import cycles make load order and module boundaries implicit.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A source file nothing imports and that is not an entry is dead or misplaced.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$',
          '[.]d[.]ts$',
          '(^|/)tsconfig[.]json$',
          '(^|/)(?:vite|vitest|playwright|postcss|tailwind|i18next|capacitor)[.]config[.](?:js|cjs|mjs|ts|cts|mts)$',
          '[.](?:test|spec)[.](?:ts|tsx|mts|js|mjs)$',
          '(^|/)scripts/',
          '(^|/)tests/',
          '-entry[.](?:ts|mts|tsx)$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'An import that does not resolve fails at runtime or only works by accident.',
      from: {},
      // Vite query imports (`?raw`, `?inline`, `?url`) and the macOS-only optional `fsevents` resolve at build time.
      to: { couldNotResolve: true, pathNot: ['[?](?:raw|inline|url|worker)$', '^fsevents$'] },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      comment: 'Product code must not import test files.',
      from: { pathNot: '[.](?:test|spec)[.](?:ts|tsx|mts|js|mjs)$|(^|/)tests/|(^|/)testing/|(^|/)__tests__/' },
      to: { path: '[.](?:test|spec)[.](?:ts|tsx|mts|js|mjs)$' },
    },
    {
      name: 'no-renderer-to-main',
      severity: 'warn',
      comment: 'The renderer cannot load Electron main-process modules; only types may cross.',
      from: { path: '^apps/desktop/src/' },
      to: { path: '^apps/desktop/electron/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-packages-to-apps',
      severity: 'warn',
      comment: 'Shared packages must not reach into an app.',
      from: { path: '^packages/' },
      to: { path: '^apps/', dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: {
      path: [
        '(^|/)node_modules/',
        '(^|/)dist(-electron)?/',
        '(^|/)__generated__/',
        '^apps/desktop/preinstalled-apps/',
        '^apps/desktop/session-tooling/node-deps/',
        '^apps/mobile/(android|ios)/',
        '^examples/',
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'],
    },
    skipAnalysisNotInRules: true,
  },
}
