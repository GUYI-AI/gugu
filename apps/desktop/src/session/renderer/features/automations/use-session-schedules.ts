import { useMemo } from 'react';
import { useReplica, type Reading } from '@/lib/replica';
import { schedulesBySession, type SessionSchedule } from '@shared/core/automations/session-schedule';
import { sessionSchedules } from './automation-replicas';

// 任务页上「这个任务还会回来」(侧栏行上的时钟、输入框上方的托盘)读的那一份:那台机器上每条会话给自己排的定时。
// 一台机器一个 replica 条目,变化靠那台机器推来的 automation:* 事件(排上、取消、到点、没送到都经过它们),❌ 轮询。
// 事件按机器只挂一份,有人看着时(automation-replicas 的 watch)。

const NONE: readonly SessionSchedule[] = [];

/**
 * 一条会话给自己排的、任务页要给人看的那几条(下一个要回来的在前)。`machine` = 这条会话所在的机器(null = 本机)。
 * `enabled: false` 时不问也不挂事件(侧栏里别的机器上的行,读会话目录里那一格)。Unknown until the machine answered.
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
  // A session with no entry in the machine's answer has none (the answer is the machine's whole list).
  return { ...reading, value: bySession.get(sessionId) ?? NONE };
}
