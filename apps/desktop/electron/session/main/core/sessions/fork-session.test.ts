import { expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('./attach-agent-to-session', () => ({ attachAgentToSession: vi.fn() }));
vi.mock('./utils', () => ({ mapSessionRowToSession: vi.fn() }));

const { forkTitle } = await import('./fork-session');

it('names a fork after the original task, however many forks it is away from it', () => {
  expect(forkTitle('Plan')).toBe('Plan-fork');
  expect(forkTitle('Plan-fork')).toBe('Plan-fork');
  expect(forkTitle('Plan-fork-fork 2')).toBe('Plan-fork');
  expect(forkTitle('Plan-fork 3')).toBe('Plan-fork');
  expect(forkTitle('fork-lift 2')).toBe('fork-lift 2-fork');
});
