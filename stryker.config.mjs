// Mutation testing (Stryker). Files to mutate come from the command line (`--mutate`); the repo-health
// scan passes the files of the top hotspots, CI passes the files a PR changed. A whole-repo run is weeks of CPU.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'scripts/checks/repo-health/vitest.stryker.config.mts', related: true },
  // Mutate the checkout in place instead of copying the whole repo into a sandbox per run.
  // Stryker restores every file when it ends; do not run anything else in this checkout meanwhile.
  inPlace: true,
  coverageAnalysis: 'perTest',
  mutate: [],
  reporters: ['json', 'clear-text', 'progress'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  concurrency: 16,
  timeoutMS: 60000,
  cleanTempDir: 'always',
  ignoreStatic: true,
}
