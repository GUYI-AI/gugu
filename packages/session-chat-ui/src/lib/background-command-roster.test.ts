/**
 * #5117 —— 后台命令花名册:谁还在跑,谁不该再算在跑。
 */
import { describe, expect, it } from 'vitest';
import { collectBackgroundCommandRoster, runningBackgroundTaskIds } from './background-command-roster';
import { backgroundCommandToggleId, markOpenCommands } from '../state/flatten';

const FALLBACK = '后台命令';

function turn(
  items: unknown[],
  opts: { replayed?: boolean } = {}
): { id: string; items: unknown[]; startedAt?: number } {
  return {
    id: 't1',
    items,
    // 重放出来的一轮没有 startedAt —— reducer 只给活着的会话盖时刻。
    ...(opts.replayed === true ? {} : { startedAt: 1000 }),
  };
}

const bash = (over: Record<string, unknown> = {}) => ({
  kind: 'execute-tool-call',
  id: 'item-1',
  seq: 1,
  toolCallId: 'call_bash',
  title: 'sleep 3000',
  status: 'done',
  backgroundTaskId: 'b3qprnhlb',
  ...over,
});

describe('collectBackgroundCommandRoster', () => {
  it('起了后台任务、通知还没到 ⇒ 在跑', () => {
    const roster = collectBackgroundCommandRoster(
      [turn([bash()])] as never,
      null,
      FALLBACK,
      null
    );
    expect(roster).toEqual([{ id: 'item-1', launchToolCallId: 'call_bash', taskId: 'b3qprnhlb', name: 'sleep 3000' }]);
  });

  it('通知到了 ⇒ 不再算在跑', () => {
    const roster = collectBackgroundCommandRoster(
      [turn([bash({ backgroundTaskDone: true })])] as never,
      null,
      FALLBACK,
      null
    );
    expect(roster).toEqual([]);
  });

  it('阴控:没起后台任务的普通调用不进名册', () => {
    const roster = collectBackgroundCommandRoster(
      [turn([bash({ backgroundTaskId: undefined })])] as never,
      null,
      FALLBACK,
      null
    );
    expect(roster).toEqual([]);
  });

  it('重放里的不算在跑:resume 起的是新进程,上一轮那条命令没跟过来', () => {
    const roster = collectBackgroundCommandRoster(
      [turn([bash()], { replayed: true })] as never,
      null,
      FALLBACK,
      null
    );
    expect(roster).toEqual([]);
  });

  it('活着的那一轮(activeTurn)里的照收', () => {
    const roster = collectBackgroundCommandRoster([], turn([bash()]) as never, FALLBACK, null);
    expect(roster).toHaveLength(1);
  });

  it('嵌在子调用里的也找得到,标题空了退到通用词', () => {
    const wrapper = {
      kind: 'tool-group',
      id: 'g1',
      seq: 0,
      status: 'done',
      children: [bash({ title: '   ' })],
    };
    const roster = collectBackgroundCommandRoster([turn([wrapper])] as never, null, FALLBACK, null);
    expect(roster).toEqual([{ id: 'item-1', launchToolCallId: 'call_bash', taskId: 'b3qprnhlb', name: FALLBACK }]);
  });
});

describe('#6582 花名册按运行时说的在跑任务 id 筛', () => {
  const stored = [turn([bash()])] as never;

  it('运行时说它还在跑 ⇒ 留着;停止键拿到的仍是供应商的任务 id', () => {
    expect(collectBackgroundCommandRoster(stored, null, FALLBACK, ['b3qprnhlb'])).toEqual([
      { id: 'item-1', launchToolCallId: 'call_bash', taskId: 'b3qprnhlb', name: 'sleep 3000' },
    ]);
  });

  it('库里那张卡说在跑、运行时没这个 id(上一个进程起的,随进程没了)⇒ 不算在跑', () => {
    expect(collectBackgroundCommandRoster(stored, null, FALLBACK, ['someone-else'])).toEqual([]);
  });

  it('空数组 = 运行时说本进程里一条都没有 ⇒ 全筛掉', () => {
    expect(collectBackgroundCommandRoster(stored, null, FALLBACK, [])).toEqual([]);
  });

  it('null = 旧运行时没报这一格 ⇒ 不筛,保持旧行为', () => {
    expect(collectBackgroundCommandRoster(stored, null, FALLBACK, null)).toHaveLength(1);
  });

  it('运行时说在跑、转录里却已落定 ⇒ 仍以转录为准不收(两边都说在跑才算)', () => {
    expect(collectBackgroundCommandRoster([turn([bash({ backgroundTaskDone: true })])] as never, null, FALLBACK, ['b3qprnhlb'])).toEqual([]);
  });
});

