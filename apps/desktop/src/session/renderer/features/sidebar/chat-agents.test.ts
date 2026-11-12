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

describe('my agents in a chat (#2599: where each was created, not the groups it is a member of)', () => {
  // `p-shop` / `p-shop-remote` are the shop project's folders; `p-ads` belongs to another listed project; `p-other` is the
  // task workspace (no project). `group-1` is a group with a topic `topic-1`; `shop-group` is the shop project's group.
  const listed = new Set(['p-shop', 'p-shop-remote', 'p-ads']);
  const inProject = (projectId: string) => listed.has(projectId);
  const group = (chatId: string, topics: Record<string, string> = {}) => ({
    kind: 'group' as const,
    projectIds: [],
    bornHere: (id: string) => id === chatId || topics[id] === chatId,
    inProject,
  });
  const shop = {
    kind: 'project' as const,
    projectIds: ['p-shop', 'p-shop-remote'],
    bornHere: (id: string) => id === 'shop-group',
    inProject,
  };
  const mine = [
    entry('born-in-group', { agentUserId: 'agent-a', bornInChatId: 'group-1' }),
    entry('born-in-topic', { agentUserId: 'agent-t', bornInChatId: 'topic-1' }),
    entry('born-in-dm', { agentUserId: 'agent-b', bornInChatId: 'dm-1' }),
    entry('created-with-button', { agentUserId: 'agent-c', bornInChatId: null }),
    entry('born-in-group-into-ads', { projectId: 'p-ads', agentUserId: 'agent-d', bornInChatId: 'group-1' }),
    entry('project-session', { projectId: 'p-shop', agentUserId: 'agent-e', bornInChatId: 'group-1' }),
    entry('project-folder-on-other-machine', { projectId: 'p-shop-remote' }),
    entry('born-in-shop-group-no-project', { agentUserId: 'agent-f', bornInChatId: 'shop-group' }),
  ];

  it('in a group: my agents created there or in one of its topics, outside every project', () => {
    expect(ids(myAgentsInChat(mine, group('group-1', { 'topic-1': 'group-1' })))).toEqual(['born-in-group', 'born-in-topic']);
  });

  it('a project chosen at creation wins over the group it was created in', () => {
    expect(ids(myAgentsInChat(mine, group('group-1')))).not.toContain('born-in-group-into-ads');
    expect(ids(myAgentsInChat(mine, group('group-1')))).not.toContain('project-session');
  });

  it('created from a direct message or with Create agent: in no group (a row of its own)', () => {
    for (const chatId of ['group-1', 'dm-1']) {
      expect(ids(myAgentsInChat(mine, group(chatId)))).not.toContain('created-with-button');
    }
    expect(ids(myAgentsInChat(mine, group('group-1')))).not.toContain('born-in-dm');
  });

  it("in a project: the project's sessions on every machine, and agents created in its group with no project", () => {
    expect(ids(myAgentsInChat(mine, shop))).toEqual(['project-session', 'project-folder-on-other-machine', 'born-in-shop-group-no-project']);
  });

  it('being a member is not living there: no membership is read at all', () => {
    // agent-b (born in a DM) may be a member of group-1; it still lives in its own row, not in this column.
    expect(ids(myAgentsInChat([entry('member-only', { agentUserId: 'agent-b', bornInChatId: 'dm-1' })], group('group-1')))).toEqual([]);
  });

  it('a sub-agent goes where the agent that spawned it lives, whatever its own project or origin', () => {
    const family = [
      entry('parent', { agentUserId: 'agent-a', bornInChatId: 'group-1' }),
      entry('child-in-shop', { projectId: 'p-shop', parentSessionId: 'parent', agentUserId: 'agent-g' }),
      entry('grandchild', { parentSessionId: 'child-in-shop', bornInChatId: 'dm-1' }),
    ];
    expect(ids(myAgentsInChat(family, group('group-1')))).toEqual(['parent', 'child-in-shop', 'grandchild']);
    expect(myAgentsInChat(family, shop)).toEqual([]);
  });

  it('a child whose parent is not in hand is judged by its own fields; a parent cycle ends', () => {
    const orphan = entry('orphan', { parentSessionId: 'on-another-machine', bornInChatId: 'group-1' });
    expect(ids(myAgentsInChat([orphan], group('group-1')))).toEqual(['orphan']);
    const cycle = [entry('x', { parentSessionId: 'y', bornInChatId: 'group-1' }), entry('y', { parentSessionId: 'x', bornInChatId: 'group-1' })];
    expect(myAgentsInChat(cycle, group('group-1'))).toEqual([]);
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
