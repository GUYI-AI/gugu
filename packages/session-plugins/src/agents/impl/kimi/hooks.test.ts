import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { GUGU_HOOK_MARKER } from '@gugu/session-core/agents/plugins/helpers';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { buildKimiHookConfig, KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH } from './hooks';

function memoryFs(seed: Record<string, string> = {}): PluginFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async read(path) { return files.get(path) ?? null; },
    async write(path, content) { files.set(path, content); },
    async delete(path) { files.delete(path); },
    async exists(path) { return files.has(path); },
    async list(path) { return [...files.keys()].filter((file) => file.startsWith(path)); },
  };
}

const hooks = buildKimiHookConfig();
const userHook = '[[hooks]]\nevent = "Stop"\ncommand = "say done"\n';

describe('Kimi hooks', () => {
  it('reports a config it cannot parse instead of skipping it and claiming the hooks were written', async () => {
    const fs = memoryFs({ [KIMI_CONFIG_PATH]: 'model = "k2\n[[broken' });
    await expect(hooks.writeHooks(fs, [])).rejects.toThrow(KIMI_CONFIG_PATH);
    await expect(hooks.getHooksInstalled(fs)).rejects.toThrow(KIMI_CONFIG_PATH);
    await expect(hooks.deleteHooks(fs)).rejects.toThrow(KIMI_CONFIG_PATH);
    expect(fs.files.get(KIMI_CONFIG_PATH)).toBe('model = "k2\n[[broken');
  });

  it('reports a broken legacy config too, after writing the main one', async () => {
    const fs = memoryFs({ [KIMI_LEGACY_CONFIG_PATH]: '[[broken' });
    await expect(hooks.writeHooks(fs, [])).rejects.toThrow(KIMI_LEGACY_CONFIG_PATH);
  });

  it('keeps the owner’s hooks, adds ours, and updates the legacy path only when it already exists', async () => {
    const fs = memoryFs({ [KIMI_CONFIG_PATH]: userHook });
    expect(await hooks.writeHooks(fs, [])).toEqual([KIMI_CONFIG_PATH]);
    expect(fs.files.has(KIMI_LEGACY_CONFIG_PATH)).toBe(false);
    const written = parse(fs.files.get(KIMI_CONFIG_PATH)!) as { hooks: Array<{ command: string }> };
    expect(written.hooks[0]).toEqual({ event: 'Stop', command: 'say done' });
    expect(written.hooks.some((hook) => hook.command.includes(GUGU_HOOK_MARKER))).toBe(true);
    expect(await hooks.getHooksInstalled(fs)).toBe(true);

    fs.files.set(KIMI_LEGACY_CONFIG_PATH, userHook);
    expect(await hooks.writeHooks(fs, [])).toEqual([KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH]);
    await hooks.deleteHooks(fs);
    for (const path of [KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH]) {
      expect(parse(fs.files.get(path)!)).toEqual({ hooks: [{ event: 'Stop', command: 'say done' }] });
    }
    expect(await hooks.getHooksInstalled(fs)).toBe(false);
  });

  it('removing hooks from a config without any leaves the file untouched', async () => {
    const fs = memoryFs({ [KIMI_CONFIG_PATH]: 'model = "k2"\n' });
    await hooks.deleteHooks(fs);
    expect(fs.files.get(KIMI_CONFIG_PATH)).toBe('model = "k2"\n');
    expect(fs.files.has(KIMI_LEGACY_CONFIG_PATH)).toBe(false);
  });
});
