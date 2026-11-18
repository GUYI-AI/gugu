import { expect, it } from 'vitest';
import { pluginRegistry } from '../registry';
import { matchCustomModel, modelProtocolSchema } from '@gugu/session-core/models/custom-model';

const supported: Record<string, readonly string[]> = {
  claude: ['anthropic-messages'], codex: ['openai-responses'], dsh: ['anthropic-messages'],
  qwen: ['openai-chat-completions'], copilot: ['openai-responses', 'openai-chat-completions'],
  zcode: ['openai-responses', 'openai-chat-completions'], hermes: ['openai-responses'],
  codebuddy: ['openai-chat-completions'], opencode: ['openai-responses', 'openai-chat-completions'],
  pi: ['openai-responses', 'openai-chat-completions'], kilocode: ['openai-responses'], mimocode: ['openai-responses'],
  antigravity: ['gemini-generate-content'],
};
for (const [id, expected] of Object.entries(supported)) {
  it.each(modelProtocolSchema.options)(`${id} × %s uses declared protocol support`, (protocol) => {
    const plugin = pluginRegistry.get(id)!;
    const platform = plugin.capabilities.sessionBundle.platform;
    const nativeProtocol = id === 'antigravity' ? 'gemini-generate-content' : platform.kind === 'supported' ? platform.wireProtocol : undefined;
    const result = matchCustomModel({ nativeProtocol, protocols: platform.kind === 'supported' ? platform.protocols : undefined, connection: { keySaved: true, endpoints: [{ protocol, baseUrl: 'https://provider.test' }] } });
    expect(result.reason, id).toBe(expected.includes(protocol) ? undefined : 'protocol');
    expect(plugin.capabilities).not.toHaveProperty('apiKeyConnection');
  });
}
it.each([['kilocode', 'KILO_API_KEY'], ['mimocode', 'XIAOMI_API_KEY']])('%s declares its vendor account key and inherited cleanup together', (id, envVar) => {
  const auth = pluginRegistry.get(id)!.capabilities.auth;
  expect(auth.kind).toBe('supported');
  if (auth.kind !== 'supported') throw new Error('auth declaration missing');
  expect(auth.vendorKey).toEqual({ envVars: [envVar], unsetEnv: [envVar] });
});
