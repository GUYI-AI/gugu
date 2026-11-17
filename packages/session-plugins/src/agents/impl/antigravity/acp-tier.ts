import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnOwnedChild } from '@gugu/session-core/exec';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { ANTIGRAVITY_PROBE_LAUNCH_SCRIPT } from './session-bundle';

const TIMEOUT_MS = 15_000;
class SignedOutError extends Error {}
export type AgyAcpTier = { kind: 'tier'; name: string } | { kind: 'not-signed-in' } | null;

/** Official ACP extension (Antigravity 1.4+). Keep only the vendor's display name, never account or token metadata. */
export function tierNameFromAcpResponse(response: unknown): string | null {
  const name = (response as { _meta?: { antigravity?: { tier?: { name?: unknown } } } } | null)?._meta?.antigravity?.tier?.name;
  return typeof name === 'string' && name.trim() && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)
    ? name.trim() : null;
}

/**
 * Ask the signed-in CLI, not another IDE's last account. `session/new._meta.antigravity.tier` is documented in
 * https://antigravity.google/docs/changelog (ACP 1.4.0). No authenticate or prompt is ever sent. The caller first
 * checks `agy models`; the MCP-free probe launcher uses the same managed login and prevents starting global tools.
 * Older CLIs without `acp`/tier metadata keep the existing unavailable-tier fallback.
 */
export async function readAgyAcpTier(ctx: AgentAuthContext): Promise<AgyAcpTier> {
  if (!ctx.env.GEMINI_HOME?.trim() || process.platform === 'win32') return null;
  const cwd = await mkdtemp(join(tmpdir(), 'gugu-agy-tier-'));
  const owned = spawnOwnedChild('/bin/sh', ['-c', ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, ctx.cli, 'acp', '--stdio'], {
    cwd,
    env: { ...ctx.env, BROWSER: 'true', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
    onError: () => {},
  });
  const child = owned.child;
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  lines.on('line', line => {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { code?: unknown } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Tier probe does not run tools' } });
      return;
    }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (message.error) waiter.reject(message.error.code === -32000
      ? new SignedOutError('Antigravity requires sign-in')
      : new Error('Antigravity did not report a subscription tier'));
    else waiter.resolve(message.result);
  });
  let nextId = 0;
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Antigravity tier probe exited')));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Antigravity tier probe timed out')), TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'gugu', version: '0' } });
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        const advertised = (initialized as { agentCapabilities?: { _meta?: { antigravity?: { tier?: unknown } } } } | null)
          ?.agentCapabilities?._meta?.antigravity?.tier;
        if (advertised !== true) return null;
        const name = tierNameFromAcpResponse(await request('session/new', { cwd, mcpServers: [] }));
        return name ? { kind: 'tier' as const, name } : null;
      })(),
      exited,
      timeout,
    ]);
  } catch (error) {
    return error instanceof SignedOutError ? { kind: 'not-signed-in' } : null;
  } finally {
    clearTimeout(timer);
    lines.close();
    exited.catch(() => {});
    await owned.stop({ graceMs: 500 }).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
