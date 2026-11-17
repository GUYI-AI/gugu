import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { describe, expect, it } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const liveSettings = pluginRegistry.get('antigravity')!.capabilities.acp.liveSettings;
const modelOption = (selected: string, models = ['gemini-family']): SessionConfigOption => ({
  id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: selected,
  options: models.map(value => ({ value, name: value })),
});
const depthOption = (selected: string): SessionConfigOption => ({
  id: 'thinking_level', category: 'thought_level', type: 'select', name: 'Thinking depth', currentValue: selected,
  options: ['low', 'medium', 'high'].map(value => ({ value, name: value })),
});

describe('Antigravity live settings with the registered provider contract', () => {
  it.each(['low', 'high'])('uses the reported %s default, and writes thinking_level with read-back', async (initial) => {
    expect(liveSettings?.effort).toMatchObject({ channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject' });
    const h = makeAcpHarness({ providerId: 'antigravity', liveSettings });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-1', configOptions: [modelOption('gemini-family'), depthOption(initial)] });
    h.agent.setSessionConfigOption.mockImplementation(async ({ value }) => ({
      configOptions: [modelOption('gemini-family'), depthOption(value)],
    }));
    try {
      expect((await rt.startSession(makeStartInput({ providerId: 'antigravity' }))).success).toBe(true);
      expect(rt.sessionLiveModels('conv-1')!.states.config.snapshot().data.efforts).toMatchObject({ configId: 'thinking_level', selected: initial });
      expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
      expect((await rt.setModelOption('conv-1', 'effort', 'medium')).success).toBe(true);
      expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'session-1', configId: 'thinking_level', value: 'medium' });
      expect(rt.sessionLiveModels('conv-1')!.states.config.snapshot().data.efforts?.selected).toBe('medium');
      expect((await rt.sendPrompt('conv-1', { text: 'send after depth change' })).success).toBe(true);
      expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    } finally { await rt.dispose(); }
  });

  it('applies a chosen initial depth through the same provider-owned option', async () => {
    const h = makeAcpHarness({ providerId: 'antigravity', liveSettings });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-1', configOptions: [modelOption('gemini-family'), depthOption('low')] });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({ configOptions: [modelOption('gemini-family'), depthOption('high')] });
    try {
      expect((await rt.startSession(makeStartInput({ providerId: 'antigravity', effort: 'high' }))).success).toBe(true);
      expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'session-1', configId: 'thinking_level', value: 'high' });
      expect(rt.sessionLiveModels('conv-1')!.states.config.snapshot().data.efforts?.selected).toBe('high');
    } finally { await rt.dispose(); }
  });

  it('keeps old model-id depth variants selectable without inventing an effort axis', async () => {
    const variants = ['gemini-family-low', 'gemini-family-medium', 'gemini-family-high'];
    const h = makeAcpHarness({ providerId: 'antigravity', liveSettings });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-1', configOptions: [modelOption(variants[0]!, variants)] });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({ configOptions: [modelOption(variants[2]!, variants)] });
    try {
      expect((await rt.startSession(makeStartInput({ providerId: 'antigravity' }))).success).toBe(true);
      const config = rt.sessionLiveModels('conv-1')!.states.config;
      expect(config.snapshot().data.modelOptions?.available.map(option => option.id)).toEqual(variants);
      expect(config.snapshot().data.efforts).toBeNull();
      expect((await rt.setModelOption('conv-1', 'model', variants[2]!)).success).toBe(true);
      expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'session-1', configId: 'model', value: variants[2] });
      expect(config.snapshot().data.modelOptions?.selected).toBe(variants[2]);
      expect(config.snapshot().data.efforts).toBeNull();
      expect((await rt.sendPrompt('conv-1', { text: 'old-server follow-up' })).success).toBe(true);
    } finally { await rt.dispose(); }
  });
});
