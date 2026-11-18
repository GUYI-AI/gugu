/**
 * #3005 Claude Code's idle compaction, for the sessions Gugu drives through ACP (stream-json), which its own
 * implementation does not cover. The eligibility rules are Claude Code's (settings reference, `idleCompaction`):
 *
 * - off when `idleCompaction: false`, `autoCompactEnabled: false`, or `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`;
 * - threshold `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (default 200k, floor 100k);
 * - only on the one-hour prompt cache: read from the session's own transcript (the last cache write's TTL),
 *   because the ACP usage update carries no TTL. Unknown TTL ⇒ no compaction.
 *
 * Settings are read user < project < local, as Claude Code layers them; managed settings and `--settings`
 * documents are not read here (a wrapper that sets `CLAUDE_CONFIG_DIR` inside its own process is invisible too).
 */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAUDE_CACHE_IDLE_COMPACT_MIN_TOKENS_FLOOR,
  CLAUDE_CACHE_IDLE_COMPACT_TOKENS,
} from './idle-compaction';

export type ClaudeIdleCompactionConfig =
  | { enabled: true; minTokens: number }
  | { enabled: false; reason: string };

interface ClaudeSettingsSlice {
  idleCompaction?: unknown;
  autoCompactEnabled?: unknown;
  env?: unknown;
}

async function readSettings(path: string): Promise<ClaudeSettingsSlice | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ClaudeSettingsSlice : null;
  } catch {
    return null;
  }
}

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

export async function resolveClaudeIdleCompaction(opts: {
  env: Record<string, string>;
  cwd: string;
  homeDir: string;
}): Promise<ClaudeIdleCompactionConfig> {
  const configDir = opts.env.CLAUDE_CONFIG_DIR?.trim() || join(opts.homeDir, '.claude');
  const layers = (await Promise.all([
    readSettings(join(configDir, 'settings.json')),
    readSettings(join(opts.cwd, '.claude', 'settings.json')),
    readSettings(join(opts.cwd, '.claude', 'settings.local.json')),
  ])).filter((layer): layer is ClaudeSettingsSlice => layer !== null);

  let idleCompaction: unknown;
  let autoCompactEnabled: unknown;
  // A settings `env` block beats the exported environment inside Claude Code.
  const env: Record<string, string> = { ...opts.env };
  for (const layer of layers) {
    if (layer.idleCompaction !== undefined) idleCompaction = layer.idleCompaction;
    if (layer.autoCompactEnabled !== undefined) autoCompactEnabled = layer.autoCompactEnabled;
    if (layer.env && typeof layer.env === 'object') {
      for (const [key, value] of Object.entries(layer.env as Record<string, unknown>)) {
        if (typeof value === 'string') env[key] = value;
      }
    }
  }
  if (idleCompaction === false) return { enabled: false, reason: 'idleCompaction=false' };
  if (autoCompactEnabled === false) return { enabled: false, reason: 'autoCompactEnabled=false' };
  if (truthyEnv(env.DISABLE_AUTO_COMPACT)) return { enabled: false, reason: 'DISABLE_AUTO_COMPACT' };
  if (truthyEnv(env.DISABLE_COMPACT)) return { enabled: false, reason: 'DISABLE_COMPACT' };

  const raw = env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const minTokens = Number.isSafeInteger(parsed) && parsed > 0
    ? Math.max(CLAUDE_CACHE_IDLE_COMPACT_MIN_TOKENS_FLOOR, parsed)
    : CLAUDE_CACHE_IDLE_COMPACT_TOKENS;
  return { enabled: true, minTokens };
}

/** Read backwards in chunks: a long run of pure cache reads can push the last cache write far up the file. */
const TRANSCRIPT_CHUNK_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_SCAN_LIMIT_BYTES = 64 * 1024 * 1024;

export interface PromptCacheReading {
  /** TTL of the most recent cache write. */
  ttl: '1h' | '5m';
  /** Epoch ms of the most recent real model request that touched the cache (read or write); null if unstamped. */
  lastRequestAt: number | null;
}

type CacheLine = { ttl: '1h' | '5m' | null; at: number | null };

/** A main-chain request by a real model that used the cache; `<synthetic>` entries (limit / error notes) never ran one. */
function cacheLine(line: string): CacheLine | null {
  if (!line.includes('"cache_creation"')) return null;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  const record = entry as { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { model?: unknown; usage?: {
    cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
    cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
  } } };
  if (record.type !== 'assistant' || record.isSidechain === true || record.message?.model === '<synthetic>') return null;
  const usage = record.message?.usage;
  if (!usage) return null;
  const count = (value: unknown) => typeof value === 'number' && value > 0 ? value : 0;
  const oneHour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  const fiveMinutes = count(usage.cache_creation?.ephemeral_5m_input_tokens);
  if (!oneHour && !fiveMinutes && !count(usage.cache_read_input_tokens) && !count(usage.cache_creation_input_tokens)) return null;
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return { ttl: oneHour ? '1h' : fiveMinutes ? '5m' : null, at: Number.isFinite(at) ? at : null };
}

/**
 * The session's prompt cache as Claude Code's own transcript records it: the TTL of the most recent cache write
 * (`message.usage.cache_creation.ephemeral_{1h,5m}_input_tokens`) and when a real request last touched the cache.
 * A pure cache read says nothing about the TTL, so earlier entries are consulted until one wrote. null = could not tell.
 */
export async function readPromptCache(transcriptPath: string): Promise<PromptCacheReading | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(transcriptPath, 'r'); } catch { return null; }
  try {
    const { size } = await file.stat();
    let end = size;
    // Bytes of a line cut by the previous (later) chunk boundary, prepended to the next earlier chunk's tail.
    let carry = Buffer.alloc(0);
    let lastRequestAt: number | null | undefined;
    while (end > 0 && size - end < TRANSCRIPT_SCAN_LIMIT_BYTES) {
      const start = Math.max(0, end - TRANSCRIPT_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      await file.read(chunk, 0, chunk.length, start);
      const joined = Buffer.concat([chunk, carry]);
      const firstNewline = start === 0 ? -1 : joined.indexOf(0x0a);
      const whole = firstNewline === -1 && start > 0 ? Buffer.alloc(0) : joined.subarray(firstNewline + 1);
      carry = firstNewline === -1 && start > 0 ? joined : joined.subarray(0, firstNewline + 1);
      const lines = whole.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const found = cacheLine(lines[i]!);
        if (!found) continue;
        if (lastRequestAt === undefined) lastRequestAt = found.at;
        if (found.ttl) return { ttl: found.ttl, lastRequestAt };
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
