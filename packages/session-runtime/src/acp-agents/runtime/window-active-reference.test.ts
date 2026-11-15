import { acpApiContract, acpRuntimeApiContract, decodeSessionUpdate } from '@gugu/session-core/acp';
import { createTestWire } from '@gugu/session-wire/testing';
import { defineContract } from '@gugu/session-wire/api';
import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpProcedures } from '../api/procedures';
import { AcpRuntime } from './runtime';

it('proves only the actual primary active reference through a private scalar RPC without cloning its body', async () => {
  const h = makeAcpHarness(), rt = new AcpRuntime(h.deps), sessionId = 'primary-proof';
  const contract = defineContract({ windowActiveReference: acpRuntimeApiContract.windowActiveReference });
  const wire = createTestWire(contract, { windowActiveReference: createAcpProcedures(rt).windowActiveReference });
  expect(acpApiContract).not.toHaveProperty('windowActiveReference');
  expect(await wire.client.windowActiveReference({ sessionId, referenceId: 'unknown' })).toBe(false);
  expect((await rt.startSession(makeStartInput({ sessionId }))).success).toBe(true);
  const finished = Promise.withResolvers<{ stopReason: 'end_turn' }>(); h.agent.prompt = vi.fn(() => finished.promise);
  const prompt = rt.sendPrompt(sessionId, { text: 'real prompt', origin: 'typed' }); await h.agent.called('prompt');
  const referenceId = rt.manager.getChatHistory(sessionId).active?.referenceId;
  if (!referenceId) throw new Error('Missing real active reference');
  const clone = vi.spyOn(globalThis, 'structuredClone');
  expect(rt.windowActiveReference(sessionId, referenceId)).toBe(true); expect(clone).not.toHaveBeenCalled(); clone.mockRestore();
  expect(await wire.client.windowActiveReference({ sessionId, referenceId })).toBe(true);
  expect(await wire.client.windowActiveReference({ sessionId, referenceId: 'another-reference' })).toBe(false);
  expect(await wire.client.windowActiveReference({ sessionId: 'other-session', referenceId })).toBe(false);
  finished.resolve({ stopReason: 'end_turn' }); await prompt;
  expect(await wire.client.windowActiveReference({ sessionId, referenceId })).toBe(false);
  wire.dispose(); await rt.dispose();
});

it('does not use replay lifecycle phase or a completed historical reference as live active proof', async () => {
  const h = makeAcpHarness(), rt = new AcpRuntime(h.deps), sessionId = 'replay-proof';
  const loaded = Promise.withResolvers<Record<string, never>>(); h.agent.loadSession = vi.fn(() => loaded.promise);
  const starting = rt.resumeSession({ ...makeStartInput({ sessionId }), providerSessionId: 'native-proof' });
  await h.agent.called('loadSession');
  await h.client().sessionEvent({ sessionId: 'native-proof', event: decodeSessionUpdate({ sessionUpdate: 'user_message_chunk',
    messageId: 'historical-message', content: { type: 'text', text: 'historical body' } }) });
  const historical = rt.manager.getChatHistory(sessionId).active?.referenceId;
  if (!historical) throw new Error('Missing replay active reference');
  expect(rt.windowActiveReference(sessionId, historical)).toBe(false);
  loaded.resolve({}); expect((await starting).success).toBe(true);
  expect(rt.windowActiveReference(sessionId, historical)).toBe(false); expect(rt.manager.getChatHistory(sessionId).active).toBeNull();
  await rt.dispose();
});
