import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { deriveCheckProfiles } from '../../../scripts/ci/check-verdict.mts'

const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const devMacSource = readFileSync('.github/workflows/ci-dev-mac.yml', 'utf8')
const devMac = YAML.parse(devMacSource)
const devLinuxSource = readFileSync('.github/workflows/ci-dev-linux.yml', 'utf8')
const devLinux = YAML.parse(devLinuxSource)
const classifyScript = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === 'classify').run

function classify(files: string[], env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-mac-classify-'))
  try {
    const output = path.join(root, 'outputs')
    // Supply the diff at the shell boundary; never consult the real checkout or a network remote.
    const diff = 'git() { [ "$*" = "diff --name-only HEAD^1 HEAD" ] || return 98; printf "%s\\n" "$CLASSIFIER_FILES"; }\n'
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', diff + classifyScript], {
      cwd: root,
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        BASH_ENV: '/dev/null',
        GITHUB_OUTPUT: output,
        CLASSIFIER_FILES: files.join('\n'),
        EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'GUYI-AI/gugu',
        PR_HEAD_REPOSITORY: 'GUYI-AI/gugu',
        PR_HEAD_REF: 'fix/example',
        ...env,
      },
    })
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('PR macOS path classification', () => {
  it.each([
    '.github/workflows/ci.yml', '.github/actions/setup-community/action.yml',
    '.node-version', '.npmrc', 'package.json', 'packages/core/package.json',
    'apps/desktop/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/native.patch',
  ])('%s requires every platform build', file => {
    expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' })
  })

  it.each(['apps/desktop/native/addon.cc', 'apps/desktop/session-tooling/node-deps/package-lock.json'])(
    '%s requires Mac without adding Android', file => {
      expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'false', tests: 'true' })
    },
  )

  it.each([
    'apps/desktop/src/App.tsx', 'scripts/build-provenance.mjs', 'scripts/ci/check-verdict.mts',
    'vite.config.mts', 'electron-builder.cjs', 'build-resources/icon.icns',
    '.github/workflows/ci-dev-mac.yml', '.github/workflows/ci-dev-linux.yml',
  ])('%s still builds Linux/web without requiring PR Mac', file => {
    expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'false', 'desktop-linux': 'true', android: 'false', tests: 'true' })
  })

  it.each(['apps/mobile/src/main.ts', 'capacitor.config.ts', 'scripts/build/android-gradle-build.sh', 'scripts/build/phone-web-dir.mts'])(
    '%s preserves Android without requiring Mac', file => {
      expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'true', tests: 'true' })
    },
  )

  it('preserves documentation skips and combines mixed file lists', () => {
    expect(classify(['README.md', 'docs/guide.txt', '.github/actions/README.md']))
      .toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
    expect(classify(['apps/desktop/src/App.tsx', 'apps/desktop/native/addon.cc', 'apps/mobile/src/main.ts']))
      .toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' })
  })

  it('preserves the exact integration bypass and manual full build', () => {
    const full = { build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' }
    expect(classify(['README.md'], { PR_HEAD_REF: 'integration/beta-20261103' })).toEqual(full)
    expect(classify([], { EVENT_NAME: 'workflow_dispatch' })).toEqual(full)
    expect(classify(['README.md'], {
      PR_HEAD_REF: 'integration/beta-20261103', PR_HEAD_REPOSITORY: 'contributor/gugu',
    })).toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
    expect(classify(['README.md'], { PR_HEAD_REF: 'Integration/beta-20261103' }))
      .toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
  })
})

