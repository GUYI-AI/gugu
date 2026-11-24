import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Avatar } from '@/components/Avatar';
import { RunningTokenBar } from '@/components/RunningTokenBar';
import { ANIMATION_WINDOW_SEEN_EVENT, isAnimationWindowVisible } from '@gugu/session-shared/animation-visibility';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { restyledElements } from '../../../../../../../tests/support/styleRecalc';
import '@/styles/tokens.css';
import '@gugu/session-shared/animation-visibility.css';
import animationVisibilityCSS from '@gugu/session-shared/animation-visibility.css?inline';

/** Held by a hidden window: playback rate 0, its clock standing still. */
const held = (animation: Animation) => animation.playbackRate === 0;
const roots: Root[] = [];
const cleanup: Array<() => void> = [];
const avatar = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="gray"/%3E%3C/svg%3E';

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount());
  cleanup.splice(0).reverse().forEach((stop) => stop());
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  delete document.documentElement.dataset.animationTest;
});

async function mount(doc = document) {
  isAnimationWindowVisible(doc);
  const host = doc.createElement('div');
  doc.body.append(host);
  cleanup.push(() => host.remove());
  const root = createRoot(host);
  roots.push(root);
  // @@@mount-after-effects - the motion is watched from an effect (stopAnimationsOffscreen). Right after the commit
  // the DOM already animates with no attribute, which also meets the wait below, so a poll landing before the
  // effects ran handed the tests motion nobody watched (it read 4 after hiding). A synchronous render runs its
  // effects before flushSync returns.
  flushSync(() => root.render(<>
    <RunningTokenBar previewChatId={null} tokens={[{
      id: 'animation-agent', name: 'Agent', avatarSeed: 'animation-agent', avatarUrl: avatar,
      stateKey: 'running', toolCount: 1, lastActiveAt: null,
    }]} />
    <Avatar name="Running agent" seed="animation-agent" avatarUrl={avatar} isAgent agentStatus="working" harnessBadge={false} />
  </>));
  expect(host.querySelectorAll('[data-animation-off]'), 'the watched motion starts removed').toHaveLength(2);
  await until('the real running highlight and two avatar pulse rings animate', () => host.getAnimations({ subtree: true }).length === 4 && host.querySelector<HTMLElement>('.rtb-state')?.hasAttribute('data-animation-off') === false);
  const animations = host.getAnimations({ subtree: true });
  expect(animations.filter((animation) => (animation as CSSAnimation).animationName === 'av-status-pulse')).toHaveLength(2);
  expect(host.querySelector('.rtb-state')!.getAnimations({ subtree: true })).toHaveLength(2);
  expect(animations.every((animation) => animation.playState === 'running')).toBe(true);
  return { host, animations };
}

it('keeps one semantic running label and stationary glyphs throughout the composited sweep', async () => {
  const { host } = await mount();
  const label = host.querySelector<HTMLElement>('.rtb-state')!;
  const text = label.textContent;
  const glyphs = [...label.querySelectorAll<HTMLElement>('[data-shimmer-text]')];
  expect(glyphs).toHaveLength(2);
  expect(label.querySelector('[aria-hidden="true"]')!.textContent).toBe('');
  expect(glyphs.every((glyph) => glyph.dataset.shimmerText === text)).toBe(true);
  const box = label.getBoundingClientRect();
  const animations = label.getAnimations({ subtree: true });
  for (const animation of animations) {
    expect(animation.effect!.getTiming()).toMatchObject({ duration: 2000, iterations: Infinity });
    const frames = (animation.effect as KeyframeEffect).getKeyframes();
    // The transcript's rhythm as one loop: 20 steps in the first second, then still until the next cycle.
    expect(frames.map((frame) => frame.computedOffset)).toEqual([0, 0.5, 1]);
    expect(frames[0]!.easing).toBe('steps(20)');
    expect(frames[1]!.transform).toBe(frames[2]!.transform);
    for (const frame of frames) {
      expect(Object.keys(frame).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))).toEqual(['transform']);
    }
    animation.pause();
  }
  for (const time of [0, 500, 1000, 1999]) {
    animations.forEach((animation) => { animation.currentTime = time; });
    for (const glyph of glyphs) {
      expect(Math.abs(glyph.getBoundingClientRect().left - box.left)).toBeLessThan(0.1);
      expect(Math.abs(glyph.getBoundingClientRect().width - box.width)).toBeLessThan(0.1);
    }
    expect(label.textContent).toBe(text);
    expect(label.getBoundingClientRect().toJSON()).toEqual(box.toJSON());
  }
});

