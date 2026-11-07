import { expect, it, vi } from 'vitest';
import { resumeMoveCompletion, type MoveJournal } from './assistant-move';

function completion(legacy = false) {
  let journal: MoveJournal | null = { direction: 'to-cloud', assistantId: 'agent', startedAt: 1,
    source: { kind: 'computer', deviceId: 'local' }, targetDeviceId: 'cloud', schedules: [],
    done: ['preflight', 'adopt', 'files', 'accounts', 'schedules'],
    ...(legacy ? {} : { completion: { report: { files: 1, skippedFiles: [],
      accounts: { reconnect: [], unsupported: false },
      schedules: { restored: 0, skipped: [], unsupported: [], unreadable: false }, warnings: [] } } }) };
  return { direction: 'to-cloud' as const, assistantId: 'agent', isAdopted: vi.fn(async () => true),
    activate: vi.fn(async () => {}),
    journal: { load: () => journal, save: async (value: MoveJournal) => { journal = structuredClone(value); },
      clear: vi.fn(async () => { journal = null; }) } };
}

it('restores legacy completed handoffs online and finishes without touching any source account (#2104)', async () => {
  const deps = completion(true);
  const report = await resumeMoveCompletion(deps);
  expect(deps.activate).toHaveBeenCalledOnce();
  expect(deps.journal.clear).toHaveBeenCalledOnce();
  expect(report?.accounts).toEqual({ reconnect: [], unsupported: false });
  expect(report?.warnings).toEqual([]);
});

it('normalizes a pre-#2104 completion report so the dialog never reads the old account shape', async () => {
  const deps = completion();
  const saved = deps.journal.load()!;
  saved.completion!.report.accounts = { moved: [{ integrationId: 'notion', accountId: 'default' }], skipped: [], kept: [], unsupported: false } as never;
  const report = await resumeMoveCompletion(deps);
  expect(report?.accounts).toEqual({ reconnect: [], unsupported: false });
});

it('requires completed schedules before bypassing source transfer', async () => {
  const deps = completion();
  deps.journal.load()!.done = ['preflight', 'adopt', 'files', 'accounts'];
  expect(await resumeMoveCompletion(deps)).toBeNull();
  expect(deps.activate).not.toHaveBeenCalled();
  expect(deps.journal.clear).not.toHaveBeenCalled();
});

it('refuses activation if the recorded target no longer owns the assistant', async () => {
  const deps = completion();
  deps.isAdopted.mockResolvedValue(false);
  await expect(resumeMoveCompletion(deps)).rejects.toMatchObject({ step: 'adopt', sourceIntact: false });
  expect(deps.activate).not.toHaveBeenCalled();
  expect(deps.journal.clear).not.toHaveBeenCalled();
});

it('retains the completed handoff on another online failure and clears only after a successful retry', async () => {
  const deps = completion();
  deps.activate.mockRejectedValueOnce(new Error('network unavailable'));
  await expect(resumeMoveCompletion(deps)).rejects.toMatchObject({ step: 'restart', sourceIntact: false });
  expect(deps.journal.clear).not.toHaveBeenCalled();
  await expect(resumeMoveCompletion(deps)).resolves.toMatchObject({ files: 1 });
  expect(deps.journal.clear).toHaveBeenCalledOnce();
});
