import { describe, expect, it } from 'vitest';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
import { buildSessionRow } from './build-session-row';
import { mapSessionRowToSession, recordedSessionModelOption } from './utils';

const firstConnection = '481825a8-60b9-4c83-8d1b-f104e3db0269';
const secondConnection = 'ae6fe897-adfa-4e9f-978d-4dd04f520c78';

function readRecordedChoice(model?: string) {
  const built = buildSessionRow({
    id: 'conversation', projectId: 'project', workspaceId: 'workspace', title: 'Task',
    agentDisplayName: 'Codex', provider: 'codex', runtime: 'acp',
    origin: { kind: 'create', firstUtterance: 'remember this conversation' },
    claimsFirstSpawn: false, permissionMode: 'edit', model,
  });
  return mapSessionRowToSession({
    ...built, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
    lastInteractedAt: null, agentStatus: null, agentStatusDetail: null,
    agentStatusSeen: 1, isPinned: 0, parentSessionId: null, spawnedBySessionId: null,
  } as never);
}

describe('model reload readback retains the selected connection', () => {
  it.each(['beta-context-echo', 'provider/model:variant', ''])('roundtrips a custom choice with model %j through the real row writer and reader', modelId => {
    const selected = customModelOptionId({ connectionId: firstConnection, modelId });
    const session = readRecordedChoice(selected);
    expect(session.model).toBe(modelId || undefined);
    expect(recordedSessionModelOption(session)).toBe(selected);
  });

  it('does not accept another connection or native route offering the same model', () => {
    const first = customModelOptionId({ connectionId: firstConnection, modelId: 'same-model' });
    const second = customModelOptionId({ connectionId: secondConnection, modelId: 'same-model' });
    expect(recordedSessionModelOption(readRecordedChoice(first))).not.toBe(second);
    expect(recordedSessionModelOption(readRecordedChoice(first))).not.toBe('same-model');
    expect(recordedSessionModelOption(readRecordedChoice('same-model'))).not.toBe(first);
  });

  it('reads a cleared choice on the return to platform, and retains native choices', () => {
    expect(recordedSessionModelOption(readRecordedChoice())).toBeUndefined();
    expect(recordedSessionModelOption(readRecordedChoice('gpt-6'))).toBe('gpt-6');
  });
});
