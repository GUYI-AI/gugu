import { describe, expect, it } from 'vitest';
import { fragmentAnchor, projectSourceFragments } from './source-fragments';
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
  it('keeps opening history before a new live turn when it becomes committed, exactly once', () => {
    const window = { sourceFragments: source, beforeLive: true as const };
    const before = projectSourceFragments([], window, []);
    const after = projectSourceFragments([canonical('new-live')], window, before);
    const next = projectSourceFragments([canonical('new-live')], window, after);
    for (const rows of [after, next]) {
      expect(rows.map(row => row.itemId)).toEqual([...source.map(value => fragmentAnchor(value.key)), 'new-live']);
      expect(rows.filter(row => row.itemId === 'new-live')).toHaveLength(1);
    }
  });

  it('retains resolved history anchors in the prefix while a later live row remains after it', () => {
    const window = { sourceFragments: source.slice(0, 2), beforeLive: true as const,
      resolvedFragmentOwners: source.slice(0, 2).map(value => ({ fragmentKey: value.key, turnId: 't', itemId: 'history' })) };
    const first = projectSourceFragments([canonical('history'), canonical('live')], window, initial());
    const next = projectSourceFragments([canonical('history'), canonical('live')],
      { beforeLive: true, sourceFragments: [], resolvedFragmentOwners: [] }, first);
    for (const rows of [first, next]) {
      expect(rows.map(row => row.itemId)).toEqual(['history', 'live']);
      expect([...unitItemIds(rows[0])]).toEqual(['history', fragmentAnchor('a'), fragmentAnchor('b')]);
    }
  });

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
