import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BASELINE_URL, captureAssistantRenders, fingerprint, readBaseline } from './capture'

// baseline.json holds the UTF-8 byte length and SHA-256 of every capture, written from origin/dev 4205711b66's rules files
// (unchanged at this branch's base) before the product text moved out of them. To re-derive it, run this file with
// GUGU_ASSISTANT_RULES_BASELINE=write on a checkout of that commit plus this folder. Rewriting it from the current code
// would compare the split with itself.

it('renders every assistant rule byte-for-byte as before the split', async () => {
  const current = Object.fromEntries(Object.entries(await captureAssistantRenders()).map(([key, value]) => [key, fingerprint(value)]))
  if (process.env.GUGU_ASSISTANT_RULES_BASELINE === 'write') writeFileSync(BASELINE_URL, `${JSON.stringify(current, null, 2)}\n`)
  const expected = readBaseline()
  expect(Object.keys(current).sort()).toEqual(Object.keys(expected).sort())
  const differing = Object.keys(expected).filter(key => current[key]!.sha256 !== expected[key]!.sha256 || current[key]!.bytes !== expected[key]!.bytes)
  expect(differing).toEqual([])
  expect(Object.keys(expected)).toHaveLength(71)
})

it('captures the same strings twice (no time, randomness or machine path leaks into the comparison)', async () => {
  expect(await captureAssistantRenders()).toEqual(await captureAssistantRenders())
})
