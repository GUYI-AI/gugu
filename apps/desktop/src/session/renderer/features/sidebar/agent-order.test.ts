import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { orderAgentRows, type AgentOrderRow } from './agent-order';

const running = presentAgentStatus({ reading: { status: 'working', detail: null } });
const waiting = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });
const failed = presentAgentStatus({ reading: { status: 'error', detail: null } });
const idle = presentAgentStatus({ reading: { status: 'idle', detail: null } });

const row = (id: string, fields: Partial<AgentOrderRow> = {}): AgentOrderRow => ({ id, presentation: idle, time: 0, ...fields });
const ids = (rows: readonly AgentOrderRow[]) => rows.map((r) => r.id);

describe('agent order', () => {
  it('needs you (waiting or failed), then running, then the rest', () => {
    expect(ids(orderAgentRows([
      row('quiet', { time: 9 }),
      row('busy', { presentation: running, time: 1 }),
      row('asks', { presentation: waiting }),
      row('broke', { presentation: failed, time: 2 }),
    ]))).toEqual(['broke', 'asks', 'busy', 'quiet']);
  });

  it('within a tier: newest interaction first, then created first, then id', () => {
    expect(ids(orderAgentRows([
      row('c', { time: 5, createdAt: '2026-11-02T00:00:00Z' }),
      row('b', { time: 5, createdAt: '2026-11-01T00:00:00Z' }),
      row('z', { time: 5 }),
      row('a', { time: 7 }),
      row('y', { time: 5 }),
    ]))).toEqual(['a', 'y', 'z', 'b', 'c']);
  });

  it('is total: any input order gives the same result', () => {
    const rows = [row('a', { time: 1 }), row('b', { time: 1 }), row('c', { presentation: running }), row('d', { time: 1, createdAt: '2026-01-01' })];
    const once = ids(orderAgentRows(rows));
    expect(ids(orderAgentRows([...rows].reverse()))).toEqual(once);
    expect(ids(orderAgentRows([rows[2]!, rows[0]!, rows[3]!, rows[1]!]))).toEqual(once);
  });
});
