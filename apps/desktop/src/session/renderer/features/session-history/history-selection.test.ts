import { describe, expect, it } from 'vitest';
import {
  BULK_ACTIONS,
  EMPTY_SELECTION,
  addRows,
  archiveScopeOf,
  bulkModeOf,
  countSelection,
  cutoffClock,
  keepOnly,
  removeRows,
  sectionCheck,
  selectableEntry,
  selectedInSection,
  selectionLabel,
  targetsOf,
  timeCutoff,
  toSelected,
  toggleRow,
  type BulkStatus,
  type SelectedSession,
} from './history-selection';
import type { HistoryEntry } from './history-sections';

function row(key: string, status: BulkStatus = 'archived', sectionKey = 'project:gugu'): SelectedSession {
  return { key, machine: 'local', status, sectionKey, title: key, projectId: 'p', sessionId: key, updatedAt: 0 };
}

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    key: 'k',
    machine: 'local',
    status: 'archived',
    title: 't',
    updatedAt: 1,
    offline: false,
    gugu: { projectId: 'p', sessionId: 's' },
    ...overrides,
  } as HistoryEntry;
}

describe('which rows can be ticked', () => {
  it('only gugu rows that are active or archived, on a machine that answers', () => {
    expect(selectableEntry(entry({}))).toBe(true);
    expect(selectableEntry(entry({ status: 'active' }))).toBe(true);
    expect(selectableEntry(entry({ status: 'not-imported', gugu: undefined }))).toBe(false);
    expect(selectableEntry(entry({ offline: true }))).toBe(false);
    expect(toSelected(entry({ offline: true }), 's')).toBeNull();
    expect(toSelected(entry({ key: 'a' }), 'project:x')).toMatchObject({ key: 'a', sectionKey: 'project:x', projectId: 'p', sessionId: 's' });
  });
});

describe('selection scope', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'].map((key) => row(key));

  it('a plain click toggles one row and makes it the anchor', () => {
    const one = toggleRow(EMPTY_SELECTION, visible[1], visible, false);
    expect([...one.rows.keys()]).toEqual(['b']);
    expect(one.anchor).toBe('b');
    expect(toggleRow(one, visible[1], visible, false).rows.size).toBe(0);
  });

  it('shift extends from the anchor to the clicked row, in either direction', () => {
    const anchored = toggleRow(EMPTY_SELECTION, visible[3], visible, false);
    const range = toggleRow(anchored, visible[1], visible, true);
    expect([...range.rows.keys()].sort()).toEqual(['b', 'c', 'd']);
    expect(range.anchor).toBe('d');
  });

  it('shift from an unticked anchor clears the range instead', () => {
    let selection = addRows(EMPTY_SELECTION, visible);
    selection = toggleRow(selection, visible[0], visible, false); // a off, anchor a
    selection = toggleRow(selection, visible[2], visible, true);
    expect([...selection.rows.keys()].sort()).toEqual(['d', 'e']);
  });

  it('shift without a visible anchor is a plain toggle', () => {
    const selection = toggleRow({ ...EMPTY_SELECTION, anchor: 'gone' }, visible[2], visible, true);
    expect([...selection.rows.keys()]).toEqual(['c']);
  });

  it('“select all matching” marks the selection as across; touching any row drops it', () => {
    const all = addRows(EMPTY_SELECTION, visible, true);
    expect(all.across).toBe(true);
    expect(toggleRow(all, visible[0], visible, false).across).toBe(false);
    expect(removeRows(all, ['a']).across).toBe(false);
  });

  it('removing the anchor row forgets the anchor', () => {
    const selection = toggleRow(EMPTY_SELECTION, visible[0], visible, false);
    expect(removeRows(selection, ['a']).anchor).toBeNull();
  });

  it('counts per section feed the section checkbox: off / mixed / on', () => {
    const selection = addRows(EMPTY_SELECTION, [row('a'), row('b'), row('x', 'archived', 'project:other')]);
    expect(selectedInSection(selection, 'project:gugu')).toBe(2);
    expect(sectionCheck(0, 5)).toBe('off');
    expect(sectionCheck(2, 5)).toBe('mixed');
    expect(sectionCheck(5, 5)).toBe('on');
  });
});

