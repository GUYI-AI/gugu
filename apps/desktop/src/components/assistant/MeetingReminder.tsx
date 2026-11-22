import { metadataSeparator } from '@/i18n/format'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatClock } from '../../i18n/format'
import { meetingKey, meetingRemindable, meetingToRemind, type UpcomingMeeting } from '@gugu/core/shared/voiceNotes'
import { platform } from '../../platform'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import type { VoiceNoteWindowRequest } from '../../session/shared/extensions/voice-note-session'
import { Button } from '../ui/Button'
import { Mic } from '../../lib/icons'
import { useNotice } from '@/lib/notices'
import { UI_EVENTS } from '../../lib/uiEvents'
import { openAssistantEntry } from '../../lib/assistantEntry'
import { useDevicePreferences } from '../../lib/devicePreferences'
import { deviceMeetings } from '../../lib/deviceMeetings'
import { useReplica } from '../../lib/replica'
import '../../i18n/registerVoiceNotesCatalog'
import { useVoiceNoteHandler } from './useVoiceNoteHandler'

/** 多久收一次过了时间窗的卡(日历本身由 `deviceMeetings` 每半分钟读一次:提醒在开会前 1 分钟弹,半分钟一看才赶得上)。 */
const POLL_MS = 30_000
/** 提醒过的那几场记在这台电脑上(记最近 256 条),关了 App 再开也不重复弹。 */
const SEEN_KEY = 'gugu.voiceNotes.remindedMeetings'
const SEEN_MAX = 256

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {
    // 记不住就算了:最坏是同一场会再提醒一次。
  }
}

/**
 * 录这场会是壳自己的事:壳的录音机替这个账号自己的助理录(App 录音宿主那一份,API 47;当成壳自己的点击 —— 起不来由它说一次为什么,
 * 同输入框「+」里那一项),不等哪一页挂上。答起没起来。
 */
async function startMeetingNote(meeting: NonNullable<Extract<VoiceNoteWindowRequest, { op: 'start' }>['meeting']>): Promise<boolean> {
  const shell = readAssistantShellBridge()?.getSnapshot()
  if (!shell?.ownerId || shell.assistantState !== 'found' || !shell.assistant) return false
  const { appVoiceNoteRequest } = await import('../../session/renderer/features/assistant/voice-notes/app-voice-note-host')
  const answer = await appVoiceNoteRequest({ op: 'start', ownerId: shell.ownerId, assistantId: shell.assistant.id, meeting, present: true })
  return answer.state === 'ready' && answer.started?.outcome === 'started'
}

function clock(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : formatClock(at)
}

/**
 * #7199 会议提醒:这台电脑日历里有会快开始时(前 1 分钟,开始后 5 分钟内),
 * 横幅位上一条常驻提示「会议即将开始 · 开始录音」;窗口不在前台时再发一条系统通知。点「开始录音」= 打开助理 App 开录,
 * 录下的这条带着这场会的名字交给助理。日历读的是「设备 → 这台电脑能做的事」里连上的那一份,没连上就不提醒。
 * 只在有个人助理时看(录下的要交给它整理)。
 */
export function MeetingReminder({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('voiceNotes')
  const [meeting, setMeeting] = useState<UpcomingMeeting | null>(null)
  const [failed, setFailed] = useState(false)
  const [starting, setStarting] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const { recording } = useVoiceNoteHandler()

  const reminding = useDevicePreferences().meetingReminder
  const calendar = useReplica(deviceMeetings, enabled && reminding ? [] : null)
  const meetings = calendar.state === 'value' ? calendar.value.meetings : undefined
  // The clock the reminder window is judged by: a meeting enters its window as time passes, not only when the calendar changes.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!meetings) return
    seen.current ??= readSeen()
    const next = meetingToRemind(meetings, now, seen.current)
    if (!next) return
    seen.current.add(meetingKey(next))
    writeSeen(seen.current)
    setFailed(false)
    setMeeting(next)
    if (!document.hasFocus())
      void platform?.showNotification({ title: t('meeting.heading'), body: [next.title, `${clock(next.start)} - ${clock(next.end)}`].filter(Boolean).join(metadataSeparator()) }).catch(() => undefined)
  }, [meetings, now, t])

  useEffect(() => {
    if (!enabled) return
    // 过了提醒的时间窗就自己收起(最晚开始后 5 分钟)。
    const timer = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      setMeeting((current) => (current && !meetingRemindable(current, at) ? null : current))
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled])

  const start = async (current: UpcomingMeeting) => {
    setStarting(true)
    setFailed(false)
    window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
    // The assistant's page (its App), where the recording bar shows; the recording itself is the host's.
    openAssistantEntry()
    const ok = await startMeetingNote({ title: current.title, start: current.start, end: current.end }).catch(() => false)
    setStarting(false)
    if (ok) setMeeting(null)
    else setFailed(true)
  }

  // 一条常驻提示(横幅位):标题 +「会议 · HH:mm - HH:mm」,「开始录音」,关闭钮收起。没有个人助理了(退出登录、云电脑没了)也收起。
  useNotice('meeting-reminder', meeting && enabled ? {
    title: meeting.title || t('meeting.heading'), ongoing: true, onDismiss: () => setMeeting(null),
    description: <div data-testid="meeting-reminder" className="flex flex-col items-start gap-2">
      <span>{[t('meeting.heading'), [clock(meeting.start), clock(meeting.end)].filter(Boolean).join(' - ')].join(metadataSeparator())}</span>
      {failed ? <span className="text-[var(--danger-fg)]">{t('meeting.error')}</span> : null}
      <Button
        variant="primary"
        size="sm"
        disabled={starting || recording}
        title={recording ? t('meeting.recording') : undefined}
        onClick={() => void start(meeting)}
        data-testid="meeting-reminder-start"
      >
        <span className="inline-flex items-center gap-1 [&>svg]:h-4 [&>svg]:w-4">
          <Mic />
          {recording ? t('meeting.recording') : t('meeting.startRecording')}
        </span>
      </Button>
    </div>,
  } : null)
  return null
}
