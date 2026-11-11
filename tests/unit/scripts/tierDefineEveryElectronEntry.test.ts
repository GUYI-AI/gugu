import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '../../..')

/**
 * Every Electron bundle must be built with the same `__GUGU_TIER__`. The desktop preload once was not: it read the
 * identifier at runtime, got undefined, and never exposed the Beta Settings → 密码 bridge, so every Beta build showed
 * the password page with no way to reach the vault.
 */
describe('vite.config.mts bakes the build tier into every Electron entry', () => {
  it('main and both preloads define the same tier', () => {
    const code = `
      process.env.GUGU_TIER = 'beta'
      const m = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'vite.config.mts')).href)})
      process.stdout.write('READING ' + JSON.stringify(m.electronBuildEntries.map((e) => e.vite?.define?.__GUGU_TIER__ ?? null)))`
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: repoRoot, encoding: 'utf8', env: process.env })
    const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('READING '))
    expect(line, `${run.stdout}${run.stderr}`).toBeTruthy()
    const tiers = JSON.parse(line!.slice('READING '.length)) as (string | null)[]
    expect(tiers.length).toBeGreaterThanOrEqual(3)
    expect(tiers).toEqual(tiers.map(() => JSON.stringify('beta')))
  })
})
