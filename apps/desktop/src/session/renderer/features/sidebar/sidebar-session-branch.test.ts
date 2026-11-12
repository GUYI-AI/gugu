import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { buildSessionTree } from '../sessions/session-tree';
import { summarizeSessionBranches } from './sidebar-session-branch';

const working = presentAgentStatus({ reading: { status: 'working', detail: null } });
const parked = presentAgentStatus({ reading: { status: 'working', detail: 'parked' } });
const waiting = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });

describe('session branch summaries', () => {
  it('counts hidden descendants and running work, excluding the parent and parked work', () => {
    const roots = buildSessionTree([
      { id: 'root', presentation: working },
      { id: 'live', parentSessionId: 'root', presentation: working },
      { id: 'background', parentSessionId: 'root', presentation: parked },
      { id: 'waiting', parentSessionId: 'background', presentation: waiting },
      { id: 'quiet', parentSessionId: 'waiting', presentation: null },
    ]);
    const summaries = summarizeSessionBranches(roots);
    expect(summaries.get('root')).toMatchObject({
      total: 4,
      active: [{ count: 1, presentation: { tone: 'running', animate: true } }],
    });
    expect(summaries.get('live')).toMatchObject({ total: 0, active: [] });
    expect(summaries.get('background')).toMatchObject({ total: 2, active: [] });
  });

  it('does not call parked background or scheduled work running', () => {
    const roots = buildSessionTree([{ id: 'root' }, { id: 'parked', parentSessionId: 'root', presentation: parked }]);
    expect(summarizeSessionBranches(roots).get('root')?.active)
      .toEqual([]);
  });

  it('still counts a running descendant underneath a parked parent', () => {
    const roots = buildSessionTree([
      { id: 'root' },
      { id: 'parked', parentSessionId: 'root', presentation: parked },
      { id: 'live', parentSessionId: 'parked', presentation: working },
    ]);
    expect(summarizeSessionBranches(roots).get('root')?.active)
      .toEqual([{ count: 1, presentation: working }]);
  });
});
