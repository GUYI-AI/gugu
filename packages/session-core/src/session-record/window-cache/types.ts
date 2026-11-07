import type { TranscriptTurn } from '../../acp/models/turns/turn';
import type { SessionRecordLocator } from '../contract';

/** Physical identity, append-stable logical lineage and read revision are separate. */
export type SourceSnapshot = {
  sourceId: string;
  sourceInstance: string;
  snapshotRevision: string;
  size: number;
};

export interface WindowByteSource {
  snapshot(): Promise<SourceSnapshot>;
  read(target: Uint8Array, offset: number, length: number, position: number): Promise<number>;
}

export type WindowIoCounters = {
  sourceBytes: number;
  indexBytes: number;
  decodedBytes: number;
  outputBytes: number;
  examinedRecords: number;
};
export type WindowLimits = WindowIoCounters;
export type IoKind = 'sourceBytes' | 'indexBytes';
export interface WindowBudget {
  readonly counters: Readonly<WindowIoCounters>;
  read(kind: IoKind, requested: number, operation: () => Promise<number>): Promise<number>;
  charge(kind: Exclude<keyof WindowIoCounters, IoKind>, amount: number): void;
}

export type SourceRange = { start: number; end: number };
export type SegmentRef = { id: string; offset: number; length: number; digest: string };
export type TailSegment = {
  version: 1;
  scope: string;
  sourceLineage: string;
  commitSeq: number;
  previous: SegmentRef | null;
  sourceRange: SourceRange;
  projection: SegmentRef;
  decoderCheckpoint: SegmentRef;
  dedupCommit: number;
  complete: true;
};
export type TailHead = {
  format: 'gugu.desktop-tail/1';
  scope: string;
  sourceLineage: string;
  commitSeq: number;
  tail: SegmentRef | null;
  sourceEnd: number;
  sourceFence: SourceRange & { digest: string };
  decoderVersion: number;
};

/** Byte cursors pin a read revision; semantic IDs must never use that revision. */
export type BytePageCursor = { sourceId: string; sourceInstance: string; snapshotRevision: string; before: number };
export type BytePageResult =
  | { kind: 'reset'; reason: 'source_changed' }
  | { kind: 'page'; snapshot: SourceSnapshot; start: number; end: number; bytes: Uint8Array; older: BytePageCursor | null };

/** A body points to independently decoded UTF-8 chunks or a bounded tokenizer checkpoint. */
export type WindowBodyOwner = { kind: 'canonical'; turnId: string; itemId: string }
  | { kind: 'fragment'; fragmentKey: string };
export type WindowBodyRef = {
  version: 1; scope: string; sourceLineage: string; id: string; revision: string;
  firstChunk: SegmentRef | null; decoderCheckpoint: SegmentRef | null;
  sourceRange: SourceRange; byteLength: number | null;
} & ({ owner: Extract<WindowBodyOwner, { kind: 'canonical' }>; turnId: string; itemId: string }
  | { owner: Extract<WindowBodyOwner, { kind: 'fragment' }>; turnId?: never; itemId?: never });
/** Readable source evidence with a real anchor, without invented canonical ownership or side effects. */
export type SourceFragment = {
  key: string; sourceRange: SourceRange; nativeKey?: string; knownRole?: 'user' | 'assistant' | 'tool';
  text?: string; bodyRef?: WindowBodyRef; ownership: 'unresolved';
};
export const BODY_CHUNK_BYTES = 16 * 1024;
export const BODY_TEXT_BYTES = 32 * 1024;
export type BodyChunkDescriptor = {
  bodyId: string; revision: string; ordinal: number; decodedStart: number; decodedBytes: number;
  content: SegmentRef | null; checkpointRef: SegmentRef | null; sourceRange: SourceRange;
};
export type WindowSourceLocator = {
  version: 1; harness: 'claude' | 'codex'; providerSessionId: string; path: string;
  source: SourceSnapshot; sourceLineage: string;
};
export type WindowCacheContext = {
  cacheDirectory: string; scope: string; conversationScope: string; branchLineage: string; decoderVersion: number;
};
export type WindowCursor = {
  version: 1; scope: string; sourceLineage: string; snapshotRevision: string;
  before: number; segment: SegmentRef | null;
};
/** Unknown record identity/role is deliberately absent from a locating ticket. */
export type PendingLongRecord = {
  kind: 'pending_long_record'; ticket: string; sourceInstance: string;
  pinnedEnd: number; nextScanOffset: number;
  sourceFence: SourceRange & { digest: string };
  checkpointRef?: SegmentRef;
};
export type ReverseCheckpoint = {
  version: 1; jobId: string; sourceId: string; sourceInstance: string; sourceLineage: string;
  snapshotRevision: string; pinnedEnd: number; recordEnd: number; scanBefore: number;
  sourceFence: SourceRange & { digest: string };
};
/** Metadata/content here is only a metered bounded envelope; giant bodies stay in bodyRef. */
export type WindowRecordEnvelope = {
  provider: 'claude' | 'codex'; recordStart: number | null; sourceRange: SourceRange;
  fragment: number; eventKind: string; revision: string; projectionRef: string;
  recordMetadata: Record<string, unknown>; bodyRef?: WindowBodyRef;
};
export type WindowReadRequest = {
  locator: SessionRecordLocator; conversationId: string; cacheDirectory: string;
  scope: string; conversationScope: string; branchLineage: string;
  limit?: number; signal?: AbortSignal; budget: WindowBudget;
};
export type WindowPage = {
  kind: 'page' | 'continuation'; scope: string; sourceLineage: string;
  snapshotRevision: string; commitSeq: number; turns: TranscriptTurn[];
  bodyRefs: WindowBodyRef[]; coveredRanges: SourceRange[]; sourceFragments?: SourceFragment[];
  olderCursor: WindowCursor | null; moreBefore: 'yes' | 'no' | 'unknown';
  pendingLongRecords: PendingLongRecord[]; io: WindowIoCounters;
};
export type WindowResult = WindowPage
  | { kind: 'reset'; reason: 'source_changed' | 'invalid_cursor'; io: WindowIoCounters }
  | { kind: 'cache_miss'; reason: 'format' | 'checksum' | 'key' | 'not_found'; cursor: WindowCursor | null; io: WindowIoCounters };
export type WindowBodyResult = { bodyId: string; revision: string } & ({
  kind: 'body'; text: string; offset: number; nextOffset: number;
  /** A verified UTF-8 boundary from point-addressed descriptors; null only at body start. */
  previousOffset: number | null;
  moreAfter: 'yes' | 'no' | 'unknown'; io: WindowIoCounters;
} | { kind: 'needs_location'; offset: number; io: WindowIoCounters }
  | { kind: 'reset'; reason: 'source_changed' | 'invalid_cursor'; io: WindowIoCounters });
export type TimelineWindowFields = {
  /** Snapshot replaces; After supplies the current full ticket set ([] clears). Older is page-local. */
  bodyRefs?: WindowBodyRef[]; pendingLongRecords?: PendingLongRecord[];
  /** Bounded global resolutions in After; clients retain tombstones only for resident/in-flight pages. */
  resolvedPendingTickets?: string[];
  sourceFragments?: SourceFragment[];
  resolvedFragmentOwners?: Array<{ fragmentKey: string; turnId: string; itemId: string }>;
  olderCursor?: WindowCursor | null; moreBefore?: 'yes' | 'no' | 'unknown'; coveredRanges?: SourceRange[];
  snapshotRevision?: string; sourceLineage?: string;
};