describe('dev verification workflow contracts', () => {
  const job = devMac.jobs['desktop-build-mac']

  it('keeps Mac automatic and Linux manual-only (the cache seeder runs its shards on push), and never lets a newer run displace an older commit verdict', () => {
    expect(devMac.on).toEqual({ push: { branches: ['dev'] }, workflow_dispatch: null })
    expect(devLinux.on).toEqual({ workflow_dispatch: null })
    // Manual-only is safe because the dev cache seeder runs the very same unit shards on every dev push.
    const shardRun = (workflow: { jobs: Record<string, { steps: Array<{ run?: string }> }> }) =>
      Object.values(workflow.jobs).flatMap(seeded => seeded.steps.map(step => step.run)).find(run => run?.startsWith('pnpm exec vitest run --project gugu'))
    expect(shardRun(devLinux)).toContain('--shard=${{ matrix.shard }}/6')
    expect(shardRun(YAML.parse(readFileSync('.github/workflows/ci-cache.yml', 'utf8')))).toBe(shardRun(devLinux))
    expect(ci.on).not.toHaveProperty('push')
    expect(devMac.concurrency).toBeUndefined()
    expect(devLinux.concurrency).toBeUndefined()
    expect(Object.keys(devMac.jobs)).toEqual(['desktop-build-mac'])
    expect(Object.keys(devLinux.jobs)).toEqual(['linux-checks', 'typecheck'])
    expect((Object.values(devLinux.jobs) as Array<{ concurrency?: unknown }>).every((job) => job.concurrency === undefined))
      .toBe(true)
  })

  it('keeps all hosted Mac steps, environments and timeout identical', () => {
    const [calleePath, sha] = ci.jobs['desktop-build-mac'].uses.replace('GUYI-AI/gugu/', '').split('@')
    const original = YAML.parse(execFileSync('git', ['show', `${sha}:${calleePath}`], { encoding: 'utf8' })).jobs.build
    expect(job['runs-on']).toBe('macos-15')
    expect(job['timeout-minutes']).toBe(original['timeout-minutes'])
    expect(devMac.env).toEqual(ci.env)
    expect(job.env).toEqual(original.env)
    expect(job.steps).toEqual(original.steps.slice(1).map((step: { uses?: string; with?: unknown }) => {
      if (step.uses === 'actions/checkout@v4') return { uses: step.uses }
      return step
    }))
    expect(devMac.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read' })
  })

  it('copies the same six Linux unit shards and runs typecheck once in its own job', () => {
    const original = ci.jobs.unit
    const linux = devLinux.jobs['linux-checks']
    expect(linux['runs-on']).toBe(original['runs-on'])
    expect(linux.strategy).toEqual(original.strategy)
    expect(linux.env).toEqual(original.env)
    expect(linux.steps).toEqual(original.steps.map(({ if: _condition, ...step }: { if?: unknown }) => step))
    expect(linux.permissions).toEqual({ contents: 'read', actions: 'read' })
    const typecheck = devLinux.jobs.typecheck
    expect(typecheck['runs-on']).toBe('ubuntu-24.04')
    expect(typecheck.strategy).toBeUndefined()
    expect(typecheck.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run))
      .toEqual(['pnpm typecheck'])
    expect(ci.jobs.policy.steps.some((step: { run?: string }) => step.run === 'pnpm typecheck')).toBe(true)
    expect(typecheck.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(devLinux.env).toEqual(devMac.env)
    expect(devLinux.permissions).toEqual(devMac.permissions)
  })

  it('canonical derives only Mac on dev push and all eight checks on manual runs', () => {
    const workflows = [
      { path: '.github/workflows/ci-dev-mac.yml', source: devMacSource },
      { path: '.github/workflows/ci-dev-linux.yml', source: devLinuxSource },
    ]
    const event = { id: 'push:dev', type: 'push', ref: 'refs/heads/dev', changedPaths: ['README.md'], inventoryRef: 'candidate', workflows }
    const profiles = deriveCheckProfiles([event])
    expect(profiles).toHaveLength(1)
    expect(profiles[0].checks).toEqual(['Dev desktop app build (macos-15)'])
    const manual = deriveCheckProfiles([{ ...event, id: 'manual', type: 'workflow_dispatch' }])
    expect(manual.flatMap(profile => profile.checks).sort()).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `Dev Linux checks (${i + 1}/6)`),
      'Dev typecheck',
      'Dev desktop app build (macos-15)',
    ].sort())
    expect(deriveCheckProfiles([{ ...event, id: 'push:main', ref: 'refs/heads/main' }])[0].checks).toEqual([])
    expect(deriveCheckProfiles([{ ...event, id: 'pr', type: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'dev' }])[0].checks).toEqual([])
  })
})
