import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importAgentHome, planAgentHomeHistory, resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { qwenSessionBundleDescriptor as descriptor } from './session-bundle';

it('imports declared Qwen settings, MCP and Skills into the managed root without user hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-home-'));
  try {
    const source = join(root, 'native-qwen');
    const skills = join(source, 'skills', 'review');
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, 'SKILL.md'), 'Review the changes');
    const settings = {
      ui: { theme: 'dark' }, hooks: { Stop: [{ command: 'local-hook' }] },
      mcpServers: { example: { command: 'example' } }, security: { auth: { apiKey: 'synthetic-key' } },
      unknownProperty: true,
    };
    const original = JSON.stringify(settings);
    await writeFile(join(source, 'settings.json'), original);
    await writeFile(join(source, 'QWEN.md'), 'Use project rules');
    await writeFile(join(source, 'oauth_creds.json'), 'synthetic credentials');

    const home = resolveAgentHome({
      providerId: 'qwen', injectionMode: descriptor.injectionMode, configRoot: descriptor.configRoot,
      guguHome: join(root, 'gugu'), osHomeDir: root, sourceEnv: { QWEN_HOME: source },
    })!;
    expect(home.configRoot).toBe(join(root, 'gugu', 'agent-homes', 'qwen', '.qwen'));
    expect(home.upgradeHistory).toEqual(['projects']);
    await importAgentHome(home, { groups: new Set(['settings', 'mcp', 'rules', 'skills']) });

    expect(JSON.parse(await readFile(join(home.configRoot, 'settings.json'), 'utf8'))).toEqual({
      ui: { theme: 'dark' }, mcpServers: { example: { command: 'example' } },
    });
    expect(await readFile(join(home.configRoot, 'QWEN.md'), 'utf8')).toBe('Use project rules');
    expect(await readFile(join(home.configRoot, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('Review the changes');
    await expect(readFile(join(home.configRoot, 'oauth_creds.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe(original);

    const chats = 'projects/example/chats';
    const active = `${chats}/11111111-1111-4111-8111-111111111111`;
    const archived = `${chats}/archive/22222222-2222-4222-8222-222222222222`;
    await mkdir(join(source, chats, 'archive'), { recursive: true });
    await writeFile(join(source, `${active}.jsonl`), 'old');
    await utimes(join(source, `${active}.jsonl`), 100, 100);
    await writeFile(join(source, `${archived}.jsonl`), 'new');
    await writeFile(join(source, `${archived}.ledger.jsonl`), 'ledger');
    const shared = 'projects/example/preferences.json';
    await writeFile(join(source, shared), 'shared');
    const plan = await planAgentHomeHistory(home, 9);
    expect(plan).toMatchObject({ sessions: 1, sessionBytes: 9, skipped: [{ path: `${active}.jsonl`, bytes: 3 }] });
    expect(plan.paths).toEqual(expect.arrayContaining([shared, `${archived}.jsonl`, `${archived}.ledger.jsonl`]));
    expect(plan.paths).toHaveLength(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
