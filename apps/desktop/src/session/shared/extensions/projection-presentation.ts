/** App-owned display data. It carries no input authority or executable markup. */
export type ProjectionTarget = { id: string; revision: number };
export type ProjectionPicture = { sequence: number; width: number; height: number; target?: ProjectionTarget };
export type ProjectionPresentation = {
  frame: ProjectionPicture & { target: ProjectionTarget };
  targetLabel?: string;
  cursor?: { x: number; y: number; click?: string };
  action?: { id: string; label: string; phase: 'running' | 'done' | 'failed' | 'paused' };
};
export type ProjectionPresentationPacket = {
  type: 'presentation';
  /** The host stamps these; an App cannot choose another resource or viewer generation. */
  sourceId: string;
  generation: string;
  revision: number;
  presentation: ProjectionPresentation | null;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection presentation');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function projectionTarget(raw: unknown): ProjectionTarget {
  const value = object(raw);
  if (!text(value.id, 256) || !positive(value.revision)) throw new Error('Invalid projection target');
  return { id: value.id, revision: value.revision };
}

/** Snapshot every scalar; a producer cannot change an admitted decoration through a retained object. */
export function projectionPresentation(raw: unknown): ProjectionPresentation | null {
  if (raw === null) return null;
  const value = object(raw), frame = object(value.frame);
  if (!positive(frame.sequence) || !positive(frame.width) || !positive(frame.height)
    || frame.width > 8192 || frame.height > 8192 || frame.width * frame.height > 16_777_216
    || value.targetLabel !== undefined && !text(value.targetLabel, 200)) throw new Error('Invalid projection presentation frame');
  const admitted: ProjectionPresentation = {
    frame: { sequence: frame.sequence, width: frame.width, height: frame.height, target: projectionTarget(frame.target) },
    ...(value.targetLabel === undefined ? {} : { targetLabel: value.targetLabel }),
  };
  if (value.cursor !== undefined) {
    const cursor = object(value.cursor);
    if (typeof cursor.x !== 'number' || !Number.isFinite(cursor.x) || cursor.x < 0 || cursor.x >= frame.width
      || typeof cursor.y !== 'number' || !Number.isFinite(cursor.y) || cursor.y < 0 || cursor.y >= frame.height
      || cursor.click !== undefined && !text(cursor.click, 128)) throw new Error('Invalid projection presentation cursor');
    admitted.cursor = { x: cursor.x, y: cursor.y, ...(cursor.click === undefined ? {} : { click: cursor.click }) };
  }
  if (value.action !== undefined) {
    const action = object(value.action);
    if (!text(action.id, 128) || !text(action.label, 200)
      || !['running', 'done', 'failed', 'paused'].includes(action.phase as string)) throw new Error('Invalid projection presentation action');
    admitted.action = { id: action.id, label: action.label, phase: action.phase as NonNullable<ProjectionPresentation['action']>['phase'] };
  }
  return admitted;
}

export function projectionPresentationPacket(raw: unknown): ProjectionPresentationPacket {
  const value = object(raw);
  if (value.type !== 'presentation' || !text(value.sourceId, 256) || !text(value.generation, 128) || !positive(value.revision)) {
    throw new Error('Invalid projection presentation packet');
  }
  return { type: 'presentation', sourceId: value.sourceId, generation: value.generation,
    revision: value.revision, presentation: projectionPresentation(value.presentation) };
}

export function sameProjectionPicture(a: ProjectionPicture, b: ProjectionPicture): boolean {
  return a.sequence === b.sequence && a.width === b.width && a.height === b.height
    && !!a.target && !!b.target && a.target.id === b.target.id && a.target.revision === b.target.revision;
}

/** Join only to an actually painted picture, never a packet receipt or a video `live` signal. */
export class ProjectionPresentationState {
  private generation = '';
  private revision = 0;
  private picture: ProjectionPicture | null = null;
  private presentation: ProjectionPresentation | null = null;

  constructor(private readonly sourceId: string, private readonly changed: (value: ProjectionPresentation | null) => void) {}

  connect(generation: string): void {
    this.generation = generation;
    this.revision = 0;
    this.picture = this.presentation = null;
    this.changed(null);
  }

  receive(packet: ProjectionPresentationPacket): void {
    if (!this.generation || packet.sourceId !== this.sourceId || packet.generation !== this.generation
      || !positive(packet.revision) || packet.revision <= this.revision) return;
    const admitted = projectionPresentation(packet.presentation);
    this.revision = packet.revision;
    this.presentation = admitted;
    this.apply();
  }

  painted(picture: ProjectionPicture | null): void {
    this.picture = picture && { ...picture, ...(picture.target ? { target: { ...picture.target } } : {}) };
    this.apply();
  }

  close(): void { this.connect(''); }

  private apply(): void {
    this.changed(this.picture && this.presentation && sameProjectionPicture(this.picture, this.presentation.frame) ? this.presentation : null);
  }
}
