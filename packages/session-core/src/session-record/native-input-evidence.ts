import { deliverySourceIds, matchesDeliveryIdentity, type NativeInputEvidence } from '@gugu/core/local/agent/deliveryIdentity';
import { basename } from 'node:path';
import { readClaudeRecord } from '@gugu/core/local/agent/transcriptSources/claudeCode';
import { readCodexRecord } from '@gugu/core/local/agent/transcriptSources/codex';
import type { SessionRecordLocator } from './contract';
import { resolveSessionFile } from './sources/claude-jsonl';
import { resolveRolloutFile } from './sources/codex-jsonl';
import { readBytePage } from './window-cache/byte-page';
import { openWindowByteSource } from './window-cache/file-source';
import { createWindowBudget, WindowBudgetExceeded } from './window-cache/read-budget';
import type { WindowBudget, WindowByteSource } from './window-cache/types';

type Input = { id: string; text: string };
type NativeMessage = { id: string; text: string; clientMessageId?: string | null };
export type NativeInputTail = { find(input: Input): NativeInputEvidence };
const incomplete = (reason: string, detail?: string): NativeInputTail => ({ find: () => ({ state: 'incomplete', reason, ...(detail ? { detail } : {}) }) });

/** One pinned 64 KiB suffix, shared by every pending input in this reconciliation. No timeline is acquired. */
export async function readNativeInputTail(locator: SessionRecordLocator, options: {
  budget?: WindowBudget; signal?: AbortSignal; path?: string;
} = {}): Promise<NativeInputTail> {
  if (locator.harness !== 'claude' && locator.harness !== 'codex') return incomplete('native_format_not_supported');
  let source: Awaited<ReturnType<typeof openWindowByteSource>> | undefined;
  try {
    const path = options.path ?? await (locator.harness === 'claude' ? resolveSessionFile(locator) : resolveRolloutFile(locator, false));
    const name = basename(path);
    if (locator.harness === 'claude' ? name !== `${locator.providerSessionId}.jsonl`
      : !name.startsWith('rollout-') || !name.endsWith(`-${locator.providerSessionId}.jsonl`)) return incomplete('native_session_changed');
    source = await openWindowByteSource(path);
    return await inspectNativeInputTail(source, locator, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return incomplete(error instanceof WindowBudgetExceeded ? 'native_read_budget_exhausted' : 'native_source_unreadable', String(error));
  } finally { await source?.close(); }
}

/** The production byte-source boundary is injectable so tests can meter real offsets without giant fixtures. */
export async function inspectNativeInputTail(source: WindowByteSource, locator: Pick<SessionRecordLocator, 'harness' | 'providerSessionId'>,
  options: { budget?: WindowBudget; signal?: AbortSignal } = {}): Promise<NativeInputTail> {
  if (locator.harness !== 'claude' && locator.harness !== 'codex') return incomplete('native_format_not_supported');
  const budget = options.budget ?? createWindowBudget();
  const page = await readBytePage(source, { budget, signal: options.signal });
  if (page.kind === 'reset') return incomplete('native_source_changed');
  // The first LF is the only proven record boundary when the suffix starts inside a record/UTF-8 character.
  const first = page.start === 0 ? 0 : page.bytes.indexOf(10) + 1;
  if (page.start > 0 && first === 0) return incomplete('native_record_boundary_missing');
  const lastLf = page.bytes.lastIndexOf(10);
  const messages: NativeMessage[] = [];
  let identityProven = false;
  let reason = page.start > 0 ? 'native_tail_does_not_cover_history' : null;
  if (page.bytes.length && lastLf !== page.bytes.length - 1) reason = 'native_record_incomplete';
  let boundary = lastLf;
  while (boundary >= first) {
    options.signal?.throwIfAborted();
    const offset = boundary === 0 ? 0 : page.bytes.lastIndexOf(10, boundary - 1) + 1;
    if (offset < first) break;
    const line = page.bytes.subarray(offset, boundary);
    const position = page.start + offset;
    boundary = offset - 1;
    if (line.length === 0) continue;
    try {
      budget.charge('examinedRecords', 1);
      budget.charge('decodedBytes', line.length);
    } catch (error) {
      if (!(error instanceof WindowBudgetExceeded)) throw error;
      reason = 'native_read_budget_exhausted'; break;
    }
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reason = 'native_record_invalid'; continue; }
      raw = parsed as Record<string, unknown>;
    } catch { reason = 'native_record_invalid'; continue; }
    if (locator.harness === 'claude') {
      const record = readClaudeRecord(raw);
      if (record.providerSessionId && record.providerSessionId !== locator.providerSessionId) return incomplete('native_session_changed');
      if (record.providerSessionId === locator.providerSessionId) identityProven = true;
      if (record.sidechain) continue;
      const text = record.items.flatMap(item => item.kind === 'text' && item.role === 'user' ? [item.text] : []).join('\n');
      if (text && record.messageId) messages.push({ id: record.messageId, text });
    } else {
      const record = readCodexRecord(raw);
      if (record.meta?.providerSessionId && record.meta.providerSessionId !== locator.providerSessionId) return incomplete('native_session_changed');
      if (record.meta?.providerSessionId === locator.providerSessionId) identityProven = true;
      if (record.meta?.sidechain) return incomplete('native_session_changed');
      const item = record.item;
      if (item?.kind === 'text' && item.role === 'user') {
        const payload = raw.payload as Record<string, unknown> | undefined;
        messages.push({ id: typeof payload?.id === 'string' ? payload.id : `codex:${locator.providerSessionId}:byte:${position}`, text: item.text });
      }
    }
  }
  // Decode time is part of the read: append/replacement during decoding invalidates even a matching input.
  const final = await source.snapshot();
  if (final.sourceId !== page.snapshot.sourceId || final.sourceInstance !== page.snapshot.sourceInstance
    || final.snapshotRevision !== page.snapshot.snapshotRevision || final.size !== page.snapshot.size) return incomplete('native_source_changed');
  return { find(input) {
    const match = messages.find(message => matchesDeliveryIdentity(input, message));
    return match ? { state: 'received', nativeReceiptId: match.id }
      : reason ? { state: 'incomplete', reason }
      : !identityProven ? { state: 'incomplete', reason: 'native_session_identity_unavailable' }
      : !deliverySourceIds(input.text).length ? { state: 'incomplete', reason: 'native_input_identity_unavailable' }
      : { state: 'absent', reason: 'native_input_absent' };
  } };
}
