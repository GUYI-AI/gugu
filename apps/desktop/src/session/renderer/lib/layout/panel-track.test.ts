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

const { paintTrack, planSlot, PanelTrack } = await import('./panel-track');

afterEach(() => {
  frames.played.length = 0;
  frames.hold = false;
});

describe('a move is laid out once at each end', () => {
  it('a slot takes the smaller of its two sizes in the layout and lays its content out at the larger', () => {
    expect(planSlot(240, 240, { size: 72, content: 72 })).toEqual({ place: 72, content: 240 });
    expect(planSlot(72, 72, { size: 240, content: 240 })).toEqual({ place: 72, content: 240 });
    // a column folding to nothing keeps its laid-out width
    expect(planSlot(260, 260, { size: 0, content: 260 })).toEqual({ place: 0, content: 260 });
  });

  it('a pane that reflows takes its new width at the start, unless it goes to nothing', () => {
    // the chat beside a side page coming in: wrapped once, at 529, ❌ at 889 until it lands
    expect(planSlot(889, 889, { size: 529, content: 529, reflows: true })).toEqual({ place: 529, content: 529 });
    expect(planSlot(529, 529, { size: 889, content: 889, reflows: true })).toEqual({ place: 529, content: 889 });
    expect(planSlot(260, 260, { size: 0, content: 0, reflows: true })).toEqual({ place: 0, content: 260 });
  });
});

describe('a frame is transforms', () => {
  it('a start slot is clipped at its drawn edge and the fill rides on it', () => {
    // the list mid-fold: drawn 156, laid out in place 72 with content 240
    const { slots, fill } = paintTrack([{ drawn: 156, place: 72, content: 240 }]);
    expect(slots[0]).toEqual({ window: -84, inner: 84, opacity: 1, soft: false, hidden: false });
    expect(fill).toBe(84);
  });

  it('a slot that closes to nothing fades with its size behind a soft edge, and is out of reach at 0', () => {
    const half = paintTrack([{ drawn: 130, place: 0, content: 260 }]).slots[0];
    expect(half).toMatchObject({ opacity: 0.5, soft: true, hidden: false });
    const gone = paintTrack([{ drawn: 0, place: 0, content: 260 }]).slots[0];
    expect(gone).toMatchObject({ opacity: 0, hidden: true });
  });

  it('a slot after another moves with the one before it', () => {
    const { slots, fill } = paintTrack([
      { drawn: 156, place: 72, content: 240 },
      { drawn: 260, place: 260, content: 260 },
    ]);
    expect(slots[1]).toMatchObject({ window: 84, inner: 0 });
    expect(fill).toBe(84);
  });
});

describe('PanelTrack', () => {
  const nodes = () => ({ place: document.createElement('div'), window: document.createElement('div'), content: document.createElement('div') });

  it('writes sizes only at the two ends and transforms in between, and lands on the target', () => {
    const track = new PanelTrack([{ id: 'list', at: { size: 240 } }]);
    const list = nodes();
    track.attach('list', list);
    const fill = document.createElement('div');
    track.attachFill(fill);
    const widths: string[] = [];
    track.subscribe(() => widths.push(list.content.style.width));
    track.to({ list: { size: 72 } });
    // start (laid out at 240), three frames (unchanged), landing (72)
    expect(widths).toEqual(['240px', '240px', '240px', '240px', '72px']);
    expect(list.place.style.width).toBe('72px');
    expect(list.window.style.transform).toBe('');
    expect(fill.style.transform).toBe('');
    expect(list.window.style.willChange).toBe('');
    expect(track.drawn('list')).toBe(72);
  });

  it('mid-move the fill and the window move by transform and are on their own layer', () => {
    frames.hold = true;
    const track = new PanelTrack([{ id: 'list', at: { size: 240 } }]);
    const list = nodes();
    track.attach('list', list);
    const fill = document.createElement('div');
    track.attachFill(fill);
    track.to({ list: { size: 72 } });
    // the last frame played: 0.75 of the way, drawn 114
    expect(track.drawn('list')).toBe(114);
    expect(list.place.style.width).toBe('72px');
    expect(fill.style.transform).toBe('translateX(42px)');
    expect(list.window.style.transform).toBe('translateX(-126px)');
    expect(list.content.style.transform).toBe('translateX(126px)');
    expect(fill.style.willChange).toBe('transform');
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
