import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { IDLE_VISIBLE_CAP } from '../sessions/session-tree';
import {
  chatAgentCounts,
  chatAgentPill,
  chatAgentSection,
  myAgentsInChat,
  type ChatAgentEntry,
} from './chat-agents';

const running = presentAgentStatus({ reading: { status: 'working', detail: null } });
const parked = presentAgentStatus({ reading: { status: 'working', detail: 'parked' } });
const waiting = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });
const idle = presentAgentStatus({ reading: { status: 'idle', detail: null } });

const entry = (id: string, fields: Partial<ChatAgentEntry> = {}): ChatAgentEntry => ({
  id,
  projectId: 'p-other',
  isPinned: false,
  time: 0,
  presentation: idle,
  ...fields,
});
const ids = (entries: readonly { id: string }[]) => entries.map((e) => e.id);
const rowIds = (section: ReturnType<typeof chatAgentSection>) =>
  section.groups.map(({ group, rows }) => [group, rows.map((row) => row.sessionId)]);
const disclosure = { expanded: new Set<string>(), idleExpanded: false };

describe('my agents in a chat', () => {
  const mine = [
    entry('in-group', { agentUserId: 'agent-a' }),
    entry('elsewhere', { agentUserId: 'agent-b' }),
    entry('no-identity'),
    entry('project-session', { projectId: 'p-shop', agentUserId: 'agent-c' }),
    entry('project-folder-on-other-machine', { projectId: 'p-shop-remote' }),
  ];

  it('in a group: only my sessions whose agent is a member of the group', () => {
    expect(ids(myAgentsInChat(mine, { kind: 'group', memberUserIds: ['agent-a', 'human-1', 'someone-elses-agent'] }))).toEqual(['in-group']);
  });

  it('a session without a gugu identity is in no group', () => {
    expect(myAgentsInChat(mine, { kind: 'group', memberUserIds: [] })).toEqual([]);
  });

  it("in a project: the project's sessions on every machine, plus my agents among the project group's members", () => {
    expect(ids(myAgentsInChat(mine, {
      kind: 'project',
      projectIds: ['p-shop', 'p-shop-remote'],
      memberUserIds: ['agent-a'],
    }))).toEqual(['in-group', 'project-session', 'project-folder-on-other-machine']);
  });

  it('other people’s agents never appear: membership only filters my own sessions', () => {
    expect(myAgentsInChat([], { kind: 'group', memberUserIds: ['someone-elses-agent'] })).toEqual([]);
  });
});

describe('counts on the section header and the project row', () => {
  it('total is every agent; running is foreground work only (parked / scheduled is not running)', () => {
    const agents = [
      entry('a', { presentation: running }),
      entry('b', { presentation: running }),
      entry('c', { presentation: parked }),
      entry('d', { presentation: waiting }),
      entry('e', { presentation: null }),
    ];
    expect(chatAgentCounts(agents)).toEqual({ total: 5, running: 2 });
    expect(chatAgentPill(agents)).toMatchObject({ total: 5, active: [{ count: 2, presentation: { tone: 'running' } }] });
  });

  it('nothing running: the pill shows the total alone', () => {
    expect(chatAgentCounts([entry('a')])).toEqual({ total: 1, running: 0 });
    expect(chatAgentPill([entry('a')]).active).toEqual([]);
  });
});

describe('the agents section', () => {
  it('groups by the root’s status: needs you, then running, then the rest (unlabelled)', () => {
    const section = chatAgentSection([
      entry('quiet', { time: 3 }),
      entry('busy', { presentation: running, time: 1 }),
      entry('blocked', { presentation: waiting, time: 2 }),
      entry('background', { presentation: parked, time: 4 }),
    ], disclosure);
    expect(rowIds(section)).toEqual([
      ['needs-you', ['blocked']],
      ['working', ['background', 'busy']],
      [null, ['quiet']],
    ]);
  });

  it('pinned first within its group, then newest first', () => {
    const section = chatAgentSection([
      entry('old-pinned', { presentation: running, time: 1, isPinned: true }),
      entry('new', { presentation: running, time: 9 }),
      entry('mid', { presentation: running, time: 5 }),
      entry('idle-pinned', { time: 0, isPinned: true }),
      entry('idle-new', { time: 8 }),
    ], disclosure);
    expect(rowIds(section)).toEqual([
      ['working', ['old-pinned', 'new', 'mid']],
      [null, ['idle-pinned', 'idle-new']],
    ]);
  });

  it('forks hang under their parent, listed only while the parent is expanded, with the branch pill', () => {
    const agents = [
      entry('parent', { presentation: running, time: 2 }),
      entry('fork', { parentSessionId: 'parent', presentation: running, projectId: 'p-elsewhere' }),
      entry('grandchild', { parentSessionId: 'fork', presentation: waiting }),
    ];
    const collapsed = chatAgentSection(agents, disclosure);
    expect(rowIds(collapsed)).toEqual([['working', ['parent']]]);
    expect(collapsed.groups[0].rows[0]).toMatchObject({
      hasChildren: true,
      needsAttention: true,
      summary: { total: 2, active: [{ count: 1 }] },
    });
    const open = chatAgentSection(agents, { expanded: new Set(['parent', 'fork']), idleExpanded: false });
    expect(open.groups[0].rows.map(({ sessionId, depth, parentProjectId }) => [sessionId, depth, parentProjectId])).toEqual([
      ['parent', 0, undefined],
      ['fork', 1, 'p-other'],
      ['grandchild', 2, 'p-elsewhere'],
    ]);
  });

  it('a fork whose parent is not in this chat stands as a root of its own', () => {
    const section = chatAgentSection([entry('fork', { parentSessionId: 'parent-elsewhere' })], disclosure);
    expect(rowIds(section)).toEqual([[null, ['fork']]]);
  });

  it('idle families beyond the cap fold behind Show more; needs-you and running never fold', () => {
    const quiet = Array.from({ length: IDLE_VISIBLE_CAP + 2 }, (_, index) => entry(`quiet-${index}`, { time: 100 - index }));
    const agents = [...quiet, entry('busy', { presentation: running }), entry('blocked', { presentation: waiting })];
    const folded = chatAgentSection(agents, disclosure);
    expect(folded.folded).toBe(2);
    expect(rowIds(folded)).toEqual([
      ['needs-you', ['blocked']],
      ['working', ['busy']],
      [null, quiet.slice(0, IDLE_VISIBLE_CAP).map((e) => e.id)],
    ]);
    const shown = chatAgentSection(agents, { expanded: new Set(), idleExpanded: true });
    expect(shown.folded).toBe(2);
    expect(shown.groups.at(-1)?.rows).toHaveLength(IDLE_VISIBLE_CAP + 2);
  });

  it('no agents: no groups', () => {
    expect(chatAgentSection([], disclosure)).toEqual({ groups: [], folded: 0 });
  });
});
