// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The spring is played by framer's `animate`; here it runs to the end at once, in the call, so a move is its two ends.
const frames = vi.hoisted(() => ({ played: [] as number[][], hold: false }));
vi.mock('framer-motion', () => ({
  animate: (_from: number, _to: number, options: { onUpdate: (value: number) => void; onComplete: () => void }) => {
    const stopped = { value: false };
    const steps = [0.25, 0.5, 0.75];
    frames.played.push(steps);
    for (const step of steps) if (!stopped.value) options.onUpdate(step);
    if (!frames.hold && !stopped.value) options.onComplete();
    return { stop: () => (stopped.value = true) };
  },
}));

const { contentAt, paintSlot, PanelTrack } = await import('./panel-track');

afterEach(() => {
  frames.played.length = 0;
  frames.hold = false;
});

describe('the size is the state', () => {
  it('a slot to or from nothing keeps its open content size; a pane reflows with its drawn size; a held slot keeps the larger', () => {
    expect(contentAt(130, { size: 260, content: 260 }, { size: 0, content: 260, reflows: true })).toBe(260);
    expect(contentAt(130, { size: 0, content: 0 }, { size: 260, content: 260, reflows: true })).toBe(260);
    // the chat beside a side page coming in: laid out at every width it is drawn at
    expect(contentAt(700, { size: 889, content: 889 }, { size: 529, content: 529, reflows: true })).toBe(700);
    // the list folding to its rail keeps the list's width until it lands
    expect(contentAt(156, { size: 240, content: 240 }, { size: 72, content: 72, reflows: false })).toBe(240);
  });

  it('a slot is clipped at its drawn edge; only to or from nothing its far edge rides that edge and it fades', () => {
    // the list folding to its rail: its avatars stay where they are, the rest is clipped
    expect(paintSlot({ drawn: 156, content: 240 }, false)).toEqual({ offset: 0, opacity: 1, soft: false, hidden: false });
    expect(paintSlot({ drawn: 130, content: 260 }, true)).toMatchObject({ offset: -130, opacity: 0.5, soft: true, hidden: false });
    expect(paintSlot({ drawn: 0, content: 260 }, true)).toMatchObject({ opacity: 0, hidden: true });
  });
});

describe('PanelTrack', () => {
  const nodes = () => ({ place: document.createElement('div'), window: document.createElement('div'), content: document.createElement('div') });

  it('lays the slot out at its drawn size in every frame and lands on the target', () => {
    const track = new PanelTrack([{ id: 'list', at: { size: 240 } }]);
    const list = nodes();
    track.attach('list', list);
    const fill = document.createElement('div');
    track.attachFill(fill);
    const places: string[] = [];
    track.subscribe(() => places.push(list.place.style.width));
    track.to({ list: { size: 72 } });
    // start, three frames, landing: the place is the drawn size each time
    expect(places).toEqual(['240px', '198px', '156px', '114px', '72px']);
    expect(list.content.style.width).toBe('72px');
    expect(list.content.style.left).toBe('');
    expect(fill.style.transform).toBe('');
    expect(track.drawn('list')).toBe(72);
  });

  it('mid-move the content keeps the larger size, its far edge on the drawn edge', () => {
    frames.hold = true;
    const track = new PanelTrack([{ id: 'list', at: { size: 240 } }]);
    const list = nodes();
    track.attach('list', list);
    track.to({ list: { size: 72 } });
    // the last frame played: 0.75 of the way, drawn 114
    expect(track.drawn('list')).toBe(114);
    expect(list.place.style.width).toBe('114px');
    expect(list.content.style.width).toBe('240px');
    expect(list.content.style.left).toBe('-126px');
  });

  it('a fill coming from nothing keeps its open size while it moves, and takes the rest when it lands', () => {
    frames.hold = true;
    const track = new PanelTrack([{ id: 'chat', at: { size: 1000 } }], 'x', 1000);
    track.attach('chat', nodes());
    const place = document.createElement('div');
    const content = document.createElement('div');
    track.attachFill(place, content);
    track.to({ chat: { size: 600, reflows: true } });
    expect(content.style.width).toBe('400px');
    track.jump({ chat: { size: 600, reflows: true } });
    expect(content.style.width).toBe('');
  });

  it('a move to where it already goes does nothing; a jump stops a move and writes the target at once', () => {
    frames.hold = true;
    const track = new PanelTrack([{ id: 'list', at: { size: 240 } }]);
    track.attach('list', nodes());
    track.to({ list: { size: 240 } });
    expect(frames.played).toHaveLength(0);
    track.to({ list: { size: 72 } });
    track.to({ list: { size: 72 } });
    expect(frames.played).toHaveLength(1);
    track.jump({ list: { size: 300 } });
    expect(track.drawn('list')).toBe(300);
  });

  it('a slot closed to nothing is inert, and comes back within reach', () => {
    const track = new PanelTrack([{ id: 'inner', at: { size: 260 } }]);
    const inner = nodes();
    track.attach('inner', inner);
    track.to({ inner: { size: 0, content: 260 } });
    expect(inner.window.inert).toBe(true);
    expect(inner.content.style.width).toBe('260px');
    track.to({ inner: { size: 260 } });
    expect(inner.window.inert).toBe(false);
    expect(inner.window.style.opacity).toBe('');
    expect(inner.window.style.maskImage).toBe('');
  });
});
