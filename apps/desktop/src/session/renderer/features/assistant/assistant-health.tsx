import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Heart, Moon, Zap } from '@/lib/icons';
import type { BaselineStatus, HealthNight, HealthSignal, HealthSummary, HealthWorkout } from '@gugu/core/shared/healthSummary';
import { AssistantEmpty, AssistantRow, AssistantSection } from './assistant-ui';

/** 「分析健康报告」收的文件:报告多是 PDF 或拍照 / 截图。 */
export const HEALTH_REPORT_ACCEPT = 'application/pdf,image/*';

/** 它记的健康记录:记忆里文件名以 health 开头的那几条(解读里请它这么起名)。 */
export const isHealthNote = (file: string) => /^health[_-]/i.test(file);

/** 读到了的那一大块(手机「健康」页同一份:数据在手机本机读,画法照这里)。 */
export function HealthBody({ summary, t }: { summary: HealthSummary; t: TFunction<'assistant'> }) {
  const missing = summary.missing_types.map((type) => t(`health.type.${type}`, { defaultValue: type }));
  const unreadable = summary.unreadable.map((u) => t(`health.type.${u.type}`, { defaultValue: u.type }));
  const notes = [
    missing.length ? t('health.missing', { names: missing.join('、') }) : null,
    unreadable.length ? t('health.unreadableTypes', { names: unreadable.join('、') }) : null,
    summary.background.supported && !summary.background.granted ? t('health.backgroundHint') : null,
  ].filter(Boolean);
  const body = (Object.entries(summary.body) as Array<[keyof HealthSummary['body'], { value: number; at: string } | null]>).filter(([, v]) => v);
  return (
    <>
      <AssistantSection title={t('health.today')} bare testId="assistant-health-today">
        {summary.signals.length === 0 ? (
          <div className="ta-card">
            <AssistantEmpty>{t('health.emptySignals')}</AssistantEmpty>
          </div>
        ) : (
          <div className="ta-grid">
            {summary.signals.map((signal) => (
              <SignalCard key={signal.key} signal={signal} t={t} />
            ))}
          </div>
        )}
      </AssistantSection>
      {summary.last_night ? <NightCard night={summary.last_night} t={t} /> : null}
      {summary.granted_types.includes('exercise') ? (
        <AssistantSection title={t('health.workouts')} testId="assistant-health-workouts">
          {summary.workouts.length === 0 ? (
            <AssistantRow title={t('health.noWorkouts')} />
          ) : (
            summary.workouts.map((w) => <WorkoutRow key={`${w.start}-${w.exercise_type}`} workout={w} t={t} />)
          )}
        </AssistantSection>
      ) : null}
      {body.length > 0 ? (
        <AssistantSection title={t('health.body')} testId="assistant-health-body">
          {body.map(([key, v]) => (
            <AssistantRow key={key} title={t(`health.bodyItem.${key}`)} detail={dateTime(v!.at)} trailing={bodyValue(key, v!.value, t)} />
          ))}
        </AssistantSection>
      ) : null}
      {notes.length > 0 ? (
        <div className="ta-page-sub ta-pad flex flex-col gap-1" data-testid="assistant-health-notes">
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </div>
      ) : null}
    </>
  );
}

const STATUS_TONE: Record<BaselineStatus, 'good' | 'ok' | 'warn' | 'bad'> = {
  optimal: 'good',
  typical: 'ok',
  above: 'warn',
  below: 'warn',
  high: 'bad',
  low: 'bad',
};

const SIGNAL_ICON: Record<HealthSignal['key'], ReactNode> = {
  sleep: <Moon />,
  steps: <Zap />,
  resting_hr: <Heart />,
  hrv: <Heart />,
  active_kcal: <Zap />,
};

/** 一张关键指标:值 + 单位、基线状态、最近 7 天的小柱(最新那根高亮)。 */
function SignalCard({ signal, t }: { signal: HealthSignal; t: TFunction<'assistant'> }) {
  const max = Math.max(1, ...signal.series.map((p) => p.value ?? 0));
  const cumulative = signal.key === 'steps' || signal.key === 'active_kcal';
  return (
    <div className="ta-tile ta-health-metric" data-testid={`assistant-health-signal-${signal.key}`} data-status={signal.status ?? undefined}>
      <span className="flex items-center gap-2">
        <span className="ta-health-metric-icon">{SIGNAL_ICON[signal.key]}</span>
        <span className="ta-tile-sub">{t(`health.signal.${signal.key}`)}</span>
      </span>
      <span className="ta-health-value">{signal.value === null ? t('health.noData') : signalValue(signal.key, signal.value, t)}</span>
      <span className="ta-tile-sub">
        {signal.status ? (
          <span className="ta-health-status" data-tone={STATUS_TONE[signal.status]}>
            {t(`health.status.${signal.status}`)}
          </span>
        ) : cumulative && signal.value !== null ? (
          t('health.todaySoFar')
        ) : null}
        {signal.baseline !== null ? <span> · {t('health.baseline', { value: signalValue(signal.key, signal.baseline, t) })}</span> : null}
      </span>
      <span className="ta-health-bars" aria-hidden>
        {signal.series.map((point, index) => (
          <span
            key={point.date}
            className="ta-health-bar"
            data-latest={index === signal.series.length - 1 ? '' : undefined}
            data-empty={point.value === null ? '' : undefined}
            style={{ height: `${Math.max(6, Math.round(((point.value ?? 0) / max) * 100))}%` }}
          />
        ))}
      </span>
    </div>
  );
}

