import { describe, expect, it } from 'vitest'
import { bumpPackageJson, compareVersions, nextVersion, planSync } from '../../../scripts/release/sync-stable-version.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('sync stable version (one 0.3.x series)', () => {
  it('dev always carries the number after stable, whichever line shipped it', () => {
    expect(nextVersion('0.3.10')).toBe('0.3.11')
    expect(nextVersion('0.3.9')).toBe('0.3.10')
    expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0)
    expect(() => nextVersion('0.3.10-beta.1.1')).toThrow(/plain/)
  })

  it('after a hotfix took the number dev held: tags it and opens the bump to the next one', () => {
    expect(planSync({ stable: '0.3.10', tagSha: null, sourceSha: A, devVersion: '0.3.10' })).toEqual([
      { type: 'tag', tag: 'v0.3.10', sha: A },
      { type: 'bump', from: '0.3.10', to: '0.3.11', branch: 'release-sync/dev-0.3.11' },
    ])
  })

  it('does nothing twice, and reports an open bump', () => {
    expect(planSync({ stable: '0.3.10', tagSha: A, sourceSha: A, devVersion: '0.3.11' })).toEqual([])
    expect(planSync({ stable: '0.3.10', tagSha: A, sourceSha: A, devVersion: '0.3.10', openPr: 7 })).toEqual([{ type: 'waiting', pr: 7, to: '0.3.11' }])
  })

  it('accepts a release tagged by hand before source.json existed', () => {
    expect(planSync({ stable: '0.3.10', tagSha: A, sourceSha: null, devVersion: '0.3.11' })).toEqual([])
  })

  it('fails loudly instead of guessing', () => {
    expect(() => planSync({ stable: '0.3.10', tagSha: B, sourceSha: A, devVersion: '0.3.11' })).toThrow(/not moving the tag/)
    expect(() => planSync({ stable: '0.3.10', tagSha: null, sourceSha: null, devVersion: '0.3.11' })).toThrow(/tag it by hand/)
    expect(() => planSync({ stable: '0.3.10', tagSha: A, sourceSha: A, devVersion: '0.3.12' })).toThrow(/skipped/)
  })

  it('changes only the top-level version of package.json', () => {
    const text = '{\n  "name": "gugu",\n  "version": "0.3.10",\n  "dependencies": {\n    "x": { "version": "0.3.10" }\n  }\n}\n'
    expect(bumpPackageJson(text, '0.3.10', '0.3.11')).toBe(text.replace('"version": "0.3.10",', '"version": "0.3.11",'))
    expect(() => bumpPackageJson(text, '0.3.9', '0.3.11')).toThrow(/not 0\.3\.9/)
  })
})