describe('#6582 runningBackgroundTaskIds', () => {
  it('活会话报了数组 ⇒ 原样用', () => {
    expect(runningBackgroundTaskIds({ lifecycle: 'ready', backgroundCommandTaskIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(runningBackgroundTaskIds({ lifecycle: 'ready', backgroundCommandTaskIds: [] })).toEqual([]);
  });

  it('活会话没报这一格(旧运行时)⇒ null:不知道、不过滤', () => {
    expect(runningBackgroundTaskIds({ lifecycle: 'ready' })).toBeNull();
    expect(runningBackgroundTaskIds({ lifecycle: 'working' })).toBeNull();
  });

  it('没有活着的进程(没连上 / lost / closed)⇒ 一条都不在跑,哪怕上一刻还报着 id', () => {
    expect(runningBackgroundTaskIds(null)).toEqual([]);
    expect(runningBackgroundTaskIds(undefined)).toEqual([]);
    expect(runningBackgroundTaskIds({ lifecycle: 'lost', backgroundCommandTaskIds: ['a'] })).toEqual([]);
    expect(runningBackgroundTaskIds({ lifecycle: 'closed', backgroundCommandTaskIds: ['a'] })).toEqual([]);
    expect(runningBackgroundTaskIds({ lifecycle: 'lost' })).toEqual([]);
  });
});

/**
 * owner 2026-11-12:「这个命令行怎么是全部内容展示,不渐进披露吗」。单子里一行默认写那句短说明,
 * 说明从哪来钉在这里;怎么画、点开怎么写全钉在 background-tasks.contract.test.tsx。
 */
describe('后台命令的短说明(收着时那一行写它)', () => {
  const longCommand = 'cd ~/gugu && GUGU_DATA_DIR=/tmp/iso \\\n  pnpm dev:desktop > /tmp/iso.log 2>&1';
  const run = (node: Record<string, unknown>) =>
    collectBackgroundCommandRoster([turn([bash(node)])] as never, null, FALLBACK, null)[0];

  it('claude 的 Bash 只在入参里带 description:取它,名字仍是整条命令', () => {
    const entry = run({ title: longCommand, rawInput: JSON.stringify({ command: longCommand, description: 'Relaunch isolated dev app', run_in_background: true }) });
    expect(entry.summary).toBe('Relaunch isolated dev app');
    expect(entry.name).toBe(longCommand);
  });

  it('供应商自己在 inputSummary 里说了的优先', () => {
    const entry = run({ inputSummary: 'Installing dependencies', rawInput: JSON.stringify({ command: 'pnpm i', description: 'other words' }) });
    expect(entry.summary).toBe('Installing dependencies');
  });

  it('PowerShell 那种 command_description 也认', () => {
    expect(run({ rawInput: JSON.stringify({ command: 'Get-Process', command_description: 'List processes' }) }).summary).toBe('List processes');
  });

  it('阴控:没给说明 / 说明为空 / 入参不是 JSON ⇒ 没有这一格,❌ 编一句', () => {
    expect(run({}).summary).toBeUndefined();
    expect(run({ rawInput: JSON.stringify({ command: 'sleep 3000', description: '   ' }) }).summary).toBeUndefined();
    expect(run({ rawInput: '{"command": "sleep 3000", "descr' }).summary).toBeUndefined();
    expect(Object.keys(run({}))).not.toContain('summary');
  });

  it('标题空着、说明给了 ⇒ 名字就是说明,不再另给一份', () => {
    const entry = run({ title: '  ', rawInput: JSON.stringify({ description: 'Relaunch isolated dev app' }) });
    expect(entry.name).toBe('Relaunch isolated dev app');
    expect(entry.summary).toBeUndefined();
  });

  it('说明与命令一字不差 ⇒ 不给(点开只会重复一遍)', () => {
    expect(run({ rawInput: JSON.stringify({ command: 'sleep 3000', description: 'sleep 3000' }) }).summary).toBeUndefined();
  });
});

describe('markOpenCommands:按开关给点开着的命令标上 open', () => {
  const a = { id: 'a', name: 'x' };
  const b = { id: 'b', name: 'y' };

  it('只标点开的那条;收着的原样(同一个对象)', () => {
    const open = new Set([backgroundCommandToggleId('b')]);
    const [left, right] = markOpenCommands([a, b], (id) => open.has(id));
    expect(left).toBe(a);
    expect(right).toEqual({ ...b, open: true });
  });

  it('开关 id 与「后台 · …」那一句的开关、与别的命令都不撞', () => {
    expect(backgroundCommandToggleId('a')).not.toBe(backgroundCommandToggleId('b'));
    expect(backgroundCommandToggleId('open')).not.toBe('background-tasks:open');
  });
});
