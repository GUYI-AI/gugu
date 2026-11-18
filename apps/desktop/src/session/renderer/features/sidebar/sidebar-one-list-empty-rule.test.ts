import { describe, expect, it } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { assistantOf, importOfferShown, listHasNoTasks } from './sidebar-one-list-empty-rule';

// GUYI-AI/gugu#2548 the one list's empty state: when the list has no tasks, and when the import offer shows.

const session = (conversationId: string, agentUserId?: string): SessionpageSessionSummary => ({
  conversationId,
  projectId: 'tasks',
  title: conversationId,
  harness: 'codex',
  runtime: 'acp',
  agentStatus: 'idle',
  lastInteractedAt: null,
  supported: true,
  ...(agentUserId ? { agent: { userId: agentUserId } } : {}),
});
const machine = (...sessions: SessionpageSessionSummary[]) => ({ sessions });

describe('listHasNoTasks', () => {
  it('is not known before the machines are published', () => {
    expect(listHasNoTasks([], null)).toBeNull();
  });

  it('has no tasks when no machine has a session, whoever the assistant is', () => {
    expect(listHasNoTasks([machine(), machine()], undefined)).toBe(true);
    expect(listHasNoTasks([machine()], null)).toBe(true);
  });

  it("does not count the assistant's own conversations as tasks", () => {
    expect(listHasNoTasks([machine(session('s-a', 'assistant')), machine()], 'assistant')).toBe(true);
  });

  it('has tasks when any machine has a session of another agent', () => {
    expect(listHasNoTasks([machine(session('s-a', 'assistant')), machine(session('s-1', 'agent-1'))], 'assistant')).toBe(false);
    expect(listHasNoTasks([machine(session('s-1', 'agent-1'))], null)).toBe(false);
  });

  it('counts a session with no agent on it as a task', () => {
    expect(listHasNoTasks([machine(session('s-legacy'))], 'assistant')).toBe(false);
  });

  it('is not known while sessions exist and the assistant is not known yet', () => {
    expect(listHasNoTasks([machine(session('s-a', 'assistant'))], undefined)).toBeNull();
  });
});

describe('assistantOf', () => {
  it('reads the assistant only once the shell has found it or found none', () => {
    expect(assistantOf(null)).toBeUndefined();
    expect(assistantOf({ assistantState: 'loading', assistant: null })).toBeUndefined();
    expect(assistantOf({ assistantState: 'unreadable', assistant: null })).toBeUndefined();
    expect(assistantOf({ assistantState: 'none', assistant: null })).toBeNull();
    expect(assistantOf({ assistantState: 'found', assistant: { id: 'assistant' } as never })).toBe('assistant');
  });
});

describe('importOfferShown', () => {
  it('shows only when the list has no tasks and the import part lists sessions', () => {
    expect(importOfferShown(true, 3)).toBe(true);
  });

  it('hides when there are tasks', () => {
    expect(importOfferShown(false, 3)).toBe(false);
  });

  it('hides when there is nothing to import', () => {
    expect(importOfferShown(true, 0)).toBe(false);
  });

  it('hides while either fact is not known yet', () => {
    expect(importOfferShown(null, 3)).toBe(false);
    expect(importOfferShown(true, null)).toBe(false);
  });
});

