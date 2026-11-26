/**
 * The model policy Claude Code applies to a gateway session's Auto mode reviewer (#4019), assembled the way the CLI
 * does (checked on 2.1.318):
 *  · a managed `availableModels` replaces every other list; `deniedModels` and `availableModelsMatch` come from
 *    managed settings only (claude-managed-settings.ts);
 *  · otherwise the lists in the user's, the project's (`<cwd>/.claude/settings.json`, parent folders not searched)
 *    and the local (`<cwd>/.claude/settings.local.json`) settings and in `--settings` are concatenated.
 * A Gugu-model session's `--settings` lists its reviewer (claudeSettingsOverride), so for it only the managed tier
 * can exclude the reviewer. A connection session's settings list nothing: the three files decide.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { ClaudeModelPolicy } from '@gugu/session-core/models/claude-model-policy';
import { managedClaudeModelPolicy } from './claude-managed-settings';

export type UserModelAllowlist = { file: string; pointer: string; models: string[] };

function userAllowlistSpec(providerId: string) {
  const models = pluginRegistry.get(providerId)?.capabilities.models;
  return models?.kind === 'selectable' ? models.userAllowlist : undefined;
}

function userSettingsFile(env: NodeJS.ProcessEnv, spec: NonNullable<ReturnType<typeof userAllowlistSpec>>): string {
  const configuredRoot = spec.envVar ? env[spec.envVar]?.trim() : undefined;
  return configuredRoot
    ? join(configuredRoot, spec.file.split('/').at(-1)!)
    : join(env.HOME?.trim() || homedir(), spec.file);
}

/**
 * The model allowlist a plugin declares in the user's own agent home (Claude: `~/.claude/settings.json`
 * `availableModels`). Null when there is none; a file that exists but cannot be read throws.
 */
export async function readUserModelAllowlist(env: NodeJS.ProcessEnv, providerId: string): Promise<UserModelAllowlist | null> {
  const allowlist = userAllowlistSpec(providerId);
  if (!allowlist) return null;
  const file = userSettingsFile(env, allowlist);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取用户设置 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let current: unknown = document;
  for (const segment of allowlist.pointer.slice(1).split('/')) {
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (!Array.isArray(current)) return null;
  return {
    file: allowlist.file,
    pointer: allowlist.pointer.slice(1).split('/').filter(Boolean).join('.'),
    models: current.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()),
  };
}

/** One file's `availableModels` as the CLI reads it: no file, bad JSON or a value that is not a list = none. */
async function settingsFileAllowlist(file: string): Promise<string[] | null> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const list = document && typeof document === 'object' ? (document as Record<string, unknown>).availableModels : undefined;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : null;
}

/** The user's, the project's and the local `availableModels`, concatenated; null when none of them sets one. */
export async function claudeScopeAllowlist(env: NodeJS.ProcessEnv, cwd?: string): Promise<string[] | null> {
  const spec = userAllowlistSpec('claude');
  const files = [
    ...(spec ? [userSettingsFile(env, spec)] : []),
    ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : []),
  ];
  const lists = (await Promise.all(files.map(settingsFileAllowlist))).filter((list): list is string[] => list !== null);
  return lists.length ? [...new Set(lists.flat())] : null;
}

export async function claudeReviewModelPolicy(input: { route: string; env: NodeJS.ProcessEnv; cwd?: string }): Promise<ClaudeModelPolicy> {
  const managed = await managedClaudeModelPolicy(input.env);
  if (managed.available || input.route === 'platform') return managed;
  return { ...managed, available: await claudeScopeAllowlist(input.env, input.cwd) };
}
