import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHistoryFixture, VISIBLE_MARKER } from '../../../scripts/perf/native-history-fixture.mts'
import { validateSample } from '../../../scripts/perf/native-history-acceptance.mts'
import { assertAcceptanceScope, assertLegacySize, checkScopeLimits } from '../../../scripts/perf/native-history-safety.mts'

describe('history acceptance admission and fixture construction', () => {
  it('checks effective memory and CPU bounds and the strict legacy ceiling', () => {
    expect(() => checkScopeLimits('4294967296', '200000 100000')).not.toThrow()
    for (const [memory, cpu] of [['max', '200000 100000'], ['4294967297', '200000 100000'], ['1', 'max 100000'], ['1', '300000 100000']]) {
      expect(() => checkScopeLimits(memory, cpu)).toThrow()
    }
    expect(() => assertLegacySize(99_999_999)).not.toThrow()
    expect(() => assertLegacySize(100_000_000)).toThrow()
  })
  it('rejects a host that has not been explicitly admitted, before any large file creation', async () => {
    await expect(assertAcceptanceScope('')).rejects.toThrow('admitted Linux')
  })
  it.each(['claude', 'codex'] as const)('builds small %s semantic and poison-prefix fixtures', async provider => {
    const dir = await mkdtemp(join(tmpdir(), 'history-fixtures-'))
    try {
      for (const kind of ['sparse-io', 'valid-jsonl', 'legacy-giant'] as const) {
        const path = join(dir, kind)
        const metadata = await createHistoryFixture(path, 32 * 1024, kind, provider)
        const bytes = await readFile(path)
        expect(bytes.length).toBe(32 * 1024)
        expect(metadata.validJsonl).toBe(kind !== 'sparse-io')
        expect(metadata.giantRecords).toBe(kind === 'sparse-io' ? 0 : kind === 'legacy-giant' ? 1 : 2)
        if (kind !== 'sparse-io') {
          const records = bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
          expect(records.length).toBeGreaterThan(1)
          if (kind !== 'legacy-giant') expect(bytes.toString('utf8')).toContain(JSON.stringify(VISIBLE_MARKER).slice(1, -1))
        } else {
          expect(bytes.includes(Buffer.from('POISON_PREFIX'))).toBe(true)
          // Discovery needs a real LF before the tail, independently of the hole's unknown start.
          const lastLine = bytes.toString('utf8').split('\n').at(-2)!
          expect(JSON.stringify(JSON.parse(lastLine))).toContain(JSON.stringify(VISIBLE_MARKER).slice(1, -1))
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

// Synthetic controller controls only; these do not stand in for product measurements.
describe('history measurement result gate', () => {
  const sample = { evidence: 'desktop' as const, firstFrameMs: 1, firstReadablePaintMs: 2,
    readableText: VISIBLE_MARKER, placeholder: false, durableImportLocator: true, cacheState: 'absent',
    sourceBytes: 65536, indexBytes: 4096, decodedBytes: 65536, outputBytes: 1024 }
  it('requires readable painted content and real import locators', () => {
    expect(() => validateSample(sample, 'valid-jsonl', 'absent', true)).not.toThrow()
    for (const mutation of [{ evidence: 'reader' as const }, { placeholder: true }, { durableImportLocator: false },
      { sourceBytes: 524289 }, { firstReadablePaintMs: null }, { readableText: '' }, { cacheState: 'valid' }]) {
      expect(() => validateSample({ ...sample, ...mutation }, 'valid-jsonl', 'absent', true)).toThrow()
    }
  })
  it('does not treat a known giant locator or missing background/resume metrics as discovery', () => {
    expect(() => validateSample(sample, 'legacy-giant', 'absent', true)).toThrow()
    expect(() => validateSample({ ...sample, durableImportLocator: false }, 'legacy-giant', 'absent', true)).toThrow()
  })
})


describe('giant background measurement runtime validation', () => {
  const valid = { evidence: 'desktop' as const, firstFrameMs: 1, firstReadablePaintMs: null,
    readableText: '', placeholder: true, durableImportLocator: false, cacheState: 'absent',
    sourceBytes: 65536, indexBytes: 4096, decodedBytes: 0, outputBytes: 1024,
    background: { bytes: 629145600, elapsedMs: 2000, resumedFrom: 65536, maximumTaskMs: 4 } }
  it('accepts measured background work without mistaking the placeholder for readable paint', () => {
    expect(() => validateSample(valid, 'legacy-giant', 'absent', true)).not.toThrow()
  })
  it.each([undefined, {}, { bytes: NaN }, { elapsedMs: NaN }, { resumedFrom: NaN },
    { bytes: Infinity }, { elapsedMs: Infinity }, { maximumTaskMs: Infinity },
    { bytes: 0 }, { elapsedMs: 0 }, { resumedFrom: 0 }, { resumedFrom: 1.5 }])('rejects incomplete or invalid background data: %j', mutation => {
    const background = mutation === undefined ? undefined : { ...valid.background, ...mutation }
    // Deliberate malformed adapter output: an empty object must fail even without static types.
    const malformed = mutation && Object.keys(mutation).length === 0 ? {} : background
    expect(() => validateSample({ ...valid, background: malformed } as unknown as Parameters<typeof validateSample>[0], 'legacy-giant', 'absent', true)).toThrow()
  })
})
