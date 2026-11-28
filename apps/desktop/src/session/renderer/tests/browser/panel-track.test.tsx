/**
 * @@@panel-track — the track's contract, read from the layout it leaves in a real browser: a slot's size is its box's
 * size in every frame, a slot or the fill at nothing keeps its content laid out at its open size, and what is in a box is
 * clipped and faded with it.
 */
import { afterEach, expect, it } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { PanelSlot } from '@renderer/lib/layout/panel-slot';
import { MOVE, PanelTrack, panelRest } from '@renderer/lib/layout/panel-track';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

async function mount(track: PanelTrack) {
  harness = createReactHarness();
  await harness.render(
    <div style={{ display: 'flex', width: 900, height: 300 }} data-row="">
      <PanelSlot track={track} id="a"><p data-inside="a">a page that wraps differently at every width it is given, so its layout says what width it has</p></PanelSlot>
      <PanelSlot track={track} id="b" fill><p data-inside="fill">the rest of the row</p></PanelSlot>
    </div>
  );
  const row = harness.container.querySelector<HTMLElement>('[data-row]')!;
  const [slot, fill] = [...row.children] as HTMLElement[];
  const boxes = (place: HTMLElement) => ({ place, window: place.firstElementChild as HTMLElement, content: place.firstElementChild!.firstElementChild as HTMLElement });
  return { slot: boxes(slot), fill: boxes(fill) };
}

const width = (element: HTMLElement) => parseFloat(getComputedStyle(element).width);
const frame = () => new Promise(requestAnimationFrame);

/** Each frame of a move, from its first to 10 frames after the track has landed. */
async function frames<T>(track: PanelTrack, read: () => T): Promise<T[]> {
  const out: T[] = [];
  for (let rest = 0; rest < 10; rest += track.moving ? 0 : 1) {
    await frame();
    if (track.moving) out.push(read());
  }
  return out;
}

it('a slot going to nothing is drawn at its real size every frame, its content at its open size, fading; at nothing it stays laid out', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 300 } }], 'x', 900);
  const { slot, fill } = await mount(track);
  expect(width(slot.place)).toBe(300);
  expect(width(slot.content)).toBe(300);
  expect(width(fill.place)).toBe(600);

  track.to({ a: { size: 0 } });
  const read = await frames(track, () => ({ place: width(slot.place), content: width(slot.content), fill: width(fill.place), opacity: Number(getComputedStyle(slot.window).opacity), right: slot.content.getBoundingClientRect().right - slot.place.getBoundingClientRect().right }));
  expect(read.length).toBeGreaterThan(3);
  for (const at of read) {
    expect(at.content).toBe(300);
    expect(at.place + at.fill).toBeCloseTo(900, 0);
    expect(at.opacity).toBeCloseTo(at.place / 300, 1);
    // The sheet's far edge is on the slot's drawn edge.
    expect(Math.abs(at.right)).toBeLessThan(0.5);
  }
  expect(read.map((at) => at.place)).toEqual([...read.map((at) => at.place)].sort((x, y) => y - x));

  expect(width(slot.place)).toBe(0);
  expect(slot.content.offsetWidth).toBe(300);
  expect(slot.content.querySelector<HTMLElement>('[data-inside]')!.offsetWidth).toBeGreaterThan(0);
  expect(slot.window.inert).toBe(true);
  // Out of the window: nothing of it is where the row is.
  expect(slot.window.getBoundingClientRect().right).toBeLessThan(0);
  expect(width(fill.place)).toBe(900);

  track.to({ a: { size: 300 } });
  const back = await frames(track, () => ({ content: width(slot.content), inert: slot.window.inert }));
  for (const at of back) expect(at).toEqual({ content: 300, inert: false });
  expect(width(slot.place)).toBe(300);
  expect(getComputedStyle(slot.window).opacity).toBe('1');
  expect(slot.window.style.maskImage).toBe('');
});

it('the fill going to nothing is a sheet too: its open size kept, fading, laid out at nothing', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 300, reflows: true } }], 'x', 900);
  const { slot, fill } = await mount(track);
  track.to({ a: { size: 900, reflows: true } });
  const read = await frames(track, () => ({ place: width(slot.place), content: width(slot.content), fill: width(fill.content), opacity: Number(getComputedStyle(fill.window).opacity), left: fill.content.getBoundingClientRect().left - fill.place.getBoundingClientRect().left }));
  expect(read.length).toBeGreaterThan(3);
  for (const at of read) {
    expect(at.fill).toBe(600);
    // Between two open sizes a slot that reflows is laid out at its drawn size.
    expect(at.content).toBeCloseTo(at.place, 0);
    expect(at.opacity).toBeLessThanOrEqual(1);
    expect(Math.abs(at.left)).toBeLessThan(0.5);
  }
  expect(read.at(-1)!.opacity).toBeLessThan(0.2);
  expect(fill.content.offsetWidth).toBe(600);
  expect(fill.window.inert).toBe(true);

  track.jump({ a: { size: 300, reflows: true } });
  expect(width(fill.place)).toBe(600);
  expect(fill.window.inert).toBe(false);
  expect(fill.content.style.width).toBe('');
});

