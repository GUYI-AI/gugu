/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { until } from '../../../../tests/support/awaitCondition';
import { ShimmerText } from '../components/primitives/ShimmerText';
import { textShimmerClip, textShimmerInk, textShimmerSweep } from '../styles/effects.css';
import { measureSpill } from './contract';

let dispose: (() => void) | undefined;
let surface: HTMLDivElement | undefined;
beforeEach(async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
});
afterEach(async () => {
  dispose?.();
  surface?.remove();
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }));
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
});

function mount(label = '正在工作 · Running a long command') {
  surface = document.createElement('div');
  surface.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;display:flex;line-height:24px';
  document.body.append(surface);
  const [active, setActive] = createSignal(true);
  const [text, setText] = createSignal(label);
  dispose = render(() => <ShimmerText active={active()}
    style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{text()}</ShimmerText>, surface);
  const host = surface.firstElementChild as HTMLElement;
  return { host, setActive, setText };
}

const viewportPaused = (host: HTMLElement) => host.hasAttribute('data-animation-off');

it('keeps one semantic label, its geometry and live text while animating only transforms', async () => {
  const { host, setText, setActive } = mount();
  await until('the shimmer enters the viewport', () => !viewportPaused(host));
  const box = host.getBoundingClientRect().toJSON();
  const animations = host.getAnimations({ subtree: true });
  expect(animations).toHaveLength(2);
  // One masked, moving layer over still base glyphs: every masked layer is composited each frame.
  const layers = [...host.querySelectorAll<HTMLElement>(`.${textShimmerClip} *`)].map((el) => getComputedStyle(el));
  expect(layers.filter((style) => style.maskImage !== 'none')).toHaveLength(1);
  expect(layers.every((style) => style.mixBlendMode === 'normal')).toBe(true);
  for (const animation of animations) {
    for (const frame of (animation.effect as KeyframeEffect).getKeyframes()) {
      expect(Object.keys(frame).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))).toEqual(['transform']);
    }
    animation.pause();
    animation.currentTime = 375;
  }
  expect(host.getBoundingClientRect().toJSON()).toEqual(box);
  expect(measureSpill(surface!)).toBeLessThanOrEqual(0.5);
  // Positive control: losing both clips must expose the offscreen light layer.
  const clip = host.querySelector<HTMLElement>(`.${textShimmerClip}`)!;
  host.style.overflow = 'visible';
  clip.style.overflow = 'visible';
  expect(measureSpill(surface!)).toBeGreaterThan(0.5);
  host.style.overflow = 'hidden';
  clip.style.overflow = '';
  expect(host.textContent).toBe('正在工作 · Running a long command');
  expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull();
  setText('Working for 2 minutes');
  await until('the glyph copy follows live label text', () => host.querySelector<HTMLElement>(`.${textShimmerInk}`)?.dataset.shimmerText === 'Working for 2 minutes');
  setActive(false);
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  expect(host.textContent).toBe('Working for 2 minutes');
});

it('stops outside the viewport and when the host window hides, and pauses on retained surfaces', async () => {
  const { host } = mount();
  await until('the shimmer starts', () => !viewportPaused(host));
  expect(host.getAnimations({ subtree: true })).toHaveLength(2);
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: false }));
  expect(viewportPaused(host)).toBe(true);
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }));
  expect(viewportPaused(host)).toBe(false);
  expect(host.getAnimations({ subtree: true })).toHaveLength(2);
  surface!.style.visibility = 'hidden';
  surface!.inert = true;
  await until('the retained surface pauses', () => host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused'));
  surface!.style.visibility = '';
  surface!.inert = false;
  await until('the retained surface resumes', () => host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'running'));
  surface!.style.top = '-200px';
  await until('the offscreen shimmer stops', () => viewportPaused(host));
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  surface!.style.top = '20px';
  await until('the shimmer returns', () => !viewportPaused(host));
  expect(host.getAnimations({ subtree: true })).toHaveLength(2);
});

it('keeps reduced-motion labels flat and readable with no running sweep', async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const { host } = mount('正在工作');
  await until('the label mounts', () => host.textContent === '正在工作');
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  expect(getComputedStyle(host).webkitTextFillColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(getComputedStyle(host).backgroundImage).toBe('none');
});

// Each sweep used to finish and be rewound from script a second later; that rewind cost a main-thread style
// pass on every frame of a running turn. The sweep and its hold are now one infinite compositor animation.
it('sweeps and holds as one infinite animation: nothing finishes, nothing rewinds from script, rebuilt rows keep it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    surface = document.createElement('div');
    surface.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;display:flex;line-height:24px';
    document.body.append(surface);
    const [item, setItem] = createSignal({ status: 'running' });
    dispose = render(() => <ShimmerText active={item().status === 'running'}>Worked for 19s</ShimmerText>, surface);
    const host = surface.firstElementChild as HTMLElement;
    await until('the shimmer animations are ready', () => ({
      visible: !viewportPaused(host),
      animations: host.getAnimations({ subtree: true }).length,
    }), (state) => state.visible && state.animations === 2);
    const animations = host.getAnimations({ subtree: true });
    for (const animation of animations) {
      expect(animation.effect!.getTiming()).toMatchObject({ duration: 2000, iterations: Infinity });
      const frames = (animation.effect as KeyframeEffect).getKeyframes();
      // The second half holds the swept position: the same transform at 50% and at 100%.
      expect(frames.map((frame) => frame.offset)).toEqual([0, 0.5, 1]);
      expect(frames[1]!.transform).toBe(frames[2]!.transform);
      expect(frames[0]!.transform).not.toBe(frames[1]!.transform);
    }
    expect(vi.getTimerCount(), 'no script timer drives the shimmer').toBe(0);
    setItem({ status: 'running' });
    expect(host.getAnimations({ subtree: true })).toEqual(animations);
    expect(animations.every((animation) => animation.playState === 'running')).toBe(true);
    expect(host.querySelector<HTMLElement>(`.${textShimmerSweep}`)).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