describe('which actions the bottom bar offers', () => {
  it('active only → archive; archived only → restore and delete', () => {
    expect(bulkModeOf(countSelection(addRows(EMPTY_SELECTION, [row('a', 'active')])))).toEqual({
      kind: 'single',
      status: 'active',
      actions: ['archive'],
    });
    expect(bulkModeOf(countSelection(addRows(EMPTY_SELECTION, [row('a')])))).toEqual({
      kind: 'single',
      status: 'archived',
      actions: ['restore', 'delete'],
    });
  });

  it('mixed → no action at all, only the counts for the two narrowing buttons', () => {
    const mixed = addRows(EMPTY_SELECTION, [row('a', 'active'), row('b'), row('c')]);
    expect(bulkModeOf(countSelection(mixed))).toEqual({ kind: 'mixed', active: 1, archived: 2 });
    expect([...keepOnly(mixed, 'archived').rows.keys()]).toEqual(['b', 'c']);
    expect([...keepOnly(mixed, 'active').rows.keys()]).toEqual(['a']);
  });

  it('no action exists on both sides (move-to-project is not offered yet)', () => {
    const both = BULK_ACTIONS.active.filter((action) => BULK_ACTIONS.archived.includes(action));
    expect(both).toEqual([]);
    expect([...BULK_ACTIONS.active, ...BULK_ACTIONS.archived]).not.toContain('move');
  });

  it('targets are re-filtered by status, not trusted from the caller', () => {
    const mixed = addRows(EMPTY_SELECTION, [row('a', 'active'), row('b')]);
    expect(targetsOf(mixed, 'delete').map((r) => r.key)).toEqual(['b']);
    expect(targetsOf(mixed, 'archive').map((r) => r.key)).toEqual(['a']);
  });

  it('the “select all N matching” link shows until everything is selected', () => {
    const two = addRows(EMPTY_SELECTION, [row('a'), row('b')]);
    expect(selectionLabel(two, 5)).toEqual({ count: 2, allSelected: false, acrossLabel: false, offerAll: 5 });
    expect(selectionLabel(two, null).offerAll).toBeNull();
    expect(selectionLabel(addRows(two, [], true), 2)).toEqual({ count: 2, allSelected: true, acrossLabel: true, offerAll: null });
  });
});

describe('archive dialog scope', () => {
  const sectionActive = (key: string) => (key === 'project:gugu' ? 3 : 10);
  const sectionLabel = (key: string) => (key === 'project:gugu' ? 'gugu' : key);

  it('one row, a whole section (with or without time), across a time filter, or just a count', () => {
    const args = { sectionActive, sectionLabel, timeLabel: null, across: false };
    expect(archiveScopeOf({ ...args, rows: [row('a', 'active')] })).toEqual({ kind: 'one' });
    const whole = ['a', 'b', 'c'].map((key) => row(key, 'active'));
    expect(archiveScopeOf({ ...args, rows: whole })).toEqual({ kind: 'section', section: 'gugu', time: null, count: 3 });
    expect(archiveScopeOf({ ...args, rows: whole, timeLabel: '一个月前' })).toEqual({
      kind: 'section',
      section: 'gugu',
      time: '一个月前',
      count: 3,
    });
    const spread = [row('a', 'active'), row('x', 'active', 'project:other')];
    expect(archiveScopeOf({ ...args, rows: spread, timeLabel: '一周前', across: true })).toEqual({ kind: 'time', time: '一周前', count: 2 });
    expect(archiveScopeOf({ ...args, rows: spread })).toEqual({ kind: 'count', count: 2 });
  });
});

describe('time filter', () => {
  const now = new Date(2026, 10, 27, 15, 30, 45).getTime();
  const day = 24 * 60 * 60 * 1000;

  it('presets count back from now; a custom date is that day’s local midnight', () => {
    expect(timeCutoff({ kind: 'any' }, now)).toBeUndefined();
    expect(timeCutoff({ kind: 'days', days: 7 }, now)).toBe(now - 7 * day);
    expect(timeCutoff({ kind: 'days', days: 90 }, now)).toBe(now - 90 * day);
    expect(timeCutoff({ kind: 'date', date: '2026-11-01' }, now)).toBe(new Date(2026, 10, 1).getTime());
    expect(timeCutoff({ kind: 'date', date: 'nope' }, now)).toBeUndefined();
  });

  it('the clock is rounded to the minute so the same filter is the same request', () => {
    expect(cutoffClock(now)).toBe(new Date(2026, 10, 27, 15, 30).getTime());
    expect(cutoffClock(now + 10_000)).toBe(cutoffClock(now));
  });
});
