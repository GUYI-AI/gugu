import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import {
  CHAT_AGENT_LIMIT,
  agentFamilies,
  chatAgentCounts,
  chatAgentNeedsYou,
  chatAgentSection,
  myAgentsInChat,
  subAgentsOf,
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
const rowIds = (list: ReturnType<typeof chatAgentSection>) => list.rows.map((row) => row.sessionId);
const disclosure = { expanded: new Set<string>(), showAll: false };

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
    expect(chatAgentCounts([entry('a')])).toEqual({ total: 1, running: 0 });
  });
});

describe('the agents section', () => {
  it('one flat list, no group headers: needs you, then running, then the rest', () => {
    const list = chatAgentSection([
      entry('quiet', { time: 3 }),
      entry('busy', { presentation: running, time: 1 }),
      entry('blocked', { presentation: waiting, time: 2 }),
      entry('background', { presentation: parked, time: 4 }),
    ], disclosure);
    expect(rowIds(list)).toEqual(['blocked', 'background', 'busy', 'quiet']);
    expect(list).toMatchObject({ total: 4, overflow: 0 });
  });

  it('pinned first within its tier, then newest first', () => {
    const list = chatAgentSection([
      entry('old-pinned', { presentation: running, time: 1, isPinned: true }),
      entry('new', { presentation: running, time: 9 }),
      entry('mid', { presentation: running, time: 5 }),
      entry('idle-pinned', { time: 0, isPinned: true }),
      entry('idle-new', { time: 8 }),
    ], disclosure);
    expect(rowIds(list)).toEqual(['old-pinned', 'new', 'mid', 'idle-pinned', 'idle-new']);
  });

  it('forks hang under their parent, listed only while the parent is expanded, with the branch pill', () => {
    const agents = [
      entry('parent', { presentation: running, time: 2 }),
      entry('fork', { parentSessionId: 'parent', presentation: running, projectId: 'p-elsewhere' }),
      entry('grandchild', { parentSessionId: 'fork', presentation: waiting }),
    ];
    const collapsed = chatAgentSection(agents, disclosure);
    expect(rowIds(collapsed)).toEqual(['parent']);
    expect(collapsed.rows[0]).toMatchObject({
      hasChildren: true,
      needsAttention: true,
      summary: { total: 2, active: [{ count: 1 }] },
    });
    const open = chatAgentSection(agents, { ...disclosure, expanded: new Set(['parent', 'fork']) });
    expect(open.rows.map(({ sessionId, depth, parentProjectId }) => [sessionId, depth, parentProjectId])).toEqual([
      ['parent', 0, undefined],
      ['fork', 1, 'p-other'],
      ['grandchild', 2, 'p-elsewhere'],
    ]);
  });

  it('a fork whose parent is not in this chat stands as a root of its own', () => {
    expect(rowIds(chatAgentSection([entry('fork', { parentSessionId: 'parent-elsewhere' })], disclosure))).toEqual(['fork']);
  });

  it(`shows ${CHAT_AGENT_LIMIT} families, then one 「Show more」 for whatever is left, running or not; opened, everything`, () => {
    const blocked = Array.from({ length: 3 }, (_, index) => entry(`blocked-${index}`, { presentation: waiting, time: 100 - index }));
    const busy = Array.from({ length: 6 }, (_, index) => entry(`busy-${index}`, { presentation: running, time: 100 - index }));
    const quiet = Array.from({ length: 8 }, (_, index) => entry(`quiet-${index}`, { time: 100 - index }));
    const agents = [...quiet, ...busy, ...blocked];
    const folded = chatAgentSection(agents, disclosure);
    expect(rowIds(folded)).toEqual([...ids(blocked), ...ids(busy), ...ids(quiet.slice(0, CHAT_AGENT_LIMIT - 9))]);
    expect(folded).toMatchObject({ total: 17, overflow: 17 - CHAT_AGENT_LIMIT });

    // Opened: every family; the row stays (it now reads Collapse).
    const opened = chatAgentSection(agents, { ...disclosure, showAll: true });
    expect(rowIds(opened)).toEqual([...ids(blocked), ...ids(busy), ...ids(quiet)]);
    expect(opened.overflow).toBe(17 - CHAT_AGENT_LIMIT);

    // Fewer running: the rest fills the room up to the cap.
    const fewBusy = chatAgentSection([...quiet, ...busy.slice(0, 1)], disclosure);
    expect(rowIds(fewBusy)).toEqual(['busy-0', ...ids(quiet)]);
    expect(fewBusy.overflow).toBe(0);
  });

  it('needs you never folds away, even past the cap: then nothing else is shown until opened', () => {
    const blocked = Array.from({ length: CHAT_AGENT_LIMIT + 2 }, (_, index) => entry(`blocked-${index}`, { presentation: waiting, time: 100 - index }));
    const list = chatAgentSection([entry('busy', { presentation: running }), ...blocked, entry('quiet')], disclosure);
    expect(rowIds(list)).toEqual(ids(blocked));
    expect(list.overflow).toBe(2);
  });

  it('a folded family keeps its forks with it: the cap counts families, not rows', () => {
    const agents = [
      ...Array.from({ length: CHAT_AGENT_LIMIT }, (_, index) => entry(`quiet-${index}`, { time: 50 - index })),
      entry('parent', { time: 100 }),
      entry('fork', { parentSessionId: 'parent' }),
    ];
    const list = chatAgentSection(agents, { ...disclosure, expanded: new Set(['parent']) });
    expect(rowIds(list)).toEqual(['parent', 'fork', ...ids(agents.slice(0, CHAT_AGENT_LIMIT - 1))]);
    expect(list.overflow).toBe(1);
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

  it('no agents: no rows', () => {
    expect(chatAgentSection([], disclosure)).toEqual({ rows: [], total: 0, overflow: 0 });
  });
});

describe("#2574 a standalone agent's sub-agents", () => {
  // solo's own conversation spawned three sub-agents; one of them spawned its own (a grandchild).
  const sessions = [
    entry('solo-task', { agentUserId: 'solo', time: 9 }),
    entry('sub-quiet', { agentUserId: 'sub-1', parentSessionId: 'solo-task', time: 8 }),
    entry('sub-busy', { agentUserId: 'sub-2', parentSessionId: 'solo-task', presentation: running, time: 1 }),
    entry('sub-asks', { agentUserId: 'sub-3', parentSessionId: 'solo-task', presentation: waiting, time: 0 }),
    entry('grandchild', { agentUserId: 'sub-4', parentSessionId: 'sub-quiet', presentation: waiting }),
    entry('someone-else', { agentUserId: 'other', time: 5 }),
    entry('their-fork', { agentUserId: 'other-sub', parentSessionId: 'someone-else' }),
    // solo also forked under someone else's tree: that is not its conversation, and what hangs under it is not solo's.
    entry('solo-elsewhere', { agentUserId: 'solo', parentSessionId: 'someone-else' }),
    entry('elsewhere-kid', { agentUserId: 'kid', parentSessionId: 'solo-elsewhere' }),
  ];
  const families = agentFamilies(sessions);

  it("are the sessions spawned from the agent's own top-level sessions, with theirs under them; never the agent itself or anyone else's", () => {
    expect(ids(subAgentsOf(families, 'solo'))).toEqual(['sub-quiet', 'sub-busy', 'sub-asks', 'grandchild']);
    expect(subAgentsOf(families, 'sub-4')).toEqual([]);
    expect(subAgentsOf(families, 'sub-1'), 'a sub-agent has no top-level session to walk from').toEqual([]);
    expect(subAgentsOf(families, 'nobody')).toEqual([]);
  });

  it("one pass indexes each session, its children and each agent's top-level sessions (newest first)", () => {
    const twice = agentFamilies([...sessions, entry('solo-older', { agentUserId: 'solo', time: 1 })]);
    expect(ids(twice.topLevelOf.get('solo')!)).toEqual(['solo-task', 'solo-older']);
    expect(ids(twice.childrenOf.get('someone-else')!)).toEqual(['their-fork', 'solo-elsewhere']);
    expect(twice.byId.get('grandchild')?.parentSessionId).toBe('sub-quiet');
  });

  it('list like a group\'s 智能体: needs you, then running, then the rest; a grandchild stays folded under its parent', () => {
    const subAgents = subAgentsOf(families, 'solo');
    const folded = chatAgentSection(subAgents, disclosure);
    expect(rowIds(folded)).toEqual(['sub-asks', 'sub-busy', 'sub-quiet']);
    expect(folded.rows.find((row) => row.sessionId === 'sub-quiet')).toMatchObject({ hasChildren: true, needsAttention: true });
    expect(chatAgentCounts(subAgents)).toEqual({ total: 4, running: 1 });
    const open = chatAgentSection(subAgents, { ...disclosure, expanded: new Set(['sub-quiet']) });
    expect(open.rows.map(({ sessionId, depth }) => [sessionId, depth])).toEqual([
      ['sub-asks', 0],
      ['sub-busy', 0],
      ['sub-quiet', 0],
      ['grandchild', 1],
    ]);
  });
});
