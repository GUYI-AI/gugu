import { describe, expect, it } from 'vitest'
import type { UsageDay } from '../../../../packages/core/src/shared/usage/dailyUsage'
import { engineRows } from '../../../../apps/desktop/src/lib/usage/derive'
import { cacheHitSeries, combinedCacheHitRate, inputCacheHitRate, isInputCacheTracked } from '../../../../apps/desktop/src/lib/usage/cacheHitRate'
import { TOKEN_LOG_READERS } from '../../../../apps/desktop/electron/session/main/core/usage/token-readers/registry'

const range = { from: '2026-11-01', to: '2026-11-03', days: 3 }
function day(engine: string, values: Partial<UsageDay> = {}): UsageDay {
  return {
    day: range.from, engine, sessions: 1, runSeconds: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    models: {}, guguModels: {}, byokModels: {}, hours: Array(24).fill(0),
    parallelSeconds: 0, peakConcurrency: 0, ...values,
  }
}

describe('input cache hit rate', () => {
  it('includes cache writes and excludes output from all input', () => {
    expect(inputCacheHitRate(day('claude', { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 50_000 }))).toBeCloseTo(0.8)
  })
  it('distinguishes no input, zero hits and entirely cached input', () => {
    expect(inputCacheHitRate(day('claude'))).toBeNull()
    expect(inputCacheHitRate(day('codex', { outputTokens: 900 }))).toBeNull()
    expect(inputCacheHitRate(day('claude', { inputTokens: 100 }))).toBe(0)
    expect(inputCacheHitRate(day('codex', { cacheWriteTokens: 100 }))).toBe(0)
    expect(inputCacheHitRate(day('codex', { cacheReadTokens: 800 }))).toBe(1)
  })
  it('tracks exactly the existing log readers', () => {
    expect(TOKEN_LOG_READERS.map((reader) => reader.provider).sort()).toEqual(['claude', 'codex'])
    expect(isInputCacheTracked('claude')).toBe(true)
    expect(isInputCacheTracked('codex')).toBe(true)
    for (const engine of ['opencode', 'gemini', '*', '']) expect(isInputCacheTracked(engine)).toBe(false)
  })
  it('weights engines and days by their input rather than averaging percentages', () => {
    const rows = engineRows([day('claude', { inputTokens: 90, cacheReadTokens: 10 }), day('codex', { cacheReadTokens: 900 })], range)
    expect(combinedCacheHitRate(rows)).toBeCloseTo(0.91)
  })
  it('excludes unsupported and device rows, even with nonzero token fields', () => {
    expect(combinedCacheHitRate([
      day('claude', { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }),
      day('opencode', { inputTokens: 90_000 }), day('*', { cacheReadTokens: 90_000 }),
    ])).toBeCloseTo(0.8)
    expect(combinedCacheHitRate([])).toBeNull()
    expect(combinedCacheHitRate([day('opencode', { cacheReadTokens: 400 })])).toBeNull()
  })
  it('preserves date-filtered buckets through the existing engine aggregation', () => {
    const rows = engineRows([
      day('claude', { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 }),
      day('claude', { day: range.to, inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 }),
      day('codex', { day: '2026-10-31', inputTokens: 100_000 }), day('*', { cacheReadTokens: 100_000 }),
    ], range)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 100 })
    expect(inputCacheHitRate(rows[0])).toBeCloseTo(800 / 1100)
  })
})

describe('daily cache trend', () => {
  it('merges same-day device rows before dividing and preserves missing dates as null', () => {
    const series = cacheHitSeries([
      day('claude', { inputTokens: 90, cacheReadTokens: 10 }),
      day('claude', { cacheReadTokens: 900 }),
      day('codex', { inputTokens: 100, day: range.to }),
      day('codex', { outputTokens: 500, day: '2026-11-02' }),
      day('opencode', { cacheReadTokens: 9000 }), day('*', { cacheReadTokens: 9000 }),
      day('claude', { inputTokens: 10_000, day: '2026-10-31' }),
    ], range)
    expect(series.domain).toEqual(['claude', 'codex'])
    expect(series.points).toEqual([
      { time: range.from, engine: 'claude', value: 91 }, { time: range.from, engine: 'codex', value: null },
      { time: '2026-11-02', engine: 'claude', value: null }, { time: '2026-11-02', engine: 'codex', value: null },
      { time: range.to, engine: 'claude', value: null }, { time: range.to, engine: 'codex', value: 0 },
    ])
    expect(series.average).toBeCloseTo(910 / 1100)
  })
  it('keeps real zero hits chartable and no tracked input unavailable', () => {
    expect(cacheHitSeries([day('claude', { inputTokens: 10 })], range).average).toBe(0)
    expect(cacheHitSeries([day('claude', { outputTokens: 10 })], range).average).toBeNull()
    expect(cacheHitSeries([day('opencode', { inputTokens: 10 })], range)).toEqual({ points: [], domain: [], average: null })
  })
  it('keeps every day in the year preset instead of averaging into weekly buckets', () => {
    const year = { from: '2025-11-19', to: '2026-11-18', days: 365 }
    const series = cacheHitSeries([day('claude', { day: year.to, cacheReadTokens: 100 })], year)
    expect(series.points).toHaveLength(365)
    expect(series.points[0]).toEqual({ time: year.from, engine: 'claude', value: null })
    expect(series.points.at(-1)).toEqual({ time: year.to, engine: 'claude', value: 100 })
  })
})