it('a jump is there in the same frame, at nothing too, and a move taken over starts where it is drawn, resting where it is told from where it last rested', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 300 } }], 'x', 900);
  const { slot, fill } = await mount(track);
  let landed = 0;
  track.onLanded(() => { landed += 1; });
  track.jump({ a: { size: 0 } });
  expect(width(slot.place)).toBe(0);
  expect(slot.content.offsetWidth).toBe(300);
  expect(track.moving).toBe(false);
  track.jump({ a: { size: 300 } });
  expect(landed).toBe(0);

  track.to({ a: { size: 100 } });
  expect(panelRest.get(fill.place)).toEqual({ rest: 800, grow: 200 });
  let mid = 300;
  while (mid > 200) { await frame(); mid = width(slot.place); }
  expect(track.drawn('a')).toBeCloseTo(mid, 0); // told from the move's two ends, the box not measured
  track.to({ a: { size: 300 } });
  // Turned round, the fill rests where it last rested: no wider, ❌ 100 narrower than where it was turned.
  expect(panelRest.get(fill.place)).toEqual({ rest: 600, grow: 0 });
  await frame();
  // One frame on, it has moved less than a frame's worth from where it was taken over, ❌ jumped to an end.
  expect(Math.abs(width(slot.place) - mid)).toBeLessThan(40);
  await frames(track, () => null);
  expect(width(slot.place)).toBe(300);
  expect(panelRest.get(fill.place)).toBeUndefined();
  expect(landed).toBe(1);
});

it('a sheet turned round part-way stays a sheet: its content on the moving edge, fading with what is drawn', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 300 } }], 'x', 900);
  const { slot } = await mount(track);
  track.to({ a: { size: 0 } });
  let mid = 300;
  while (mid > 150) { await frame(); mid = width(slot.place); }
  track.to({ a: { size: 300 } });
  const read = await frames(track, () => ({ place: width(slot.place), content: width(slot.content), opacity: Number(getComputedStyle(slot.window).opacity), right: slot.content.getBoundingClientRect().right - slot.place.getBoundingClientRect().right, mask: slot.window.style.maskImage !== '' }));
  expect(read.length).toBeGreaterThan(3);
  for (const at of read) {
    expect(at.content).toBe(300);
    expect(at.mask).toBe(true);
    expect(at.opacity).toBeCloseTo(at.place / 300, 1);
    expect(Math.abs(at.right)).toBeLessThan(0.5);
  }
  expect(width(slot.place)).toBe(300);
  expect(slot.window.style.maskImage).toBe('');
});

it('between two open sizes the fill is laid out at the size it is drawn at in every frame', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 600, reflows: true } }], 'x', 900);
  const { fill } = await mount(track);
  track.to({ a: { size: 300, reflows: true } });
  const read = await frames(track, () => ({ place: width(fill.place), content: width(fill.content) }));
  expect(read.length).toBeGreaterThan(3);
  for (const at of read) expect(at.content).toBeCloseTo(at.place, 0);
  expect(width(fill.content)).toBe(600);
});

it('the fill at nothing from the start is at rest like any other: inert, out of the window, laid out at the track\'s length', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 900 } }], 'x', 900);
  const { fill } = await mount(track);
  expect(width(fill.place)).toBe(0);
  expect(fill.window.inert).toBe(true);
  expect(fill.window.getBoundingClientRect().right).toBeLessThan(0);
  expect(fill.content.offsetWidth).toBe(900);
});

it('a slot that exits clipped is held where it is laid out, unfaded; what rides it moves on its clock, and a rider that comes once the move is under way joins it where it is', async () => {
  const track = new PanelTrack([{ id: 'a', at: { size: 300 }, exit: 'clip' }], 'x', 900);
  const { slot } = await mount(track);
  const rider = (mark: HTMLElement) => (from: number, to: number) => [mark.animate({ opacity: [String(from / 300), String(to / 300)] }, MOVE)];
  const marks = [document.createElement('i'), document.createElement('i')];
  slot.content.append(...marks);
  track.ride('a', rider(marks[0]));
  track.to({ a: { size: 0 } });
  let joined = false;
  const read = await frames(track, () => {
    // What mounts in the render that starts a move registers after the move has started.
    if (!joined) { joined = true; track.ride('a', rider(marks[1])); }
    return { place: width(slot.place), content: width(slot.content), rides: marks.map((mark) => Number(getComputedStyle(mark).opacity)), window: getComputedStyle(slot.window).opacity, mask: slot.window.style.maskImage, left: slot.content.getBoundingClientRect().left - slot.place.getBoundingClientRect().left };
  });
  expect(read.length).toBeGreaterThan(3);
  for (const at of read) {
    expect(at.content).toBe(300);
    expect(Math.abs(at.left)).toBeLessThan(0.5);
    expect([at.window, at.mask]).toEqual(['1', '']);
    for (const ride of at.rides) expect(ride).toBeCloseTo(at.place / 300, 1);
  }
  expect(marks.flatMap((mark) => mark.getAnimations())).toHaveLength(0);
  expect(slot.content.offsetWidth).toBe(300);
});
