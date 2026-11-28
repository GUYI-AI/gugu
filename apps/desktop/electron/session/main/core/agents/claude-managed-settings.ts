/**
 * Claude Code's managed model policy (`availableModels`, `deniedModels`, `availableModelsMatch` from managed settings
 * files, the remote-settings cache and MDM), read with the Agent SDK's `resolveSettings` (#4019). The SDK is pinned in
 * the root package.json; `resolveSettings` is marked @alpha there, so a release can change it: a changed or failed
 * call reads as no managed policy (logged), which is what Gugu assumed before this read existed.
 *
 *  · Read when a Claude Auto mode verdict first needs it, never at app start (the reading process costs ~83 MB);
 *    the answer is kept until the app exits. One cache for both main-process bundles (globalThis, keyed by the
 *    session's Claude config root: the remote-settings cache lives there).
 *  · A read that fails or takes longer than READ_TIMEOUT_MS counts as no managed policy, never as "blocked".
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';
import { fork } from '@gugu/core/local/childProcess';
import { NO_CLAUDE_MODEL_POLICY, type ClaudeModelPolicy } from '@gugu/session-core/models/claude-model-policy';
import { log } from '@main/lib/logger';
import { desktopWorkerPath } from '../../worker-manifest';

const READ_TIMEOUT_MS = 5_000;

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const CACHE = Symbol.for('gugu.claude.managedModelPolicy');

type ManagedRead = (env: NodeJS.ProcessEnv) => Promise<unknown>;

/** Where the reading process and the SDK are; tests point them elsewhere. */
type ReadOptions = { worker?: string; sdkEntry?: () => Promise<string>; timeoutMs?: number };

function claudeConfigRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.claude');
}

/** The reply as the review rule reads it. A managed list that is not a list is enforced as an empty one, and an
 * `availableModelsMatch` other than "prefix" as "exact", until it is fixed (the docs' invalid-settings table). */
export function managedPolicyOf(reply: unknown): ClaudeModelPolicy {
  const value = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    available: value.availableModels === undefined || value.availableModels === null ? null : strings(value.availableModels),
    denied: strings(value.deniedModels),
    exact: value.availableModelsMatch !== undefined && value.availableModelsMatch !== null && value.availableModelsMatch !== 'prefix',
  };
}

async function appSdkEntry(): Promise<string> {
  return createRequire(join(app.getAppPath(), 'package.json')).resolve(SDK_PACKAGE);
}

/** One short-lived process: the SDK, the session's HOME and config root, one reply. */
export async function readManagedClaudeSettings(env: NodeJS.ProcessEnv, options: ReadOptions = {}): Promise<unknown> {
  const worker = options.worker ?? desktopWorkerPath('claude-managed-settings');
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  if (!existsSync(worker)) throw new Error(`the reading process is not built: ${worker}`);
  const entry = await (options.sdkEntry ?? appSdkEntry)();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: env.HOME ?? process.env.HOME };
  if (env.CLAUDE_CONFIG_DIR?.trim()) childEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  else delete childEnv.CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { env: childEnv, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let reply: unknown;
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`no answer within ${timeoutMs} ms`));
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('message', (message) => { reply = message; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && reply !== undefined) resolve(reply);
      else reject(new Error(`exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.send({ sdkEntry: entry }, (error) => { if (error) child.kill('SIGKILL'); });
  });
}

export function managedClaudeModelPolicy(env: NodeJS.ProcessEnv, read: ManagedRead = (sessionEnv) => readManagedClaudeSettings(sessionEnv)): Promise<ClaudeModelPolicy> {
  const holder = globalThis as { [CACHE]?: Map<string, Promise<ClaudeModelPolicy>> };
  const cache = holder[CACHE] ??= new Map();
  const root = claudeConfigRoot(env);
  const cached = cache.get(root);
  if (cached) return cached;
  const started = Date.now();
  const policy = read(env).then((reply) => {
    const value = managedPolicyOf(reply);
    log.info('[auto-review] read the managed Claude model policy', {
      ms: Date.now() - started, available: value.available?.length ?? null, denied: value.denied.length, exact: value.exact,
    });
    return value;
  }, (error: unknown) => {
    log.warn('[auto-review] the managed Claude settings could not be read; deciding as if there were none', {
      ms: Date.now() - started, error: error instanceof Error ? error.message : String(error),
    });
    return NO_CLAUDE_MODEL_POLICY;
  });
  cache.set(root, policy);
  return policy;
}
