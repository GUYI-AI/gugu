/** A nonempty turn list is neither necessary nor sufficient for bounded first paint. */
export function boundedWindowReady(value: object): boolean {
  return 'sourceLineage' in value && typeof value.sourceLineage === 'string' && value.sourceLineage.length > 0
    && 'snapshotRevision' in value && typeof value.snapshotRevision === 'string' && value.snapshotRevision.length > 0
}
