import { expect, it } from 'vitest'
import { compareServerVersions } from '@gugu/core/cloud/serverVersionSelection'
import { localDay, parseDay, addDays, busiestDay } from '../../../../apps/desktop/src/lib/usage/derive'
import { creditChartScale } from '../../../../apps/desktop/src/lib/usage/creditChartScale'
import type { UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { creditDecimal } from '@gugu/core/billing/creditAmount'

it('ignores SemVer build metadata when comparing versions', () => {expect(compareServerVersions('1.2.3+build.5','1.2.3')).toBe(0);expect(compareServerVersions('1.2.3-beta.2+build.9','1.2.3-beta.2')).toBe(0)})
