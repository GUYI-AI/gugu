import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordEntry, RecordImageRef, SessionRecordResume, SessionRecordSource, SessionRecordSourceEvents } from '../contract';
import type { SessionRecordSourceOptions } from './shared';

/** Follow native child records through the same lifecycle and stream projection as Codex. */
export function withSubagentSources(
  root: SessionRecordSource,
  createChild: (id: string) => SessionRecordSource,
  recreate: () => SessionRecordSource,
  options?: SessionRecordSourceOptions,
): SessionRecordSource {
  const children = new Map<string, SessionRecordSource>();
  const starting = new Map<string, Promise<void>>();
  const childIds = new Set<string>();
  let stopped = false;
  let initializing = true;
  let sink: SessionRecordSourceEvents | null = null;
  let replacement: SessionRecordSource | null = null;
  let childResumes: Record<string, SessionRecordResume> = {};
  /**
   * Children's initial reads run concurrently, but what they read reaches the timeline in a fixed order: each child's
   * whole initial read, in the order the children first appear in the root record (`childIds`). Later lines (tailing)
   * go on as they arrive. `held` keeps a child's entries until its turn.
   */
  let held: Map<string, RecordEntry[]> | null = null;

  const stopChildren = () => {
    for (const source of children.values()) source.stop();
    children.clear();
  };
  const restart = async (reason: 'source_replaced' | 'source_unreadable') => {
    if (stopped || replacement || !sink) return;
    root.stop();
    stopChildren();
    sink.onReset(reason);
    replacement = recreate();
    await replacement.start(sink);
  };
  const ensureChild = (id: string): Promise<void> => {
    if (stopped || children.has(id)) return Promise.resolve();
    const pending = starting.get(id);
    if (pending) return pending;
    const source = createChild(id);
    children.set(id, source);
    const read = source.start({
      onEntries(entries) {
        const mapped: RecordEntry[] = entries.flatMap((entry): RecordEntry | [] => {
          if (entry.boundary) return { key: entry.key, at: entry.at, event: childState(id,
            entry.boundary.kind === 'turn_failed' ? 'failed' : entry.boundary.kind === 'turn_aborted' ? 'stopped' : 'completed') };
          const event = entry.event;
          // A nested launch belongs to this child's stream; nested lifecycle facts already name their own child.
          // A child's positions are in its own file, never a place in the root record.
          if (event.kind === 'subagent_update' || event.kind === 'subagent_stream') return { ...entry, position: undefined };
          // A nested child's finish noted in this child's record has no place in the root record; the nested child's
          // own record settles its card.
          if (event.kind === 'subagent_done') return [];
          if (event.kind === 'message' && event.role === 'user') return { key: entry.key, at: entry.at, event: childState(id, 'in_progress') };
          return { ...entry, position: undefined, event: { kind: 'subagent_stream', subagentSessionId: id, event } };
        });
        if (stopped || children.get(id) !== source) return;
        const waiting = held?.get(id);
        if (waiting) waiting.push(...mapped);
        else sink?.onEntries(mapped);
      },
      onReset: (reason) => { void restart(reason).catch((error: unknown) => options?.warn?.('Native child record restart failed', { error: String(error) })); },
    }, childResumes[id]).catch((error: unknown) => {
      if (children.get(id) === source) children.delete(id);
      options?.warn?.('Native child record read failed', { childId: id, error: String(error) });
      throw error;
    }).finally(() => starting.delete(id));
    starting.set(id, read);
    return read;
  };
  return {
    locator: root.locator,
    async start(events, resume) {
      sink = events;
      const saved = resume?.data as { nativeChildren?: number; root?: SessionRecordResume; children?: Record<string, SessionRecordResume>; known?: string[] } | undefined;
      childResumes = saved?.nativeChildren === 2 ? saved.children ?? {} : {};
      for (const id of [...Object.keys(childResumes), ...(saved?.nativeChildren === 2 ? saved.known ?? [] : [])]) childIds.add(id);
      await root.start({ ...events,
        onReset(reason) {
          stopChildren();
          childIds.clear();
          childResumes = {};
          events.onReset(reason);
        },
        onEntries(entries) {
          events.onEntries(entries);
          // Deliver the launch before its child records so the reducer can resolve their owner.
          for (const entry of entries) {
            if (entry.event?.kind === 'subagent' && entry.event.subagentSessionId) childIds.add(entry.event.subagentSessionId);
          }
          if (!initializing) for (const id of childIds) {
            void ensureChild(id).catch((error: unknown) => events.onEntries([{ key: `native-child-error:${id}`, event: childState(id, 'disconnected', String(error)) }]));
          }
        },
      }, saved?.nativeChildren === 2 ? saved.root : resume);
      initializing = false;
      const order = [...childIds];
      held = new Map(order.map((id) => [id, []]));
      try {
        await Promise.all(order.map(ensureChild));
        await Promise.all(starting.values());
      } finally {
        const waiting = held;
        held = null;
        for (const id of order) { const entries = waiting.get(id)!; if (entries.length && !stopped) sink?.onEntries(entries); }
      }
    },
    async catchUp() { if (replacement) return replacement.catchUp?.(); await root.catchUp?.(); await Promise.all(starting.values()); await Promise.all([...children.values()].map((child) => child.catchUp?.())); },
    // The position names its own file (a child's pictures are in the child's record), so any reader of this harness reads it.
    ...(root.readImage ? { readImage: (ref: RecordImageRef) => root.readImage!(ref) } : {}),
    ...(root.getLineage ? { getLineage: () => root.getLineage!() } : {}),
    // resume-tail: the root record decides where a fill from the tail starts; children are read whole as they appear.
    // A read from a turn inside the record also reads, whole, the children its decoder state already knows, as a read
    // from the beginning does (they were started by lines before it).
    startingAt: root.startingAt ? async (position, at) => {
      const from = await root.startingAt!(position, at);
      return from && { data: { nativeChildren: 2, root: from, children: {}, known: at === undefined ? [] : root.childIdsAt?.(at) ?? [] }, fingerprint: from.fingerprint };
    } : undefined,
    stamp: root.stamp ? () => root.stamp!() : undefined,
    recordPath: root.recordPath ? () => root.recordPath!() : undefined,
    checkAt: root.checkAt ? (position) => root.checkAt!(position) : undefined,
    async resumePoint(budget) {
      if (replacement) return replacement.resumePoint!(budget);
      // The host starts archiving and immediately stops the source. Start every
      // cursor read before yielding, while the child sources still own their readers.
      const [point, childPoints] = await Promise.all([
        root.resumePoint!(budget),
        Promise.all([...children].map(async ([id, child]) => [id, await child.resumePoint?.(budget)] as const)),
      ]);
      if (!point || (budget && (budget.remainingBytes < 0
        || childPoints.some(([, child]) => !child)))) return null;
      const savedChildren = Object.fromEntries(childPoints.filter((point): point is readonly [string, SessionRecordResume] => Boolean(point[1])));
      return { data: { nativeChildren: 2, root: point, children: savedChildren }, fingerprint: [point.fingerprint, ...Object.entries(savedChildren).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id}:${value.fingerprint}`)].join('|') };
    },
    stop() { stopped = true; replacement?.stop(); root.stop(); stopChildren(); },
  };
}

/** Recorded children cannot be interrupted; their own boundaries decide their outcome.
 * A child's record only updates its card: the row saying it finished comes from the line in the root record that
 * notes it (each source decodes that line), so it sits in the root turn that line is in. */
export function childState(id: string, status: 'in_progress' | 'completed' | 'failed' | 'stopped' | 'disconnected', summary?: string): NormalizedEvent {
  return {
    kind: 'subagent_update', toolCallId: id, agentId: id, subagentSessionId: id,
    ...(summary ? { summary } : {}), status, canCancel: false,
  };
}
