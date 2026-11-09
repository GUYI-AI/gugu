import { describe, expect, it } from 'vitest';
import { fragmentAnchor, projectSourceFragments, sourceWindowSettled } from './source-fragments';
import { unitItemIds, type RenderUnit } from '../core/units';
import { Virtualizer } from '../core/virtualizer';
import type { SourceFragment } from '@gugu/session-core/session-record/contract';

const fragment = (key: string, start: number): SourceFragment => ({ key,
  sourceRange: { start, end: start + 100 }, ownership: 'unresolved', text: `Real text ${key}` });
const canonical = (id: string): RenderUnit => ({ id: `${id}#self`, itemId: id,
  groupId: id, kind: 'message', data: { id, text: 'Canonical text' }, groupRole: 'solo', gapBefore: 8 });
const source = [fragment('a', 100), fragment('b', 200), fragment('c', 300)];
const initial = () => projectSourceFragments([], { sourceFragments: source }, []);

describe('bounded source row ownership', () => {
  it('replaces the source slot exactly once without changing canonical item identity', () => {
    const before = initial();
    const after = projectSourceFragments([canonical('real')], {
      resolvedFragmentOwners: [{ fragmentKey: 'b', turnId: 'turn', itemId: 'real' }],
      sourceFragments: source,
    }, before);
    expect(after.map(row => row.id)).toEqual(before.map(row => row.id));
    expect(after.filter(row => row.itemId === 'real')).toHaveLength(1);
    expect(after.filter(row => row.kind === 'source-fragment')).toHaveLength(2);
    expect(after[1].data).toEqual(canonical('real').data);
    expect(after[1].itemId).toBe('real');
  });

  it('keeps the reading anchor and offset through ownership replacement and height changes above', () => {
    const before = initial();
    const reading = { itemId: before[1].itemId, offset: 23 };
    const after = projectSourceFragments([canonical('real')], { sourceFragments: source,
      resolvedFragmentOwners: [{ fragmentKey: 'b', turnId: 'turn', itemId: 'real' }],
    }, before);
    const virt = new Virtualizer();
    virt.setCount(after.length, index => [140, 180, 160][index]);
    const index = after.findIndex(row => [...unitItemIds(row)].includes(reading.itemId));
    expect(index).toBe(1);
    const scrollTop = virt.top(index) + reading.offset;
    expect(scrollTop - virt.top(index)).toBe(23);
    expect(after[index].id).toBe(fragmentAnchor('b'));
    expect(after[index].itemId).toBe('real');
  });

  it('deduplicates two fragments resolving to one row while retaining both anchors', () => {
    const after = projectSourceFragments([canonical('real')], { sourceFragments: source.slice(0, 2),
      resolvedFragmentOwners: source.slice(0, 2).map(value => ({ fragmentKey: value.key, turnId: 't', itemId: 'real' })),
    }, initial());
    expect(after).toHaveLength(1);
    expect([...unitItemIds(after[0])]).toEqual(['real', fragmentAnchor('a'), fragmentAnchor('b')]);
  });

  it('does not fabricate a row for a ticket without readable text', () => {
    expect(projectSourceFragments([], { sourceFragments: [{ ...source[0], text: undefined }] }, [])).toEqual([]);
  });

  it('retains both reading aliases after later updates clear resolved source metadata', () => {
    const first = projectSourceFragments([canonical('real')], { sourceFragments: source.slice(0, 2),
      resolvedFragmentOwners: source.slice(0, 2).map(value => ({ fragmentKey: value.key, turnId: 't', itemId: 'real' })),
    }, initial());
    const second = projectSourceFragments([canonical('real')], { sourceFragments: [], resolvedFragmentOwners: [] }, first);
    const third = projectSourceFragments([canonical('real')], {}, second);
    for (const rows of [second, third]) {
      expect(rows).toHaveLength(1);
      expect([...unitItemIds(rows[0])]).toEqual(['real', fragmentAnchor('a'), fragmentAnchor('b')]);
    }
  });
});

describe('settled source window lets appends stay incremental', () => {
  const owner = (fragmentKey: string, itemId: string) => ({ fragmentKey, turnId: 'turn', itemId });
  const window = (owners: ReturnType<typeof owner>[], fragments = source) =>
    ({ sourceLineage: 'lineage', sourceFragments: fragments, resolvedFragmentOwners: owners });
  const all = [owner('a', 'x'), owner('b', 'y'), owner('c', 'z')];
  const present = (ids: string[]) => (itemId: string) => ids.includes(itemId);

  it('is settled without any window, and once every owner is unchanged and on screen', () => {
    expect(sourceWindowSettled(undefined, undefined, present([]))).toBe(true);
    expect(sourceWindowSettled(window(all), window(all), present(['x', 'y', 'z']))).toBe(true);
    expect(sourceWindowSettled(window([], []), window([], []), present([]))).toBe(true);
  });

  it('keeps the full rebuild while a fragment is unresolved or its item has not arrived', () => {
    expect(sourceWindowSettled(window(all.slice(0, 2)), window(all.slice(0, 2)), present(['x', 'y', 'z']))).toBe(false);
    expect(sourceWindowSettled(window(all), window(all), present(['x', 'y']))).toBe(false);
  });

  it('projects once when an owner resolves to an item that is already on screen', () => {
    expect(sourceWindowSettled(window(all), window(all.slice(0, 2)), present(['x', 'y', 'z']))).toBe(false);
  });

  it('rebuilds when the window appears, disappears, changes lineage or its fragment set', () => {
    expect(sourceWindowSettled(window(all), undefined, present(['x', 'y', 'z']))).toBe(false);
    expect(sourceWindowSettled(undefined, window(all), present(['x', 'y', 'z']))).toBe(false);
    expect(sourceWindowSettled(window(all), { ...window(all), sourceLineage: 'other' }, present(['x', 'y', 'z']))).toBe(false);
    expect(sourceWindowSettled(window(all), window(all, source.slice(0, 2)), present(['x', 'y', 'z']))).toBe(false);
  });
});

