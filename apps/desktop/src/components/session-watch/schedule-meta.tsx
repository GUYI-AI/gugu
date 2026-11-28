import { useTranslation } from 'react-i18next'
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract'
import { Clock } from '@/lib/icons'
import { getLocaleSnapshot } from '@/i18n/runtime'
import { differenceInCalendarDays, formatCalendarDate, formatClock } from '@/i18n/format'

/**
 * 手机任务行 meta 那一行最前面的一段:这个任务给自己排了定时,下一个几点回来(#7221 schedule_create)。
 * 手机没有悬停,所以时间直接写在行上:今天的只写「10:30」,明天「明天 09:30」,再远带日期。
 * 只剩没送到的(不会再响)写一句中性的「未送达 / 已错过」,仍是时钟、不用警示色:行上的标志只说 agent 此刻怎样,
 * 这一次没送到是那条定时自己的事,❌ 画成 ⚠(owner 11-28)。下一次送到了 digest 跟着变,这句自己消失。
 * 读的是那台机器推来的会话摘要里那一格(离线时是心跳带上来的那份)。
 */
export function ScheduleMetaPart({ schedule, now = Date.now() }: { schedule: SessionpageScheduleDigest; now?: number }) {
  const { t } = useTranslation('main')
  const when = schedule.nextAt ? scheduleWhen(Date.parse(schedule.nextAt), now, (time) => t('agentWatch.sessions.scheduleTomorrow', { time })) : null
  const missedText = t(schedule.attention?.kind === 'missed' ? 'agentWatch.sessions.scheduleMissed' : 'agentWatch.sessions.scheduleFailed')
  const label = when ? t('agentWatch.sessions.scheduleLabel', { count: schedule.count, when, title: schedule.title }) : missedText
  return (
    <span className="gg-aw-item-part gg-aw-item-schedule" aria-label={label} data-testid="agent-watch-session-schedule">
      <Clock aria-hidden />
      {when ?? missedText}
    </span>
  )
}

function scheduleWhen(at: number, now: number, tomorrow: (time: string) => string): string {
  const time = formatClock(at)
  const days = differenceInCalendarDays(at, now)
  if (days === 0) return time
  if (days === 1) return tomorrow(time)
  return formatCalendarDate(at, getLocaleSnapshot().resolvedLocale, { now: new Date(now) })
}
