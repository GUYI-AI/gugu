import { expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

it('every managed root declares import groups, credential exclusions and a child-env route', () => {
  for (const plugin of pluginRegistry.getAll()) {
    const bundle = plugin.capabilities.sessionBundle;
    if (!bundle?.configRoot) continue;
    const spec = bundle.configRoot;
    expect(bundle.injectionMode, plugin.metadata.id).toBe('managed-config-root');
    expect(bundle.shellEnv?.passThrough, plugin.metadata.id).toContain(spec.envVar);
    expect(spec.importGroups.length, plugin.metadata.id).toBeGreaterThan(0);
    expect(Array.isArray(spec.credentialPaths), plugin.metadata.id).toBe(true);
    for (const entry of [...spec.importGroups, ...spec.credentialPaths, ...spec.carryExclusions]) {
      expect(entry.evidence.trim().length, plugin.metadata.id).toBeGreaterThan(0);
    }
  }
});

it.each([
  ['claude', ['sessions', '.last-cleanup']],
  ['codex', ['.tmp', 'thread-writer-locks', 'installation_id', '.sandbox_migration']],
] as const)('keeps %s runtime state out of the import groups', (id, runtimeFiles) => {
  const root = pluginRegistry.get(id)!.capabilities.sessionBundle!.configRoot!;
  expect(root.carryExclusions.map((entry) => entry.path)).toEqual(expect.arrayContaining([...runtimeFiles]));
});
