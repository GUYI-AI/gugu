import type { UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { addDays, type DayRange } from './derive'

export type InputTokenBuckets = Pick<UsageDay, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>

/** Only these existing local log readers report disjoint cache/input buckets. */
export function isInputCacheTracked(engine: string): boolean {
  return engine === 'claude' || engine === 'codex'
}

/** Output tokens never belong in the denominator. No input is not a measured zero. */
export function inputCacheHitRate(tokens: InputTokenBuckets): number | null {
  const input = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  return input > 0 ? tokens.cacheReadTokens / input : null
}

export function combinedCacheHitRate(rows: readonly (InputTokenBuckets & { engine: string })[]): number | null {
  const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const row of rows) {
    if (!isInputCacheTracked(row.engine)) continue
    tokens.inputTokens += row.inputTokens
    tokens.cacheReadTokens += row.cacheReadTokens
    tokens.cacheWriteTokens += row.cacheWriteTokens
  }
  return inputCacheHitRate(tokens)
}

export type CacheHitPoint = { time: string; engine: string; value: number | null }
export type CacheHitSeries = { points: CacheHitPoint[]; domain: string[]; average: number | null }

/** Daily points, even for the year preset. Missing input stays null to break the line. */
export function cacheHitSeries(days: readonly UsageDay[], range: DayRange): CacheHitSeries {
  const byDay = new Map<string, Map<string, InputTokenBuckets>>()
  const engines = new Set<string>()
  const included: UsageDay[] = []
  for (const row of days) {
    if (!isInputCacheTracked(row.engine) || row.day < range.from || row.day > range.to) continue
    included.push(row)
    engines.add(row.engine)
    const day = byDay.get(row.day) ?? new Map<string, InputTokenBuckets>()
    const tokens = day.get(row.engine) ?? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    tokens.inputTokens += row.inputTokens
    tokens.cacheReadTokens += row.cacheReadTokens
    tokens.cacheWriteTokens += row.cacheWriteTokens
    day.set(row.engine, tokens)
    byDay.set(row.day, day)
  }
  const domain = [...engines].sort()
  const points: CacheHitPoint[] = []
  for (let time = range.from; time <= range.to; time = addDays(time, 1)) {
    for (const engine of domain) {
      const tokens = byDay.get(time)?.get(engine)
      const rate = tokens ? inputCacheHitRate(tokens) : null
      points.push({ time, engine, value: rate === null ? null : rate * 100 })
    }
  }
  return { points, domain, average: combinedCacheHitRate(included) }
}