it('stops the running highlight and avatar pulses on the shared native signal and starts them again on the shared beat', async () => {
  const { host } = await mount();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  // Motion watched for visibility is removed while its window is unseen, and nothing is written on <html>.
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  expect(document.hidden).toBe(false);
  expect(document.documentElement.style.getPropertyValue('--gugu-animation-window-paused')).toBe('');
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('the animations run again at their own rate', () => host.getAnimations({ subtree: true }).length === 4 && host.getAnimations({ subtree: true }).every((animation) => animation.playbackRate === 1 && animation.playState === 'running'));
  const animations = host.getAnimations({ subtree: true });
  for (const animation of animations) expect(Math.abs(Number(animation.currentTime) - Number(animation.timeline!.currentTime))).toBeLessThan(100);
  // The surface pause still reaches them (pause() / play() would cut it off).
  host.inert = true;
  await until('a retained inert surface pauses the same clocks', () => animations.every((animation) => animation.playState === 'paused'));
  host.inert = false;
  await until('showing the retained surface resumes motion', () => animations.every((animation) => animation.playState === 'running'));
});

it('stops avatar pulses scrolled out of view and starts them again on the shared beat when they return', async () => {
  const { host, animations } = await mount();
  const pulsesOf = () => host.getAnimations({ subtree: true }).filter((animation) => (animation as CSSAnimation).animationName === 'av-status-pulse');
  const pulses = pulsesOf();
  expect(pulses).toHaveLength(2);
  // 14 steps while the ring is visible, then still: the second ring's 0.7 s delay lands on the same 70 ms grid.
  const frames = (pulses[0]!.effect as KeyframeEffect).getKeyframes();
  expect(frames.map((frame) => frame.computedOffset)).toEqual([0, 0.7, 1]);
  expect(frames[0]!.easing).toBe('steps(14)');
  expect(frames[1]!.transform).toBe(frames[2]!.transform);
  host.style.cssText = 'position:fixed;left:0;top:-2000px';
  await until('the off-screen pulses are gone', () => pulsesOf().length === 0);
  // The highlight sits in the same box, so it went too.
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  host.style.cssText = '';
  await until('the pulses run again on screen', () => pulsesOf().length === 2 && pulsesOf().every((animation) => animation.playState === 'running'));
  expect(host.getAnimations({ subtree: true })).toHaveLength(animations.length);
  // Back on the shared beat.
  for (const animation of pulsesOf()) expect(Math.abs(Number(animation.currentTime) - Number(animation.timeline!.currentTime))).toBeLessThan(100);
});

it('gives the hidden copies a narrow running bar keeps for measuring no animation at all', async () => {
  isAnimationWindowVisible();
  const host = document.createElement('div');
  host.style.width = '200px';
  document.body.append(host);
  cleanup.push(() => host.remove());
  const root = createRoot(host);
  roots.push(root);
  root.render(<RunningTokenBar previewChatId={null} tokens={['one', 'two', 'three', 'four'].map((id) => ({
    id, name: `Agent ${id}`, avatarSeed: id, avatarUrl: avatar, stateKey: 'running', toolCount: 1, lastActiveAt: null,
  }))} />);
  const pills = () => [...host.querySelectorAll<HTMLElement>('.rtb-bar > [data-message-preview-trigger]')];
  const folded = () => pills().filter((pill) => pill.style.visibility === 'hidden');
  await until('the bar folds some pills behind +N and the shown ones animate', () => folded().length > 0 && folded().length < pills().length
    && pills().filter((pill) => pill.style.visibility !== 'hidden').every((pill) => pill.getAnimations({ subtree: true }).length === 2));
  for (const pill of folded()) expect(pill.getAnimations({ subtree: true })).toHaveLength(0);
});

it('leaves the style pass alone when watched motion goes away', async () => {
  await mount();
  // getAnimations({ subtree: true }) resolves the whole document's pending style on the spot.
  const getAnimations = vi.spyOn(Element.prototype, 'getAnimations');
  roots.splice(0).forEach((root) => root.unmount());
  await new Promise(requestAnimationFrame);
  expect(getAnimations).not.toHaveBeenCalled();
  getAnimations.mockRestore();
});

