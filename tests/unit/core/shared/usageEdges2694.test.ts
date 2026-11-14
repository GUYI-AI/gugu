import { expect, it } from 'vitest'
import { compareServerVersions } from '@gugu/core/cloud/serverVersionSelection'
import { localDay, parseDay, addDays, busiestDay } from '../../../../apps/desktop/src/lib/usage/derive'
import { creditChartScale } from '../../../../apps/desktop/src/lib/usage/creditChartScale'
import type { UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { creditDecimal } from '@gugu/core/billing/creditAmount'

it('ignores SemVer build metadata when comparing versions', () => {expect(compareServerVersions('1.2.3+build.5','1.2.3')).toBe(0);expect(compareServerVersions('1.2.3-beta.2+build.9','1.2.3-beta.2')).toBe(0)})

it('orders textual prerelease identifiers lexically', () => {expect(compareServerVersions('1.0.0-beta.1','1.0.0-alpha.1')).toBeGreaterThan(0);expect(compareServerVersions('1.0.0-beta.1','1.0.0-rc.1')).toBeLessThan(0)})


it('orders numeric prerelease identifiers before textual identifiers', () => {expect(compareServerVersions('1.0.0-2','1.0.0-1alpha')).toBeLessThan(0);expect(compareServerVersions('1.0.0-1alpha','1.0.0-2')).toBeGreaterThan(0)})

it('orders longer matching prereleases after their prefix', () => {expect(compareServerVersions('1.0.0-beta.0','1.0.0-beta')).toBeGreaterThan(0);expect(compareServerVersions('1.0.0-beta','1.0.0-beta.0')).toBeLessThan(0)})

it('preserves four-digit early years in usage dates', () => {const date=new Date(0);date.setFullYear(42,0,2);expect(localDay(date)).toBe('0042-01-02');expect(parseDay('0042-01-02').getFullYear()).toBe(42);expect(addDays('0042-01-02',1)).toBe('0042-01-03')})

it('keeps busiest day ties independent of incoming row order', () => {const rows=[{day:'2026-11-13',engine:'x',sessions:2},{day:'2026-11-14',engine:'x',sessions:2}] as UsageDay[];const range={from:'2026-11-13',to:'2026-11-14'};expect(busiestDay(rows,range)).toEqual(busiestDay([...rows].reverse(),range))})

it('retains negative signs below one chart storage unit', () => {const scale=creditChartScale([creditDecimal('1')]);expect(scale.formatCoordinate(-1e-12,String)).toMatch(/^-/);expect(scale.formatCoordinate(0,String)).toBe('0')})
