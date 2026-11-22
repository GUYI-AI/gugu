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
/** Byte cursors pin a read revision; semantic IDs must never use that revision. */
export type BytePageCursor = { sourceId: string; sourceInstance: string; snapshotRevision: string; before: number };
export type BytePageResult =
  | { kind: 'reset'; reason: 'source_changed' }
  | { kind: 'page'; snapshot: SourceSnapshot; start: number; end: number; bytes: Uint8Array; older: BytePageCursor | null };
