// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { CacheHitChart } from '../../../../apps/desktop/src/components/usage/UsageCharts'
import { cachePercent } from '../../../../apps/desktop/src/components/usage/format'
import type { CacheHitPoint } from '../../../../apps/desktop/src/lib/usage/cacheHitRate'

const chart = vi.hoisted(() => ({ spec: null as unknown }))
vi.mock('../../../../apps/desktop/node_modules/@visactor/react-vchart', () => ({
  VChart: (props: { spec: unknown }) => { chart.spec = props.spec; return null },
}))
type Spec = {
  type: string; stack: boolean; invalidType: string;
  data: { values: CacheHitPoint[] }[];
  axes: { min?: number; max?: number; label: { formatMethod: (value: number | string) => string } }[];
  tooltip: {
    mark: { content: { value: (point: CacheHitPoint) => string }[] };
    dimension: { updateContent: (items: { datum?: CacheHitPoint }[]) => { key: string; value: string }[] };
  };
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('cache hit chart', () => {
  it('uses an unstacked percent axis and gaps, with a shared daily tooltip including missing engines', async () => {
    const points: CacheHitPoint[] = [
      { time: '2026-11-12', engine: 'claude', value: 81 },
      { time: '2026-11-12', engine: 'codex', value: 64 },
      { time: '2026-11-13', engine: 'claude', value: 0 },
      { time: '2026-11-13', engine: 'codex', value: null },
    ]
    await harness.render(createElement(CacheHitChart, { series: { points, domain: ['claude', 'codex'], average: 0.74 } }))
    const spec = chart.spec as Spec
    expect(spec).toMatchObject({ type: 'line', stack: false, invalidType: 'break' })
    expect(spec.axes[0]).toMatchObject({ min: 0, max: 100 })
    expect(spec.axes[0].label.formatMethod(100)).toBe('100%')
    expect(spec.data[0].values.map(point => point.value)).toEqual([81, 64, 0, null])
    const tooltip = spec.tooltip.dimension.updateContent
    expect(tooltip([{ datum: spec.data[0].values[0] }])).toMatchObject([{ key: 'Claude Code', value: '81%' }, { key: 'Codex', value: '64%' }])
    expect(tooltip([{ datum: spec.data[0].values[2] }])).toMatchObject([{ key: 'Claude Code', value: '0%' }, { key: 'Codex', value: '—' }])
    expect(tooltip([{}])).toEqual([])
    expect(spec.tooltip.mark.content[0].value(spec.data[0].values[3])).toBe('—')
  })
  it('does not round small positive shares to a measured zero', () => {
    expect(cachePercent(null)).toBe('—')
    expect(cachePercent(0)).toBe('0%')
    expect(cachePercent(0.005)).toBe('0.5%')
    expect(cachePercent(0.00001)).toBe('<0.1%')
    expect(cachePercent(1)).toBe('100%')
  })
})
