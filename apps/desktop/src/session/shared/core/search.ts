import { sliceWholeCharacters } from '@gugu/core/shared/unicodeSlice';
import type { ActivityPreviewSource } from '@gugu/session-chat-ui/activity-preview';

export type SearchItemKind = 'session';

export interface SearchItem {
  kind: SearchItemKind;
  id: string;
  title: string;
  subtitle: string;
  score: number;
  lastInteractedAt?: string | null;
}

/** A message said in a local task, as task search finds it (turn_text). */
export interface TaskTurnHit {
  sessionId: string;
  title: string;
  archived: boolean;
  itemId: string;
  role: 'user' | 'assistant';
  excerpt: string;
  activity?: ActivityPreviewSource | null;
  at: string;
}

/** The visible part of a matched text around the query's first piece, for a result row. */
export function excerpt(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = query.trim().split(/\s+/)[0] ?? '';
  const at = matchRanges(flat, first)[0]?.start ?? 0;
  const start = Math.max(0, at - 30);
  const end = Math.min(flat.length, start + 120);
  return `${start > 0 ? '…' : ''}${sliceWholeCharacters(flat, start, end)}${end < flat.length ? '…' : ''}`;
}

export interface CommandPaletteQuery {
  query: string;
}

/** Task content search: the query and how many of the newest hits to return (the search panel counts them). */
export interface TaskTurnQuery {
  query: string;
  limit?: number;
}

export type SearchBackfillProgress = { state: 'running' | 'complete' | 'failed'; done: number; total: number };
export type TaskTurnIndexStatus = { state: 'preparing' | 'ready' | 'failed'; done?: number; total?: number };

/** Where each whitespace-separated piece of the query occurs in text (case-insensitive), merged, for highlighting. */
export function matchRanges(text: string, query: string): { start: number; end: number }[] {
  const lower = text.toLowerCase();
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const folded = char.toLowerCase();
    for (let index = 0; index < folded.length; index += 1) { starts.push(offset); ends.push(offset + char.length); }
    offset += char.length;
  }
  const ranges: { start: number; end: number }[] = [];
  for (const piece of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    for (let at = lower.indexOf(piece); at !== -1; at = lower.indexOf(piece, at + piece.length)) ranges.push({ start: starts[at], end: ends[at + piece.length - 1] });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export interface WorkspaceFileSearchQuery {
  workspaceId: string;
  query: string;
  limit?: number;
}

export interface WorkspaceFileHit {
  path: string;
  filename: string;
}