it('keeps a visible portal animated while the opener hides and stops it when its own window hides', async () => {
  isAnimationWindowVisible();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:700px;height:300px';
  document.body.append(frame);
  cleanup.push(() => frame.remove());
  const doc = frame.contentDocument!;
  cleanup.push(mirrorDocument(document, doc));
  const { host: portal, animations } = await mount(doc);
  document.documentElement.dataset.animationTest = 'mirrored';
  await until('the opener theme mirror has run', () => doc.documentElement.dataset.animationTest === 'mirrored');
  expect(isAnimationWindowVisible()).toBe(false);
  expect(animations.every((animation) => animation.playState === 'running' && animation.playbackRate === 1)).toBe(true);
  doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  expect(portal.getAnimations({ subtree: true }), 'the portal own native signal stops its animations').toHaveLength(0);
  doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('the portal own restore starts them again', () => portal.getAnimations({ subtree: true }).length === animations.length && portal.getAnimations({ subtree: true }).every((animation) => animation.playState === 'running' && animation.playbackRate === 1));
});

it('pauses and resumes an infinite animation inside a CSS-isolated shadow root with its retained surface', async () => {
  isAnimationWindowVisible();
  const host = document.createElement('div');
  document.body.append(host);
  cleanup.push(() => host.remove());
  const shadow = host.attachShadow({ mode: 'open' });
  // An isolated style scope loads the actual shipped visibility stylesheet,
  // alongside its own animation styles; document selectors cannot enter it.
  const sheet = document.createElement('style');
  sheet.textContent = `${animationVisibilityCSS}\n@keyframes shadow-spin { to { transform: rotate(360deg); } }`;
  const glyph = document.createElement('span');
  glyph.textContent = 'Working';
  glyph.style.animation = 'shadow-spin 1s linear infinite';
  shadow.append(sheet, glyph);
  await until('the shadow animation runs', () => getComputedStyle(glyph).animationPlayState === 'running' && glyph.getAnimations().length === 1);
  // The surface pause is inherited, so it crosses the shadow boundary. (The hidden-window hold works on the
  // document's own animations, which by the Web Animations definition leave shadow trees out; no host document
  // of ours has one.)
  host.inert = true;
  await until('the retained surface pauses it', () => getComputedStyle(glyph).animationPlayState === 'paused' && glyph.getAnimations()[0]!.playState === 'paused');
  host.inert = false;
  await until('and lets it run again', () => glyph.getAnimations()[0]!.playState === 'running');
});

it('holds motion that begins while the window is not seen, and lets it go with the rest', async () => {
  const { host } = await mount();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  const style = document.createElement('style');
  style.textContent = '@keyframes late-spin { to { transform: rotate(360deg); } }';
  const late = document.createElement('span');
  late.textContent = 'Late';
  late.style.animation = 'late-spin 1s linear infinite';
  document.body.append(style, late);
  cleanup.push(() => { style.remove(); late.remove(); });
  await until('an animation started in a hidden window is held', () => late.getAnimations().length === 1 && held(late.getAnimations()[0]!));
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('everything runs again', () => host.getAnimations({ subtree: true }).length === 4 && [...host.getAnimations({ subtree: true }), late.getAnimations()[0]!].every((animation) => animation.playState === 'running' && animation.playbackRate === 1));
});

// @@@window-pause-by-animation — the flag used to be an inherited custom property on <html>: hiding and showing the
// window each re-styled every element of the document (22k elements on an 18k-node page).
it('hiding and showing the window re-styles nothing but what moves', async () => {
  await mount();
  const bystanders = document.createElement('div');
  bystanders.innerHTML = '<p><span><b>bystander</b></span></p>'.repeat(500);
  document.body.append(bystanders);
  cleanup.push(() => bystanders.remove());
  const all = await restyledElements(() => { document.documentElement.style.setProperty('--ruler-control', '1'); });
  document.documentElement.style.removeProperty('--ruler-control');
  expect(all).toBeGreaterThanOrEqual(1500);
  const hide = await restyledElements(() => { window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })); });
  const show = await restyledElements(() => { window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })); });
  expect(hide).toBeLessThan(100);
  expect(show).toBeLessThan(100);
});
