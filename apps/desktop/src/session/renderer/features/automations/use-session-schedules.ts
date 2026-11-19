import { useMemo } from 'react';
import { useReplica, type Reading } from '@/lib/replica';
import { schedulesBySession, type SessionSchedule } from '@shared/core/automations/session-schedule';
import { sessionSchedules } from './automation-replicas';

// 任务页上「这个任务还会回来」(侧栏行上的时钟、输入框上方的托盘)读的那一份:那台机器上每条会话给自己排的定时。

const NONE: readonly SessionSchedule[] = [];

/**
 * `machine` null = 本机。`enabled: false` 时不问也不挂事件(侧栏里别的机器上的行)。
 */
export function useSessionSchedules(
  machine: string | null,
  sessionId: string,
  enabled = true
): Reading<readonly SessionSchedule[]> {
  const key = machine ?? 'local';
  const reading = useReplica(sessionSchedules, enabled ? [key] : null);
  const all = reading.state === 'value' ? reading.value : null;
  const bySession = useMemo(() => (all ? schedulesBySession(all) : null), [all]);
  if (reading.state !== 'value' || !bySession) return reading.state === 'error' ? reading : { state: 'unknown' };
  // The answer is the machine's whole list: no entry = none.
  return { ...reading, value: bySession.get(sessionId) ?? NONE };
}
