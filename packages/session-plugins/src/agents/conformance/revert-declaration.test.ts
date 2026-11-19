import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

/**
 * Rewind (#2970) is declared on every harness that has an ACP leg, and the declaration has to match the code:
 * `native` + `hook` ⇔ the plugin ships `acp.revert`; a Gugu bridge (`native` + `bridge`) answers `_session/revert` itself
 * and ships no hook; `unsupported` ships nothing, so its turns never carry a rewind point.
 */
describe('rewind declaration', () => {
  const acpPlugins = pluginRegistry.getAll().filter(provider => provider.capabilities.acp.kind === 'supported');

  it('every ACP harness says what it can do', () => {
    expect(acpPlugins.length).toBeGreaterThan(0);
    for (const provider of acpPlugins) {
      const acp = provider.capabilities.acp;
      expect(acp.kind === 'supported' && acp.revert, provider.metadata.id).toBeTruthy();
    }
  });

  it('a hook exists exactly where the declaration says the plugin drives the vendor itself', () => {
    for (const provider of acpPlugins) {
      const acp = provider.capabilities.acp;
      if (acp.kind !== 'supported') continue;
      const hooked = acp.revert.kind === 'native' && acp.revert.via === 'hook';
      expect(Boolean(provider.behavior.acp?.revert), provider.metadata.id).toBe(hooked);
    }
  });

  it('names the harnesses that rewind today', () => {
    const native = acpPlugins.flatMap(provider => {
      const acp = provider.capabilities.acp;
      return acp.kind === 'supported' && acp.revert.kind === 'native' ? [`${provider.metadata.id}:${acp.revert.via}:${acp.revert.files}`] : [];
    }).sort();
    expect(native).toEqual(['claude:bridge:optional', 'codebuddy:hook:none', 'codex:bridge:none', 'qwen:hook:default-on']);
  });
});
