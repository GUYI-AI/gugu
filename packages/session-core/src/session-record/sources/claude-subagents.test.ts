import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionRecordLocator } from '../contract';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

const text = (text: string) => ({ type: 'text', text });
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
function line(uuid: string, type: 'user' | 'assistant', content: unknown[], extra: object = {}) {
  return JSON.stringify({ uuid, type, sessionId: 'parent', timestamp: '2026-10-26T11:40:00Z',
    message: { role: type, id: uuid, content }, ...extra });
}
const end = (uuid: string, content: string, extra: object = {}) => JSON.stringify({
  ...JSON.parse(line(uuid, 'assistant', [text(content)], extra)),
  message: { role: 'assistant', id: uuid, content: [text(content)], stop_reason: 'end_turn' },
});
async function fixture(parent: string[], children: Record<string, string[]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-native-children-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'project');
  const childDirectory = join(directory, 'parent', 'subagents');
  await mkdir(childDirectory, { recursive: true });
  const file = join(directory, 'parent.jsonl');
  await writeFile(file, parent.join('\n') + '\n');
  for (const [id, lines] of Object.entries(children)) await writeFile(join(childDirectory, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  const locator: SessionRecordLocator = { harness: 'claude', providerSessionId: 'parent', roots: [root] };
  return { file, childDirectory, locator };
}

const launch = (id: string, prompt: string, name = 'Agent') => use(id, name, { description: prompt, prompt, run_in_background: true });
const launched = (uuid: string, callId: string, agentId: string, extra: object = {}) => line(uuid, 'user', [result(callId, 'Agent launched')], {
  toolUseResult: { isAsync: true, status: 'async_launched', agentId }, ...extra,
});
const child = { isSidechain: true, agentId: 'worker' };

describe('Claude native subagent records', () => {
  it('projects nested child tools through the shared stream and restores independent child tails', async () => {
    const { locator, childDirectory } = await fixture([
      line('user', 'user', [text('Inspect the repository')]),
      line('launch', 'assistant', [launch('launch-worker', 'Audit')]),
      launched('launched', 'launch-worker', 'worker'),
      end('parent-end', 'PARENT_RESULT'),
    ], {
      worker: [
        line('child-user', 'user', [text('Audit')], child),
        line('child-thought', 'assistant', [{ type: 'thinking', thinking: 'CHILD_THOUGHT' }], child),
        line('child-shell', 'assistant', [use('child-step', 'Bash', { command: 'inspect' })], child),
        line('nested-launch', 'assistant', [launch('launch-nested', 'Nested audit', 'Task')], child),
        launched('nested-launched', 'launch-nested', 'nested', child),
      ],
      nested: [line('nested-user', 'user', [text('Nested audit')], { isSidechain: true, agentId: 'nested' }),
        end('nested-end', 'NESTED_RESULT', { isSidechain: true, agentId: 'nested' })],
    });
    const timeline = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent' });
    disposers.push(() => timeline.dispose());
    const snapshot = timeline.getSnapshot();
    const items = snapshot.turns.flatMap((turn) => turn.items);
    expect(items.filter((item) => item.kind === 'message')).toEqual([
      expect.objectContaining({ role: 'user', text: 'Inspect the repository' }),
      expect.objectContaining({ role: 'assistant', text: 'PARENT_RESULT' }),
    ]);
    expect(items.filter((item) => item.kind === 'unknown-tool-call')).toEqual([]);
    const launchCard = items.find((item) => item.kind === 'spawn-subagent-tool-call');
    expect(launchCard).toMatchObject({ status: 'done', agentStatus: 'running' });
    // The worker is still running: its calls and its text so far are beside the turns, not inside the turn that
    // launched it (#2500). The nested launch is one of its calls.
    expect(launchCard && 'children' in launchCard ? launchCard.children ?? [] : []).toEqual([]);
    expect(snapshot.subagents).toEqual([expect.objectContaining({
      toolCallId: launchCard && 'toolCallId' in launchCard ? launchCard.toolCallId : '', reasoning: 'CHILD_THOUGHT', completedSteps: expect.any(Number),
      steps: [expect.objectContaining({ toolCallId: 'child-step', status: 'running' }),
        expect.objectContaining({ kind: 'spawn-subagent-tool-call' })],
    })]);
    // The nested child's finish is in the worker's record: it completes the nested card and adds no row.
    expect(snapshot.turns).toHaveLength(1);
    expect(JSON.stringify(snapshot.turns)).not.toContain('subagent-done-tool-call');
    const pendingArchive = timeline.archive!();
    timeline.dispose();
    const archive = await pendingArchive;
    const reopened = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent', archive: archive! });
    disposers.push(() => reopened.dispose());
    expect(reopened.getSnapshot().turns).toEqual(snapshot.turns);
    await appendFile(join(childDirectory, 'agent-worker.jsonl'), [
      line('child-result', 'user', [result('child-step', 'SHELL_RESULT')], child),
      end('child-end', 'CHILD_RESULT', child),
    ].join('\n') + '\n');
    await reopened.catchUp();
    const updated = reopened.getSnapshot().turns.flatMap((turn) => turn.items);
    // The child's tail was read from where the archive left it: its end reached the card, and it is no longer running.
    expect(updated.find((item) => item.kind === 'spawn-subagent-tool-call')).toMatchObject({ agentStatus: 'completed', outputText: 'CHILD_RESULT' });
    expect(reopened.getSnapshot().subagents).toEqual([]);
    expect(updated.filter((item) => item.kind === 'message')).toEqual(items.filter((item) => item.kind === 'message'));

    // Older composite archives could lose child cursors during immediate disposal.
    const stale = { ...archive!, resume: { ...archive!.resume,
      data: { ...(archive!.resume.data as object), nativeChildren: 1, children: {} },
    } };
    const rebuilt = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent', archive: stale });
    disposers.push(() => rebuilt.dispose());
    expect(rebuilt.getSnapshot().turns.flatMap((turn) => turn.items).find((item) => item.kind === 'spawn-subagent-tool-call'))
      .toMatchObject({ agentStatus: 'completed', outputText: 'CHILD_RESULT' });
  });

  it('says a child finished where the root record notes it, with its reply, and only there', async () => {
    const notification = (uuid: string, agentId: string, callId: string, reply: string, status = 'completed') => JSON.stringify({
      uuid, type: 'user', sessionId: 'parent', timestamp: '2026-10-26T11:41:00Z', origin: { kind: 'task-notification' },
      message: { role: 'user', content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${callId}</tool-use-id>\n`
        + `<status>${status}</status>\n<summary>Agent "Audit" finished</summary>\n<result>${reply}</result>\n</task-notification>` },
    });
    const { locator } = await fixture([
      line('user', 'user', [text('Inspect the repository')]),
      line('launch', 'assistant', [launch('launch-worker', 'Audit')]),
      launched('launched', 'launch-worker', 'worker'),
      end('parent-end', 'WAITING'),
      line('next-user', 'user', [text('Go on')]),
      line('sync', 'assistant', [use('launch-sync', 'Agent', { description: 'Check', prompt: 'Check' })]),
      line('sync-result', 'user', [result('launch-sync', 'hand-back')], { toolUseResult: { status: 'completed', agentId: 'helper',
        content: [text('HELPER_RESULT')] } }),
      notification('notified', 'worker', 'launch-worker', 'WORKER_RESULT'),
      line('more', 'assistant', [launch('launch-broken', 'Break'), launch('launch-halted', 'Halt')]),
      launched('broken-launched', 'launch-broken', 'broken'),
      launched('halted-launched', 'launch-halted', 'halted'),
      notification('broken-notified', 'broken', 'launch-broken', 'BROKEN', 'failed'),
      notification('halted-notified', 'halted', 'launch-halted', 'HALTED', 'killed'),
      end('next-end', 'BOTH DONE'),
    ], {
      worker: [line('child-user', 'user', [text('Audit')], child), end('child-end', 'WORKER_RESULT', child)],
      broken: [line('broken-user', 'user', [text('Break')], { isSidechain: true, agentId: 'broken' })],
      halted: [line('halted-user', 'user', [text('Halt')], { isSidechain: true, agentId: 'halted' })],
      helper: [line('helper-user', 'user', [text('Check')], { isSidechain: true, agentId: 'helper' }),
        end('helper-end', 'HELPER_RESULT', { isSidechain: true, agentId: 'helper' })],
    });
    for (let read = 0; read < 3; read++) {
      const timeline = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent' });
      disposers.push(() => timeline.dispose());
      const turns = timeline.getSnapshot().turns;
      expect(turns.map((turn) => turn.initiator)).toEqual(['user', 'user']);
      expect(turns[0].items.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([]);
      expect(turns[1].items.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([
        expect.objectContaining({ launchToolCallId: 'helper', outcome: 'completed', outputText: 'HELPER_RESULT' }),
        expect.objectContaining({ launchToolCallId: 'worker', outcome: 'completed', outputText: 'WORKER_RESULT' }),
        expect.objectContaining({ launchToolCallId: 'broken', outcome: 'failed', outputText: 'BROKEN' }),
        expect.objectContaining({ launchToolCallId: 'halted', outcome: 'stopped', outputText: 'HALTED' }),
      ]);
    }
  });

  it('keeps a failed launch and ordinary completed tools without inventing a child identity', async () => {
    const { locator } = await fixture([
      line('user', 'user', [text('Run tools')]),
      line('launch', 'assistant', [launch('failed-launch', 'Audit')]),
      line('launch-failure', 'user', [result('failed-launch', 'Agent failed', true)]),
      line('shell', 'assistant', [use('ordinary-shell', 'Bash', { command: 'echo ok' })]),
      line('shell-result', 'user', [result('ordinary-shell', 'ok')]),
      end('end', 'DONE'),
    ]);
    const timeline = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'failed-launch' });
    disposers.push(() => timeline.dispose());
    const items = timeline.getSnapshot().turns.flatMap((turn) => turn.items);
    expect(items.find((item) => item.kind === 'unknown-tool-call')).toMatchObject({ toolCallId: 'failed-launch', status: 'error' });
    expect(items.find((item) => item.kind === 'execute-tool-call')).toMatchObject({ toolCallId: 'ordinary-shell', status: 'done', outputText: 'ok' });
    expect(items.filter((item) => item.kind === 'spawn-subagent-tool-call')).toEqual([]);
  });
});
