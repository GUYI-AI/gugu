import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';
import { parse } from 'yaml';

export type NativeCreationSkill = { id: string; name: string; description: string };

/** Real SKILL.md files only. Missing directories are empty; permission and read failures remain failures. */
export async function readNativeCreationSkills(roots: readonly string[]): Promise<NativeCreationSkill[]> {
  const visited = new Set<string>();
  const skills = new Map<string, NativeCreationSkill>();
  async function visit(path: string): Promise<void> {
    let real: string;
    try { real = await fs.realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (visited.has(real)) return;
    visited.add(real);
    const entries = await fs.readdir(real, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      const file = join(real, 'SKILL.md');
      const text = await fs.readFile(file, 'utf8');
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      const fields = frontmatter ? parse(frontmatter[1]) as Record<string, unknown> | null : null;
      if (typeof fields?.name !== 'string' || !fields.name.trim() || typeof fields.description !== 'string' || !fields.description.trim()) throw new Error(`Invalid skill metadata: ${file}`);
      // Project roots come first and override the same native skill name, as in the agent's discovery order.
      if (!skills.has(fields.name)) skills.set(fields.name, { id: file, name: fields.name, description: fields.description });
      return;
    }
    for (const entry of entries) if (entry.isDirectory() || entry.isSymbolicLink()) {
      const child = join(real, entry.name);
      if ((await fs.stat(child)).isDirectory()) await visit(child);
    }
  }
  for (const root of roots) await visit(root);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Same registered harness and spawn environment as a real new task; no App catalog or process launch. */
export async function createSkills(input: { harness: string; projectId?: string }) {
  try {
    const { getPlugin } = await import('../agents/plugin-registry');
    const { resolveLocalAgentSpawnEnv } = await import('../agents/agent-run-context');
    const { readProjects } = await import('../projects/operations/getProjects');
    const bundle = getPlugin(input.harness).capabilities.sessionBundle;
    const project = input.projectId ? readProjects().find((one) => one.id === input.projectId) : null;
    if (input.projectId && !project) throw new Error('Project is unavailable on this device');
    const env = await resolveLocalAgentSpawnEnv(input.harness);
    const roots: string[] = [];
    const folder = input.harness === 'claude' ? '.claude' : input.harness === 'codex' ? '.agents' : input.harness === 'pi' ? '.pi' : null;
    if (project && folder) roots.push(join(project.path, folder, 'skills'));
    if (bundle.nativeHome) roots.push(join(nativeHomeRoots(bundle.nativeHome, env, homedir())[0], 'skills'));
    if (input.harness === 'codex') roots.push(join(homedir(), '.agents', 'skills'));
    if (bundle.acpConfigRoot) {
      const root = env[bundle.acpConfigRoot.envVar] || (process.env.GUGU_HOME ? join(process.env.GUGU_HOME, ...bundle.acpConfigRoot.guguHomePath) : null);
      if (!root) throw new Error('Agent configuration directory is unavailable');
      roots.push(join(root, 'skills'));
    }
    return { ok: true as const, value: { skills: await readNativeCreationSkills(roots) } };
  } catch (error) {
    return { ok: false as const, error: { code: 'skills_unavailable', message: error instanceof Error ? error.message : String(error) } };
  }
}
