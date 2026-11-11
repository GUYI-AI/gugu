// #7199 语音笔记:这一窗口里正在跑的那几条的进度(voice-note-jobs)要画成哪一种,失败那一句怎么说。
import { useSyncExternalStore } from 'react';
import type { VoiceNoteView } from '@gugu/core/shared/voiceNotes';
import { voiceJobs, type VoiceJobView } from './voice-note-jobs';

/** 本机正在跑的进度 → 要画的那一种(盖过云电脑上的文件:文件只在每一步结束时才写)。 */
export function jobView(job: VoiceJobView): VoiceNoteView {
  if (job.phase === 'ready') return { kind: 'ready', title: job.title };
  if (job.phase === 'no_speech') return { kind: 'no_speech' };
  if (job.phase === 'failed')
    return {
      kind: 'failed',
      stage: job.failure?.stage ?? 'transcribe',
      retryable: job.failure?.retryable ?? true,
      message: job.failure?.message ?? '',
      notice: job.failure?.notice ?? null,
      code: job.failure?.code ?? null,
    };
  return { kind: 'processing', phase: job.phase };
}

export function useVoiceJobs(): readonly VoiceJobView[] {
  return useSyncExternalStore(voiceJobs.subscribe, voiceJobs.getSnapshot);
}

/** 失败那一句:网关明说的原话 > 签票原因码的那一句 > 按环节的通用一句。 */
const FAILURE_CODES = new Set(['signed-out', 'membership-required', 'model-unavailable', 'unreachable', 'service-unavailable']);
export function failureText(
  t: (key: string, values?: Record<string, string>) => string,
  view: { stage: string; notice: string | null; code: string | null; message: string },
  name: string
): string {
  if (view.notice) return view.notice;
  if (view.code && FAILURE_CODES.has(view.code)) return t(`failure.code.${view.code}`);
  if (view.message === 'unreadable') return t('failure.unreadable');
  return t(`failure.${view.stage}`, { name });
}