const STAGES = ['deep', 'light', 'rem', 'awake', 'asleep_unstaged'] as const;

/** 昨晚(睡眠卡):入睡 / 醒来、睡了多久、卧床多久、分期条。 */
function NightCard({ night, t }: { night: HealthNight; t: TFunction<'assistant'> }) {
  const stages = night.stages;
  const total = stages ? STAGES.reduce((sum, key) => sum + stages[key], 0) : 0;
  return (
    <AssistantSection title={t('health.lastNight')} bare testId="assistant-health-night">
      <div className="ta-card flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="ta-health-value">{duration(night.asleep_minutes, t)}</span>
          <span className="ta-tile-sub">{t('health.inBed', { duration: duration(night.in_bed_minutes, t) })}</span>
        </div>
        <span className="ta-tile-sub">{t('health.bedWake', { bed: clock(night.start), wake: clock(night.end) })}</span>
        {stages && total > 0 ? (
          <>
            <span className="ta-health-stages" aria-hidden>
              {STAGES.filter((key) => stages[key] > 0).map((key) => (
                <span key={key} data-stage={key} style={{ flexGrow: stages[key] }} />
              ))}
            </span>
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {STAGES.filter((key) => stages[key] > 0).map((key) => (
                <span key={key} className="ta-tile-sub inline-flex items-center gap-2">
                  <span className="ta-health-dot" data-stage={key} />
                  {t(`health.stage.${key}`)} {duration(stages[key], t)}
                </span>
              ))}
            </span>
          </>
        ) : null}
      </div>
    </AssistantSection>
  );
}

function WorkoutRow({ workout, t }: { workout: HealthWorkout; t: TFunction<'assistant'> }) {
  const facts = [
    duration(workout.minutes, t),
    workout.active_kcal !== null ? `${workout.active_kcal} ${t('health.unit.kcal')}` : null,
    workout.distance_m !== null && workout.distance_m > 0 ? `${(workout.distance_m / 1000).toFixed(2)} ${t('health.unit.km')}` : null,
    workout.hr_avg !== null ? t('health.workoutHr', { avg: workout.hr_avg, max: workout.hr_max ?? '—' }) : null,
  ].filter(Boolean);
  return (
    <AssistantRow
      leading={
        <span className="ta-tile-icon">
          <Zap />
        </span>
      }
      title={workout.title || workout.name}
      detail={`${dateTime(workout.start)} · ${facts.join(' · ')}`}
    />
  );
}

// ── 写法 ─────────────────────────────────────────────────────────────────────

function duration(totalMinutes: number, t: TFunction<'assistant'>): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h} ${t('health.unit.hour')} ${m} ${t('health.unit.minute')}` : `${m} ${t('health.unit.minute')}`;
}

function signalValue(key: HealthSignal['key'], value: number, t: TFunction<'assistant'>): string {
  switch (key) {
    case 'sleep':
      return duration(value, t);
    case 'steps':
      return `${Math.round(value).toLocaleString()} ${t('health.unit.steps')}`;
    case 'resting_hr':
      return `${Math.round(value)} ${t('health.unit.bpm')}`;
    case 'hrv':
      return `${Math.round(value)} ${t('health.unit.ms')}`;
    case 'active_kcal':
      return `${Math.round(value).toLocaleString()} ${t('health.unit.kcal')}`;
  }
}

function bodyValue(key: keyof HealthSummary['body'], value: number, t: TFunction<'assistant'>): string {
  if (key === 'weight_kg') return `${value} ${t('health.unit.kg')}`;
  if (key === 'respiratory_rate') return `${value} ${t('health.unit.perMinute')}`;
  return `${value}${t('health.unit.percent')}`;
}

/** 手机给的是带偏移的手机本地时间:时刻原样取「HH:MM」,❌ 换成这台电脑的时区(人看的是手机那边的作息)。 */
function clock(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}

/** 手机给的时间(带偏移的手机本地时间)按手机那边的钟面原样取。 */
function dateTime(iso: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${Number(match[1])}/${Number(match[2])} ${match[3]}` : serverTime(iso);
}

/** 库里记的时间(设备最后在线,UTC):换成这台电脑的本地时间。 */
function serverTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
