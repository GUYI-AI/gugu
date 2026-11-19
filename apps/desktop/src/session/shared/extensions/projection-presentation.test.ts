import { describe, expect, it, vi } from 'vitest';
import { ProjectionPresentationState, projectionPresentation, type ProjectionPresentation, type ProjectionPresentationPacket } from './projection-presentation';

const picture = { sequence: 4, width: 640, height: 480, target: { id: 'window-7', revision: 2 } };
const decoration = (): ProjectionPresentation => ({ frame: structuredClone(picture), targetLabel: 'Editor',
  cursor: { x: 15, y: 20, click: 'click-1' }, action: { id: 'call-1', label: 'Click', phase: 'running' } });
const packet = (revision = 1): ProjectionPresentationPacket => ({ type: 'presentation', sourceId: 'source-a', generation: 'generation-a', revision, presentation: decoration() });

describe('App presentation on a painted projection', () => {
  it('requires the actual painted frame, whether metadata arrives before or after decoding', () => {
    const changed = vi.fn(), state = new ProjectionPresentationState('source-a', changed);
    state.connect('generation-a'); state.receive(packet());
    expect(changed).toHaveBeenLastCalledWith(null);
    state.painted(picture); expect(changed).toHaveBeenLastCalledWith(decoration());
    state.painted(null); expect(changed).toHaveBeenLastCalledWith(null);
    state.painted({ ...picture, sequence: 5 }); expect(changed).toHaveBeenLastCalledWith(null);
    state.receive({ ...packet(2), presentation: { ...decoration(), frame: { ...picture, sequence: 5 } } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ frame: expect.objectContaining({ sequence: 5 }) }));
  });

  it.each([
    { sequence: 3 }, { width: 641 }, { height: 481 },
    { target: { id: 'window-8', revision: 2 } }, { target: { id: 'window-7', revision: 3 } }, { target: undefined },
  ])('does not decorate a different frame, size or target: %o', change => {
    const changed = vi.fn(), state = new ProjectionPresentationState('source-a', changed);
    state.connect('generation-a'); state.receive(packet()); state.painted({ ...picture, ...change });
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it('rejects another source/generation and clears on invalidation, reconnect and close', () => {
    const changed = vi.fn(), state = new ProjectionPresentationState('source-a', changed);
    state.connect('generation-a'); state.painted(picture);
    state.receive({ ...packet(), sourceId: 'source-b' }); state.receive({ ...packet(), generation: 'old-generation' });
    expect(changed).toHaveBeenLastCalledWith(null);
    state.receive(packet()); expect(changed).toHaveBeenLastCalledWith(decoration());
    state.receive({ ...packet(2), presentation: null }); state.receive(packet()); state.painted(picture);
    expect(changed).toHaveBeenLastCalledWith(null);
    state.connect('generation-b'); state.receive(packet(3)); state.painted(picture);
    expect(changed).toHaveBeenLastCalledWith(null);
    state.close(); expect(changed).toHaveBeenLastCalledWith(null);
  });

  it('does not invent an operation when only a target was supplied', () => {
    const changed = vi.fn(), state = new ProjectionPresentationState('source-a', changed);
    state.connect('generation-a'); state.painted(picture);
    state.receive({ ...packet(), presentation: { frame: picture, targetLabel: 'Editor' } });
    expect(changed.mock.lastCall?.[0].action).toBeUndefined();
    state.receive({ ...packet(2), presentation: { ...decoration(), action: { id: 'call-1', label: 'Click', phase: 'done' } } });
    expect(changed.mock.lastCall?.[0].action.phase).toBe('done');
  });

  it('copies nested producer state and rejects unbounded or non-finite metadata', () => {
    const raw = decoration(), admitted = projectionPresentation(raw)!;
    raw.frame.target.id = 'other'; raw.cursor!.x = 30; raw.action!.phase = 'done';
    expect(admitted).toEqual(decoration());
    for (const change of [{ frame: { ...picture, sequence: 0 } }, { cursor: { x: NaN, y: 1 } },
      { cursor: { x: 640, y: 1 } }, { targetLabel: 'x'.repeat(201) }, { action: { id: 'a', label: 'b', phase: 'live' } }]) {
      expect(() => projectionPresentation({ ...decoration(), ...change })).toThrow(/Invalid/);
    }
  });
});
