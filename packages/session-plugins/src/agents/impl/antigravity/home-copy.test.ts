import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { importAgentHome, resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { antigravitySessionBundleDescriptor } from './session-bundle';

it('leaves IDE brain/scratch behind while preserving configuration and excluding OAuth credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-antigravity-config-'));
  try {
    const source = join(root, 'user/.gemini');
    const keep = ['config/skills/example/SKILL.md', 'config/mcp_config.json',
      'antigravity-cli/settings.json',
      'antigravity-acp/settings.json'];
    const content = (path: string) => path.endsWith('.json') ? JSON.stringify({ fixture: path }) : path;
    for (const p of [...keep, 'antigravity/brain/project/scratch/app.asar', 'antigravity-acp/brain/session.json', 'antigravity-acp/conversations/session.json', 'antigravity-cli/antigravity-oauth-token', 'antigravity-acp/acp_token.json']) {
      await mkdir(dirname(join(source, p)), { recursive: true });
      await writeFile(join(source, p), content(p));
    }
    const home = resolveAgentHome({ providerId: 'antigravity',
      injectionMode: antigravitySessionBundleDescriptor.injectionMode,
      configRoot: antigravitySessionBundleDescriptor.configRoot,
      guguHome: join(root, 'gugu'), osHomeDir: join(root, 'user'), sourceEnv: {},
    })!;
    await importAgentHome(home, { groups: new Set(['settings', 'hooks', 'mcp', 'skills']) });
    for (const p of keep) expect(await readFile(join(home.configRoot, p), 'utf8')).toBe(content(p));
    for (const path of ['antigravity-acp/brain', 'antigravity-acp/conversations', 'antigravity-cli/antigravity-oauth-token', 'antigravity-acp/acp_token.json']) await expect(stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home.configRoot, 'antigravity/brain'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'antigravity/brain/project/scratch/app.asar'), 'utf8')).toBe('antigravity/brain/project/scratch/app.asar');
  } finally { await rm(root, { recursive: true, force: true }); }
});
