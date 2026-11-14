import { expect, it, vi } from 'vitest';
import type { RenderUnit } from './units';
import { collectViewportProtection, sameViewportProtection } from './viewport-protection';

const row = (itemId: string, extra: Partial<RenderUnit> = {}): RenderUnit => ({
  id: itemId, itemId, groupId: itemId, groupRole: 'solo', gapBefore: 0, kind: 'message', data: {}, ...extra,
});

it('protects mounted rows, source aliases and nested leaves without reading unmounted history', () => {
  const at = vi.fn((index: number) => {
    if (index === 4) return row('sticky');
    if (index === 100_000) return row('process', { anchorIds: ['source-fragment'], children: [row('leaf')] });
    throw new Error(`Unrequested history index ${index}`);
  });
  const result = collectViewportProtection([4, 100_000], at, { kind: 'tail' });
  expect(result.itemIds).toEqual(['sticky', 'process', 'source-fragment', 'leaf']);
  expect(at.mock.calls).toEqual([[4], [100_000]]);
});

it('keeps a temporarily unmounted reading anchor and does not expose its mutable state', () => {
  const anchor = { kind: 'anchor', itemId: 'reading', edge: 'top', offset: 24 } as const;
  const result = collectViewportProtection([], () => undefined, anchor);
  expect(result).toEqual({ itemIds: ['reading'], anchor });
  expect(result.anchor).not.toBe(anchor);
});

it('reports an empty mounted range rather than retaining an old visible set', () => {
  const result = collectViewportProtection([], () => undefined, { kind: 'tail' });
  expect(result).toEqual({ itemIds: [], anchor: { kind: 'tail' } });
  expect(sameViewportProtection({ itemIds: ['old'], anchor: { kind: 'tail' } }, result)).toBe(false);
});

it('deduplicates aliases while preserving stable range order', () => {
  const result = collectViewportProtection([0, 1], index => row(index ? 'second' : 'first', { anchorIds: ['first'] }), { kind: 'tail' });
  expect(result.itemIds).toEqual(['first', 'second']);
  expect(sameViewportProtection(undefined, result)).toBe(false);
  expect(sameViewportProtection(result, { ...result, itemIds: [...result.itemIds] })).toBe(true);
});

it('changes protection when the reading edge or offset changes', () => {
  const before = collectViewportProtection([], () => undefined, { kind: 'anchor', itemId: 'reading', edge: 'top', offset: 24 });
  expect(sameViewportProtection(before, { ...before, anchor: { kind: 'anchor', itemId: 'reading', edge: 'bottom', offset: 24 } })).toBe(false);
  expect(sameViewportProtection(before, { ...before, anchor: { kind: 'anchor', itemId: 'reading', edge: 'top', offset: 25 } })).toBe(false);
});
