/**
 * @@@strip-on-track — the chat workspace's strip is drawn above its pages, which move on the root cut's track. The strip's
 * columns ride the same edge in every frame of that move (❌ land at once while the pages beneath are still moving): the cut
 * reports its first edge here, the strip places itself on it. The last edge is kept for a strip that mounts mid-move.
 */
export interface CutEdge {
  /** Where the first child's far edge is drawn now (px from the cut's start). */
  drawn: number;
  /** Where its move started and where it goes; both the same at rest. */
  from: number;
  to: number;
  /** The cut's whole length (px). */
  extent: number;
}

export class CutEdgeRelay {
  private last: CutEdge | null = null;
  private sink: ((edge: CutEdge) => void) | null = null;

  write(edge: CutEdge): void {
    this.last = edge;
    this.sink?.(edge);
  }

  attach(sink: (edge: CutEdge) => void): () => void {
    this.sink = sink;
    if (this.last) sink(this.last);
    return () => {
      if (this.sink === sink) this.sink = null;
    };
  }
}
