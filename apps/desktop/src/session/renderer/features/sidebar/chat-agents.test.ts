import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import {
  CHAT_AGENT_REST_LIMIT,
  CHAT_AGENT_RUNNING_LIMIT,
  chatAgentCounts,
  chatAgentNeedsYou,
  chatAgentPill,
  chatAgentSection,
  chatAgentsMatch,
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
  section.map(({ group, rows }) => [group, rows.map((row) => row.sessionId)]);
const disclosure = { expanded: new Set<string>(), showAllRunning: false, showAllRest: false };

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
    expect(collapsed[0].rows[0]).toMatchObject({
      hasChildren: true,
      needsAttention: true,
      summary: { total: 2, active: [{ count: 1 }] },
    });
    const open = chatAgentSection(agents, { ...disclosure, expanded: new Set(['parent', 'fork']) });
    expect(open[0].rows.map(({ sessionId, depth, parentProjectId }) => [sessionId, depth, parentProjectId])).toEqual([
      ['parent', 0, undefined],
      ['fork', 1, 'p-other'],
      ['grandchild', 2, 'p-elsewhere'],
    ]);
  });

  it('a fork whose parent is not in this chat stands as a root of its own', () => {
    const section = chatAgentSection([entry('fork', { parentSessionId: 'parent-elsewhere' })], disclosure);
    expect(rowIds(section)).toEqual([[null, ['fork']]]);
  });

  it('needs you is always shown in full; running shows 5 then folds, the rest shows 3 then folds', () => {
    const blocked = Array.from({ length: 7 }, (_, index) => entry(`blocked-${index}`, { presentation: waiting, time: 100 - index }));
    const busy = Array.from({ length: CHAT_AGENT_RUNNING_LIMIT + 2 }, (_, index) => entry(`busy-${index}`, { presentation: running, time: 100 - index }));
    const quiet = Array.from({ length: CHAT_AGENT_REST_LIMIT + 12 }, (_, index) => entry(`quiet-${index}`, { time: 100 - index }));
    const agents = [...quiet, ...busy, ...blocked];
    const folded = chatAgentSection(agents, disclosure);
    expect(rowIds(folded)).toEqual([
      ['needs-you', ids(blocked)],
      ['working', ids(busy.slice(0, CHAT_AGENT_RUNNING_LIMIT))],
      [null, ids(quiet.slice(0, CHAT_AGENT_REST_LIMIT))],
    ]);
    expect(folded.map(({ overflow, total }) => [overflow, total])).toEqual([[0, 7], [2, 7], [12, 15]]);

    // 「还有 2 个在运行」opened: running shows all; its row stays (it now reads Collapse). The rest is untouched.
    const running5 = chatAgentSection(agents, { ...disclosure, showAllRunning: true });
    expect(running5[1]).toMatchObject({ overflow: 2 });
    expect(running5[1].rows).toHaveLength(busy.length);
    expect(running5[2].rows).toHaveLength(CHAT_AGENT_REST_LIMIT);
    const rest = chatAgentSection(agents, { ...disclosure, showAllRest: true });
    expect(rest[2].rows).toHaveLength(quiet.length);
    expect(rest[1].rows).toHaveLength(CHAT_AGENT_RUNNING_LIMIT);
  });

  it('a folded family keeps its forks with it: the cap counts families, not rows', () => {
    const agents = [
      ...Array.from({ length: CHAT_AGENT_REST_LIMIT }, (_, index) => entry(`quiet-${index}`, { time: 50 - index })),
      entry('parent', { time: 100 }),
      entry('fork', { parentSessionId: 'parent' }),
    ];
    const section = chatAgentSection(agents, { ...disclosure, expanded: new Set(['parent']) });
    expect(rowIds(section)).toEqual([[null, ['parent', 'fork', 'quiet-0', 'quiet-1']]]);
    expect(section[0].overflow).toBe(1);
  });

  it('while filtering nothing folds: every family whose own or a fork’s name matches is listed', () => {
    const agents = [
      ...Array.from({ length: CHAT_AGENT_REST_LIMIT + 3 }, (_, index) => entry(`price-${index}`, { title: `Pricing ${index}`, time: 50 - index })),
      entry('other', { title: 'Weekly report' }),
      entry('parent', { title: 'Landing page', presentation: running }),
      entry('fork', { parentSessionId: 'parent', title: 'pricing table' }),
    ];
    const section = chatAgentSection(agents, { ...disclosure, query: 'PRICING' });
    expect(rowIds(section)).toEqual([
      ['working', ['parent']],
      [null, ids(agents.slice(0, CHAT_AGENT_REST_LIMIT + 3))],
    ]);
    expect(section.every(({ overflow }) => overflow === 0)).toBe(true);
    expect(chatAgentsMatch(agents, 'pricing')).toBe(true);
    expect(chatAgentsMatch(agents, 'nothing like it')).toBe(false);
  });

  it('a collapsed section counts what needs you there (waiting, or failed and unseen) on reachable hosts', () => {
    const failed = presentAgentStatus({ reading: { status: 'error', detail: null }, unseen: true });
    expect(chatAgentNeedsYou([
      entry('waiting', { presentation: waiting }),
      entry('failed-unseen', { presentation: failed, unseen: true }),
      entry('offline', { presentation: waiting, hostOnline: false }),
      entry('busy', { presentation: running }),
    ])).toBe(2);
  });

  it('no agents: no groups', () => {
    expect(chatAgentSection([], disclosure)).toEqual([]);
  });
});
