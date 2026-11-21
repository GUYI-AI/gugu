import { refreshFailure, useReplica } from '@/lib/replica';
import { Unknown } from '@/components/ui/Unknown';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  LOCAL_SESSION_ENGINE_LABEL,
  type LocalSessionRow,
} from '@shared/core/session-import/session-import';
import { sessionImportPreview, type SessionImportSource } from './import-source';

// @@@sessionpage 导入本机会话 (spec session-page-import)：选中一条后的确认视图。
// 列表那一行只有标题（来自文件头部），光看标题分不清「哪一条」——尤其是同一个项目里
// 反复开的会话。这里只读有界首尾片段；只有原件完整落在窗口内时才给出总轮数。

function TurnBubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-tiny text-foreground-tertiary-muted">
        {/* role 是稳定枚举，只在展示边界映射成本地化标签；轮次正文原样呈现。 */}
        {translate(role === 'user' ? 'sessionImport.roleUser' : 'sessionImport.roleAgent')}
      </span>
      <p className="line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground-muted">
        {content}
      </p>
    </div>
  );
}

export function SessionPreviewPane({
  session,
  source,
  describeError,
}: {
  session: LocalSessionRow | null;
  /** #6264 读哪台机器上的原件(与列表同一个 source)。 */
  source: SessionImportSource;
  /** 读失败时说给人听的整句(本机 / 别的机器说法不同)。 */
  describeError: (error: unknown) => string;
}) {
  const { translate } = useSessionMessages();
  const reading = useReplica(sessionImportPreview, session ? [source.deviceId, session.filePath, session.engine] : null);
  const preview = reading.state === 'value' ? reading.value : null;
  // Also a read again (the session picked again) failing over the preview read before: the file may be gone since.
  const failure = refreshFailure(reading);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionImport.previewEmptyTitle')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground">{preview?.title ?? session.title}</span>
        <span className="text-xs break-all text-foreground-muted" title={session.cwd ?? undefined}>
          {session.cwd ?? translate('sessionImport.unknownDirectory')}
        </span>
        <span className="text-xs text-foreground-tertiary-muted">
          {LOCAL_SESSION_ENGINE_LABEL[session.engine]}
          {reading.state === 'value' && reading.value.turnCount != null ? ` ${translate('sessionImport.previewTurnCount', { count: reading.value.turnCount })}` : null}
          {reading.state === 'unknown' ? <> <Unknown className="w-12" /></> : null}
        </span>
      </div>

      {reading.state === 'unknown' ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner size="sm" />
          {translate('sessionImport.previewLoading')}
        </div>
      ) : null}

      {failure ? (
        // 文件可能已被删/移走（清单来自索引缓存）——直说，别给一个空白的预览。
        <p className="text-xs leading-relaxed text-foreground-destructive">
          {/* 已是整句(describeImportFailure):本机的诊断原样穿过外壳,别的机器按原因说人话。 */}
          {describeError(failure)}
        </p>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {preview.head.map((turn, index) => (
            <TurnBubble key={`head-${index}`} role={turn.role} content={turn.content} />
          ))}
          {preview.turnCount === null ? (
            <span className="text-tiny text-foreground-tertiary-muted">
              {translate('sessionImport.previewPartial')}
            </span>
          ) : preview.turnCount > preview.head.length + preview.tail.length ? (
            <span className="text-tiny text-foreground-tertiary-muted">
              {translate('sessionImport.previewOmitted', {
                count: preview.turnCount - preview.head.length - preview.tail.length,
              })}
            </span>
          ) : null}
          {preview.tail.map((turn, index) => (
            <TurnBubble key={`tail-${index}`} role={turn.role} content={turn.content} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
