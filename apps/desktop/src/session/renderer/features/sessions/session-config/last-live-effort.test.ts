import { beforeEach, describe, expect, it, vi } from 'vitest';

const table = new Map<string, unknown>();
vi.mock('@/lib/viewStateTable', () => ({
  readInterface: (name: string) => table.get(name),
  writeInterface: (name: string, value: unknown) => {
    if (value === undefined) table.delete(name);
    else table.set(name, value);
  },
}));

const { lastLiveEffort, rememberLiveEffort } = await import('./last-live-effort');
const LEVELS = { low: {}, medium: {}, high: {} };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('last live effort (#3973)', () => {
  beforeEach(() => table.clear());

  it('answers the level this session last ran at', () => {
    rememberLiveEffort(id(1), 'medium');
    rememberLiveEffort(id(1), 'high');
    expect(lastLiveEffort(id(1), LEVELS)).toBe('high');
    expect(lastLiveEffort(id(2), LEVELS)).toBeUndefined();
  });

  it('answers nothing the menu does not offer now', () => {
    rememberLiveEffort(id(1), 'xhigh');
    expect(lastLiveEffort(id(1), LEVELS)).toBeUndefined();
    expect(lastLiveEffort(id(1), null)).toBeUndefined();
    expect(lastLiveEffort(null, LEVELS)).toBeUndefined();
  });

  it('keeps the most recent sessions inside its own capped view-state entry', async () => {
    for (let i = 0; i <= 16; i++) rememberLiveEffort(id(i), 'medium');
    expect(lastLiveEffort(id(0), LEVELS), 'the oldest goes first').toBeUndefined();
    expect(lastLiveEffort(id(16), LEVELS)).toBe('medium');
    const { viewStateModelOf } = await import('@renderer/lib/stores/view-state-models');
    const key = 'view:@device//ui:last-live-effort';
    const model = viewStateModelOf(key);
    expect(model?.name).toBe('last live effort');
    for (let i = 0; i < 40; i++) rememberLiveEffort(id(100 + i), 'medium');
    expect(JSON.stringify({ value: table.get('last-live-effort') }).length + key.length).toBeLessThanOrEqual(model!.maxBytes);
  });
});
