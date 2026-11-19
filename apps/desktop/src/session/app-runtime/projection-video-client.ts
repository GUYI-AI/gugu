import { openProjectionVideo, type DecodedProjectionFrame } from '../../../native/projection-media/web/viewer.mjs';
import { projectionInput, projectionInputOutcome, PROJECTION_UNCONFIRMED, type ProjectionInput, type ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { ProjectionInputNotSent, ProjectionInputQueue } from './projection-input-queue';
import type { ProjectionHost } from './projection-source';
import { ProjectionPresentationState, projectionPresentationPacket, projectionTarget, type ProjectionPicture, type ProjectionPresentation } from '@shared/extensions/projection-presentation';

type Pending = { resolve(outcome: ProjectionInputOutcome): void; timer: ReturnType<typeof setTimeout> };
/** Existing media transport plus execution receipts; SCTP admission is never reported as applied input. */
export async function projectionVideoClient(host: ProjectionHost, video: HTMLVideoElement, sourceId: string, options: {
  frame(frame: DecodedProjectionFrame | null): void;
  state?(state: 'connecting' | 'live' | 'closed', reason?: string): void;
  error?(error: unknown): void;
  presentation?(value: ProjectionPresentation | null): void;
}) {
  const bridge = host.projectionMedia;
  if (!bridge) throw new Error('This host has no direct projection media viewer');
  let epoch = 0, paintEpoch = 0, sequence = 0, painted = 0, generation = '', ready = false, closed = false;
  let media: Awaited<ReturnType<typeof openProjectionVideo>> | undefined, viewerId: string | undefined;
  let resetting: Promise<void> | undefined;
  const pending = new Map<number, Pending>();
  const presentation = new ProjectionPresentationState(sourceId, value => options.presentation?.(value));
  const targets = new Map<number, ProjectionPicture>();
  let decoded: DecodedProjectionFrame | null = null;
  const decorate = () => {
    const target = decoded && targets.get(decoded.sequence);
    presentation.painted(decoded && target && target.width === decoded.width && target.height === decoded.height ? target : null);
  };
  const settle = (sequence: number, outcome: ProjectionInputOutcome) => {
    const entry = pending.get(sequence); if (!entry) return;
    pending.delete(sequence); clearTimeout(entry.timer); entry.resolve(outcome);
  };
  const invalidate = () => {
    decoded = null; targets.clear(); presentation.close();
    ready = false; painted = 0; paintEpoch++; options.frame(null); inputs.clear();
    for (const sequence of pending.keys()) settle(sequence, { status: 'unknown', reason: PROJECTION_UNCONFIRMED });
  };
  const inputs = new ProjectionInputQueue(async packet => {
    if (!ready || packet.generation !== generation || !media) throw new ProjectionInputNotSent('Projection video changed');
    const outcome = Promise.withResolvers<ProjectionInputOutcome>();
    // Only a missing execution receipt is uncertain; the intent is never retried.
    const timer = setTimeout(() => {
      settle(packet.sequence, { status: 'unknown', reason: PROJECTION_UNCONFIRMED });
      invalidate();
    }, 30_000);
    pending.set(packet.sequence, { resolve: outcome.resolve, timer });
    try { await media.sendControl(JSON.stringify(packet)); }
    catch { settle(packet.sequence, { status: 'unknown', reason: PROJECTION_UNCONFIRMED }); }
    return outcome.promise;
  }, () => reset());
  const state = (value: 'connecting' | 'live' | 'closed', reason?: string) => { ready = value === 'live'; options.state?.(value, reason); };
  const disconnect = (current: number, error: unknown) => {
    if (current !== epoch || closed) return;
    invalidate(); state('closed', 'media-unavailable'); options.error?.(error);
  };
  async function open(): Promise<void> {
    const current = ++epoch;
    invalidate(); generation = ''; sequence = 0; state('connecting');
    const previous = viewerId; viewerId = undefined;
    media?.close(); media = undefined;
    if (previous) await bridge!.close({ id: previous });
    const lease = await bridge!.open({ sourceId });
    if (closed || current !== epoch) { await bridge!.close({ id: lease.id }); throw new Error('Projection viewer closed during startup'); }
    viewerId = lease.id;
    try {
      const stream = await openProjectionVideo({ video, offer: lease.offer,
        answer: answer => bridge!.answer({ id: lease.id, answer }),
        prepareControl: data => bridge!.sign({ id: lease.id, data }),
        onControl: data => {
          if (current !== epoch || closed) return;
          const value = JSON.parse(data) as { type?: unknown; generation?: unknown; sequence?: unknown };
          if (value.type === 'projection-generation') {
            if (typeof value.generation !== 'string' || !value.generation || value.generation.length > 128) throw new Error('Invalid projection generation');
            invalidate(); generation = value.generation; presentation.connect(generation); sequence = 0; state('connecting');
          } else if (value.type === 'presentation') {
            try { presentation.receive(projectionPresentationPacket(value)); } catch { presentation.close(); }
          } else if (value.type === 'projection-target' && value.generation === generation) {
            const target = value as unknown as { sequence: number; width: number; height: number; target: unknown };
            try {
              if (![target.sequence, target.width, target.height].every(n => Number.isSafeInteger(n) && n > 0)
                || target.width > 8192 || target.height > 8192) throw new Error('Invalid projection target frame');
              targets.set(target.sequence, { sequence: target.sequence, width: target.width, height: target.height,
                ...(target.target === null ? {} : { target: projectionTarget(target.target) }) });
            } catch { presentation.close(); return; }
            if (targets.size > 64) targets.delete(targets.keys().next().value!);
            decorate();
          } else if (value.type === 'input-result' && value.generation === generation && Number.isSafeInteger(value.sequence)) {
            settle(value.sequence as number, projectionInputOutcome(value));
          }
        },
        onFrame: (frame, send) => {
          if (current !== epoch || closed) return;
          decoded = frame; decorate();
          const painting = ++paintEpoch;
          ready = false; painted = frame?.sequence ?? 0; options.frame(frame);
          if (!frame || !generation) { state('connecting'); return; }
          painted = frame.sequence;
          void Promise.resolve(send(JSON.stringify({ type: 'ack', generation, frame: frame.sequence }))).then(() => {
            if (current === epoch && painting === paintEpoch && !closed) state('live');
          }, error => disconnect(current, error));
        },
      });
      if (closed || current !== epoch) { stream.close(); return; }
      media = stream;
      void stream.closed.catch(error => disconnect(current, error));
    } catch (error) {
      if (viewerId === lease.id) viewerId = undefined;
      await bridge!.close({ id: lease.id }); throw error;
    }
  }
  function reset(): Promise<void> {
    if (closed) return Promise.reject(new Error('Projection is closed'));
    resetting ??= open().catch(error => { state('closed', 'media-unavailable'); throw error; }).finally(() => { resetting = undefined; });
    return resetting;
  }
  try { await reset(); } catch (error) { closed = true; invalidate(); throw error; }
  return Object.freeze({ reset,
    input(raw: ProjectionInput, sent?: () => void) {
      if (closed || !ready || !painted || !generation) return Promise.reject(new ProjectionInputNotSent('Projection video is not ready for input'));
      let input: ProjectionInput;
      try { input = projectionInput(raw); } catch (error) { return Promise.reject(new ProjectionInputNotSent(String(error))); }
      return inputs.push({ type: 'input', generation, frame: painted, sequence: ++sequence, input }, sent);
    },
    async close() {
      if (closed) return; closed = true; epoch++; invalidate();
      media?.close(); media = undefined;
      const id = viewerId; viewerId = undefined;
      try { if (id) await bridge!.close({ id }); } finally { state('closed'); }
    },
  });
}
