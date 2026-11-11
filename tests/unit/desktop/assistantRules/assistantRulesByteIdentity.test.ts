import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { captureAssistantRenders } from './capture'

// baseline.json holds the UTF-8 byte length and SHA-256 of every capture, written from origin/dev 4205711b66's rules files
// (unchanged at this branch's base) before the product text moved out of them. To re-derive it, run this file with
// GUGU_ASSISTANT_RULES_BASELINE=write on a checkout of that commit plus this folder. Rewriting it from the current code
// would compare the split with itself.
const BASELINE = new URL('./baseline.json', import.meta.url)
type Fingerprint = { bytes: number; sha256: string }

export function fingerprints(renders: Record<string, string>): Record<string, Fingerprint> {
  return Object.fromEntries(Object.entries(renders).map(([key, value]) => {
    const bytes = Buffer.from(value, 'utf8')
    return [key, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  }))
}

it('renders every assistant rule byte-for-byte as before the split', async () => {
  const current = fingerprints(await captureAssistantRenders())
  if (process.env.GUGU_ASSISTANT_RULES_BASELINE === 'write') writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
  const expected = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, Fingerprint>
  expect(Object.keys(current).sort()).toEqual(Object.keys(expected).sort())
  const differing = Object.keys(expected).filter(key => current[key]!.sha256 !== expected[key]!.sha256 || current[key]!.bytes !== expected[key]!.bytes)
  expect(differing).toEqual([])
  expect(Object.keys(expected)).toHaveLength(71)
})

it('captures the same strings twice (no time, randomness or machine path leaks into the comparison)', async () => {
  expect(await captureAssistantRenders()).toEqual(await captureAssistantRenders())
})
