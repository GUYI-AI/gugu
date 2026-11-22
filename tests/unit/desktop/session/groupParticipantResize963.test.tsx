// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screenLayout } from '@renderer/app/screen-layout';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';

// The screen's cuts are TrackCuts: what a block is drawn at is its slot's place (its share of the measured span, plus the
// divider's pixel); the last block takes the rest. The cut measures its own width (clientWidth) when it is observed.
const state = vi.hoisted(() => ({ extent: 966, observers: new Set<() => void>() }));
vi.mock('@renderer/app/project-block', () => ({ ProjectBlock: () => null }));
const { ScreenFrame } = await import('@renderer/app/screen-frame');
let root: Root;
let host: HTMLDivElement;
let sourceId: string;
let targetId: string;
const source = { kind: 'project', projectId: 'resize-project' } as const;
const target = { kind: 'session', projectId: 'resize-project', sessionId: 'resize-agent' } as const;
const place = (blockId: string) => parseFloat(host.querySelector<HTMLElement>(`[data-panel-slot="block-panel-${blockId}"]`)!.style.width);
/** The participant drawn beside its group (the cut's last block): the rest of the cut after the group's slot. */
const actualRightWidth = () => state.extent - place(sourceId);
const resizeTo = (extent: number) => act(() => {
  state.extent = extent;
  for (const notify of state.observers) notify();
});
const divider = () => host.querySelector<HTMLElement>('[data-screen-frame] [data-slot="resizable-handle"]')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Reduced motion: a programmatic change lands at once, so the test reads where it goes.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; }
    observe() { state.observers.add(this.callback); }
    disconnect() { state.observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-track-cut') ? state.extent : 0;
  });
  groupParticipantPanes.useAccount('width-resize-test');
  groupParticipantPanes.rememberWidth(550.625);
  screenLayout.show(source);
  groupParticipantPanes.show('resize-group', source, target, 966);
  sourceId = screenLayout.blockOf(source)!;
  targetId = screenLayout.blockOf(target)!;
  state.extent = 966;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<ScreenFrame />));
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  groupParticipantPanes.useAccount(null);
  state.observers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([446, 486])('restores the saved width after narrowing to %ipx and widening, without saving or reopening', (extent) => {
  const saved = localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test');
  expect(actualRightWidth()).toBeCloseTo(550.625, 2);
  resizeTo(586);
  expect.soft(actualRightWidth()).toBeCloseTo(586 - 221, 0);
  // the group keeps its least width (220) and its divider pixel: the participant takes what is left
  resizeTo(extent);
  expect(actualRightWidth()).toBeCloseTo(extent - 221, 0);
  resizeTo(966);
  expect(actualRightWidth()).toBeCloseTo(550.625, 2);
  expect(groupParticipantPanes.rightWidth).toBe(550.625);
  expect(localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test')).toBe(saved);
  expect(screenLayout.blockOf(target)).toBe(targetId);
});

it('keeps ordinary independently opened blocks on their ratio', () => {
  act(() => groupParticipantPanes.useAccount(null));
  const share = place(sourceId) / 966;
  resizeTo(700);
  expect(place(sourceId) / 700).toBeCloseTo(share, 2);
});

it('ignores zero-size frames and keeps a width the person moved the divider to', () => {
  act(() => { divider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  expect(groupParticipantPanes.rightWidth).toBeCloseTo(550.625 - 16, 0);
  const moved = actualRightWidth();
  resizeTo(0);
  resizeTo(966);
  expect(actualRightWidth()).toBeCloseTo(moved, 1);
});

it('restores a moved pixel width beside a third block after minimum-size clamping', () => {
  const other = { kind: 'session', projectId: 'resize-project', sessionId: 'third-task' } as const;
  act(() => {
    screenLayout.showBeside(other);
    if (screenLayout.layout?.type !== 'split') throw Error('Expected one horizontal group');
    screenLayout.setSplitSizes(screenLayout.layout.id, [30, 30, 40]);
  });
  resizeTo(1200);
  // the participant is a slot here (the third block takes the rest): its width is its place less the divider's pixel
  const participant = () => place(targetId) - 1;
  act(() => { divider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
  const moved = participant();
  expect(groupParticipantPanes.rightWidth).toBeCloseTo(moved, 0);
  const saved = localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test');
  resizeTo(660);
  resizeTo(1200);
  expect(participant()).toBeCloseTo(moved, 0);
  expect(groupParticipantPanes.rightWidth).toBeCloseTo(moved, 6);
  expect(localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test')).toBe(saved);
});
