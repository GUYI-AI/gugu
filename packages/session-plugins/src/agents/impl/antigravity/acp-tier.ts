import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from '@gugu/core/local/childProcess';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOwnedChild } from '@gugu/session-core/exec';
import { AcpProbeRpcClient } from '@gugu/session-core/acp/node';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';

const TIMEOUT_MS = 15_000;
const CACHE_FILE = '.gugu-cli-tier.json';
const requests = new Map<string, Promise<AgyAcpTier>>();
class SignedOutError extends Error {}
export type AgyAcpTier = { kind: 'tier'; name: string; asOf?: number } | { kind: 'not-signed-in' } | null;
type TierContext = Pick<AgentAuthContext, 'cli' | 'env' | 'exec'>;

/** Keep only the vendor's display name, never account or token metadata. */
export function tierNameFromAcpResponse(response: unknown): string | null {
  const name = (response as { _meta?: { antigravity?: { tier?: { name?: unknown } } } } | null)?._meta?.antigravity?.tier?.name;
  return typeof name === 'string' && name.trim() && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)
    ? name.trim() : null;
}

/** The account generation includes file-backed credentials and macOS keychain metadata, never its password. */
async function accountFingerprint(ctx: TierContext): Promise<string | null> {
  // Secret Service can switch accounts without touching the managed settings or token file.
  // Without a reliable identity, even a cached response from an open session may belong to a previous account.
  if (process.platform === 'linux') return null;
  const root = ctx.env.GEMINI_HOME!;
  const hash = createHash('sha256').update(root).update(await realpath(ctx.cli).catch(() => ctx.cli));
  for (const relative of ['antigravity-cli/settings.json', 'antigravity-cli/antigravity-oauth-token']) {
    const info = await stat(join(root, relative)).catch(() => null);
    hash.update(relative).update(info ? `${info.ino}:${info.size}:${info.mtimeMs}` : 'absent');
  }
  if (process.platform === 'darwin') {
    const metadata = await ctx.exec('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'], { timeout: 5_000 })
      .then(result => result.stdout, () => 'absent');
    hash.update(metadata);
  }
  return hash.digest('hex');
}

async function cached(ctx: TierContext, fingerprint: string): Promise<AgyAcpTier> {
  try {
    const value = JSON.parse(await readFile(join(ctx.env.GEMINI_HOME!, CACHE_FILE), 'utf8'));
    const name = tierNameFromAcpResponse({ _meta: { antigravity: { tier: { name: value.name } } } });
    return value.fingerprint === fingerprint && name && Number.isFinite(value.asOf)
      ? { kind: 'tier', name, asOf: value.asOf } : null;
  } catch { return null; }
}

/** Local credential metadata and an account-scoped cache only; no CLI/network query on a warm plan read. */
export async function readCachedAgyTier(ctx: AgentAuthContext): Promise<AgyAcpTier> {
  if (!ctx.env.GEMINI_HOME?.trim()) return null;
  const fingerprint = await accountFingerprint(ctx);
  return fingerprint ? cached(ctx, fingerprint) : null;
}

async function save(ctx: TierContext, fingerprint: string, name: string): Promise<void> {
  const target = join(ctx.env.GEMINI_HOME!, CACHE_FILE);
  const staging = `${target}.${randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify({ fingerprint, name, asOf: Date.now() }), { mode: 0o600 });
  await rename(staging, target);
}

/** Each real conversation open refreshes its account's tier without starting another process. */
export async function observeAgyTier(
  ctx: Pick<AgentAuthContext, 'cli' | 'env'>,
  response: unknown,
  execute: AgentAuthContext['exec'] = async (command, args, options) => promisify(execFile)(command, args ?? [], { ...options, encoding: 'utf8' }),
): Promise<void> {
  const name = tierNameFromAcpResponse(response);
  if (!name || !ctx.env.GEMINI_HOME?.trim()) return;
  const context = { ...ctx, exec: execute };
  const fingerprint = await accountFingerprint(context);
  if (fingerprint) await save(context, fingerprint, name);
}

/** A probe owns its conversation and cache directories. On POSIX, link the file credential to preserve refresh. */
export async function createAgyProbeRoot(managed: string, scratch: string): Promise<string> {
  const root = join(scratch, '.gemini');
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'antigravity-cli', 'conversations'), { recursive: true });
  for (const entry of await readdir(managed, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.gugu-')) await copyFile(join(managed, entry.name), join(root, entry.name));
  }
  const cli = join(managed, 'antigravity-cli');
  for (const entry of await readdir(cli, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const source = join(cli, entry.name); const target = join(root, 'antigravity-cli', entry.name);
    if (entry.name === 'antigravity-oauth-token' && process.platform !== 'win32') await symlink(source, target);
    else await copyFile(source, target);
  }
  await writeFile(join(root, 'config', 'mcp_config.json'), '{"mcpServers":{}}\n', { mode: 0o600 });
  return root;
}

/** Reuse or coalesce reads only while their credential identity is detectable. */
export async function readAgyAcpTier(ctx: AgentAuthContext): Promise<AgyAcpTier> {
  if (!ctx.env.GEMINI_HOME?.trim()) return null;
  const fingerprint = await accountFingerprint(ctx);
  if (!fingerprint) return queryTier(ctx);
  const existing = await cached(ctx, fingerprint);
  if (existing) return existing;
  const pending = requests.get(fingerprint);
  if (pending) return pending;
  const request = queryTier(ctx).then(async tier => {
    if (fingerprint !== await accountFingerprint(ctx)) return null;
    if (tier?.kind === 'tier') {
      await save(ctx, fingerprint, tier.name);
    }
    return tier;
  }).finally(() => requests.delete(fingerprint));
  requests.set(fingerprint, request);
  return request;
}

async function queryTier(ctx: AgentAuthContext): Promise<AgyAcpTier> {
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-agy-tier-'));
  let owned: ReturnType<typeof spawnOwnedChild> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const root = await createAgyProbeRoot(ctx.env.GEMINI_HOME!, scratch);
    owned = spawnOwnedChild(ctx.cli, ['acp', '--stdio', '--gemini-dir', root], {
      cwd: scratch, env: { ...ctx.env, GEMINI_HOME: root, BROWSER: 'true', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'], onError: () => {},
    });
    const rpc = new AcpProbeRpcClient(owned.child as ChildProcessWithoutNullStreams, payload =>
      (payload as { code?: unknown })?.code === -32000 ? new SignedOutError('Antigravity requires sign-in') : new Error('Antigravity tier unavailable'));
    return await Promise.race([
      (async () => {
        const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'gugu', version: '0' } });
        rpc.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        const advertised = (initialized as { agentCapabilities?: { _meta?: { antigravity?: { tier?: unknown } } } } | null)
          ?.agentCapabilities?._meta?.antigravity?.tier;
        if (advertised !== true) return null;
        const name = tierNameFromAcpResponse(await rpc.request('session/new', { cwd: scratch, mcpServers: [] }));
        return name ? { kind: 'tier' as const, name } : null;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Antigravity tier probe timed out')), TIMEOUT_MS); }),
    ]);
  } catch (error) {
    return error instanceof SignedOutError ? { kind: 'not-signed-in' } : null;
  } finally {
    clearTimeout(timer);
    try { await owned?.stop({ graceMs: 500 }); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
