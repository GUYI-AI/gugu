import { describe, expect, it } from 'vitest';
import type { SessionHistoryDirectoryRow } from '@shared/core/session-history/session-history';
import { buildSections, mergeSorted, type HistoryEntry, type SectionKeyed, type SectionRef } from './history-sections';

// A directory page row as the main process gives it: `key` is its section (`project:<chat>` or a directory).
const dir = (key: string, updatedAt: number, projectName: string | null = null): SessionHistoryDirectoryRow => ({
  key, directory: key, projectName, sessionCount: 1, countsBySource: {} as never, countsByStatus: {} as never,
  providers: [], updatedAt, lastPromptAt: null, addedAt: null, sessions: [],
}) as unknown as SessionHistoryDirectoryRow;
const offline = (title: string, project: string, updatedAt: number): HistoryEntry => ({
  key: title, title, updatedAt, lastPromptAt: null, addedAt: null, machine: 'wen', offline: true, opens: false,
  directory: `/${project}`, gugu: { projectId: project, sessionId: title, runtime: 'acp' },
}) as unknown as HistoryEntry;
// Offline rows: local project `<name>` on wen belongs to account project `project:<name>` named `<name>`.
const keyOfEntry = (entry: HistoryEntry): SectionKeyed =>
  ({ key: `project:${entry.gugu!.projectId}`, directory: `project:${entry.gugu!.projectId}`, projectName: entry.gugu!.projectId });
// The renderer only maps a section key to a section; it never looks inside the sessions.
const sectionOf = (machine: string, keyed: SectionKeyed): SectionRef => keyed.key.startsWith('project:')
  ? { key: keyed.key, label: keyed.projectName ?? '', path: null, machine: null }
  : { key: `dir:${machine}:${keyed.directory ?? ''}`, label: keyed.directory ?? '', path: keyed.directory, machine };

describe('history sections across machines', () => {
  // The main process orders its page by project name under the title sort; offline rows are ordered by the same
  // shared comparator on their section, so the lists merge without the renderer re-sorting the online page.
  it('orders sections by project name under the title sort, merging online and offline by the same comparator', () => {
    const sections = buildSections({
      sort: 'title',
      pages: [{ machine: 'gpu', rows: [dir('project:alpha', 2, 'alpha'), dir('project:zulu', 1, 'zulu')] }],
      offline: [offline('a task title', 'mid', 3), offline('zz last title', 'alpha', 4)],
      keyOfEntry,
      sectionOf,
    });
    expect(sections.map((section) => section.key)).toEqual(['project:alpha', 'project:mid', 'project:zulu']);
    expect(sections.find((section) => section.key === 'project:alpha')!.offline.map((row) => row.title)).toEqual(['zz last title']);
  });

  it('keeps time order across machines when sorting by update time', () => {
    const sections = buildSections({
      sort: 'updated',
      pages: [{ machine: 'gpu', rows: [dir('project:alpha', 5, 'alpha'), dir('project:zulu', 1, 'zulu')] }],
      offline: [offline('t', 'mid', 3)],
      keyOfEntry,
      sectionOf,
    });
    expect(sections.map((section) => section.key)).toEqual(['project:alpha', 'project:mid', 'project:zulu']);
  });

  // One account project = one section, whatever machine and directory its tasks are on; a directory key stays per machine.
  it('merges the same project key from several machines into one section; directory keys stay per machine', () => {
    const sections = buildSections({
      sort: 'updated',
      pages: [
        { machine: 'gpu', rows: [dir('project:paper', 4, 'Paper'), dir('/srv/loose', 1)] },
        { machine: 'mac', rows: [dir('project:paper', 3, 'Paper'), dir('/srv/loose', 2)] },
      ],
      offline: [offline('t', 'paper', 5)],
      keyOfEntry,
      sectionOf,
    });
    expect(sections.map((section) => [section.key, section.label, section.machine])).toEqual([
      ['project:paper', 'paper', null],
      ['dir:mac:/srv/loose', '/srv/loose', 'mac'],
      ['dir:gpu:/srv/loose', '/srv/loose', 'gpu'],
    ]);
    expect(sections[0]!.members).toEqual([{ machine: 'gpu', directory: 'project:paper' }, { machine: 'mac', directory: 'project:paper' }]);
    expect(sections[0]!.offlineMachines).toEqual(['wen']);
    expect(sections[0]!.onlineCount).toBe(2);
  });

  it('merges already sorted lists into one sorted list', () => {
    expect(mergeSorted([[1, 4, 9], [2, 3], [10]], (a, b) => a - b)).toEqual([1, 2, 3, 4, 9, 10]);
  });
});
