/** An explicit size-limit result from the reader is permanent for this preview attempt. */
export class PreviewReadLimitError extends Error {
  constructor(readonly totalSize: number) { super(`File too large: ${totalSize} bytes`) }
}
