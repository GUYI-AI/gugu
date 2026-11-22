import { describe, expect, it, vi } from 'vitest';

import type { AcpRuntimeStartInput } from '@gugu/session-core/acp';
import { resumeHistoryFacts } from './resume-history';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const input = (patch: Partial<AcpRuntimeStartInput> = {}) => ({
  sessionId: 's1', projectId: 'p', providerId: 'codex', workspaceId: 'w', cwd: '/w',
  providerSessionId: 'thread-1', model: null, ...patch,
}) as AcpRuntimeStartInput;

describe('resuming without replay (#980)', () => {
  it.each(['claude', 'codex', 'hermes'])('%s resumes without replay, continuing turn numbers after the stored ones', async (providerId) => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input({ providerId }), {
      recordedDeliveryIds,
      turnIndexBase: async () => 12,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: ['msg:a'], turnIndexBase: 12 });
    expect(recordedDeliveryIds).toHaveBeenCalledWith('s1');
  });




  it('always reads the record for deliveries: a reconnecting runtime redelivers from a queue the host cannot see', async () => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input({ initialQueue: [{ text: 'hi', origin: 'manual' }] }), {
      recordedDeliveryIds,
      turnIndexBase: async () => 0,
    });
    expect(facts.recordedDeliveryIds).toEqual(['msg:a']);
    expect(recordedDeliveryIds).toHaveBeenCalledWith('s1');
  });

  it.each(['claude', 'codex', 'hermes'])('%s resumes with replay when the record cannot be read', async (providerId) => {
    const facts = await resumeHistoryFacts(input({ providerId }), { recordedDeliveryIds: async () => null, turnIndexBase: async () => 0 });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it('starts with replay and logs it when the record read fails', async () => {
    const { log } = await import('@main/lib/logger');
    vi.mocked(log.warn).mockClear();
    const facts = await resumeHistoryFacts(input(), {
      recordedDeliveryIds: async () => { throw new Error('record unreadable'); },
      turnIndexBase: async () => 4,
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
    expect(log.warn).toHaveBeenCalledWith('[acp-start] resume facts unavailable; resuming with replay',
      { sessionId: 's1', error: 'Error: record unreadable' });
  });

  it.each(['claude', 'codex', 'hermes'])('%s resumes with replay when it cannot tell where turn numbers continue', async (providerId) => {
    const facts = await resumeHistoryFacts(input({ providerId }), {
      recordedDeliveryIds: async () => [],
      turnIndexBase: async () => { throw new Error('store unreadable'); },
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it.each([
    ['a provider whose record gugu cannot read', { providerId: 'gemini' }],
    ['a provider gugu reads but whose adapter still replays', { providerId: 'qwen' }],
  ])('keeps the replay for %s but still says where turn numbers continue (a resume-only adapter replays nothing)', async (_label, patch) => {
    const facts = await resumeHistoryFacts(input({ ...patch, replayHistory: false } as Partial<AcpRuntimeStartInput>), {
      recordedDeliveryIds: async () => [], turnIndexBase: async () => 3,
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: 3 });
  });

  it.each([
    ['a session that never opened a provider session', { providerSessionId: null }],
    ['a runtime fork', { forkFromProviderSessionId: 'thread-0' }],
  ])('keeps the replay for %s and overwrites renderer-sent values', async (_label, patch) => {
    const facts = await resumeHistoryFacts(input({ ...patch, replayHistory: false } as Partial<AcpRuntimeStartInput>), {
      recordedDeliveryIds: async () => [], turnIndexBase: async () => 3,
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it('a route-switch fork continues this conversation: no replay, turn numbers after the stored ones', async () => {
    const facts = await resumeHistoryFacts(input({ forkFromProviderSessionId: 'thread-1', forkKeepsAgent: true }), {
      recordedDeliveryIds: async () => ['msg:a'], turnIndexBase: async () => 5,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: ['msg:a'], turnIndexBase: 5 });
  });
});
