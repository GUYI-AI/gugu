import { Button } from '@session-ui/react/primitives/button';
import { DropdownMenu } from '@session-ui/react/primitives/dropdown-menu';
import { cx } from '@session-ui/styles/utilities/cx';
import { ArrowRight, Ellipsis, ListTree, Pencil, X } from '../../../icons'
import { GripVertical } from '../../../icons'
import * as React from 'react';
import * as styles from './queued-prompts-band.css';
import { useMessages } from '../../localization/message-provider';

export type ComposerQueuedPrompt = {
  id: string;
  text: string;
  origin: 'manual' | 'typed';
  /** 「立即发送」会插进当前回合(这家能插话),而不是取消它再发 —— 只换按钮提示(#6574)。 */
  sendNowSteers?: boolean;
  /**
   * 会话还没连上时排进去的那一句:运行时还没给它在队列里的编号,改、删、挪、立即发送都做不到 ⇒ 只显示、不给操作;
   * 会话一连上就换成能操作的那一份。❌ 摆着按钮、点了才报「没连上」。
   */
  locked?: boolean;
};

type QueuedRowLabels = { queued: string; reorder: string; drag: string; edit: string; imageOnly: string; sendNowLabel: string;
  sendNowTitle: string; sendNow: string; remove: string; actions: string };

export interface QueuedPromptsBandProps {
  prompts: ComposerQueuedPrompt[];
  /**
   * 排队中的那条**显示**成什么。缺席就按原文显示。
   *
   * 排队条打印的是「将要发出去的原文」,而 @ 提及在原文里是它的地址(`@user:<uuid>`)——
   * 输入框里和聊天记录里它都是一枚写着名字的 pill,唯独这里把地址摆到了用户脸上
   * (owner 2026-09-16 实撞)。宿主知道 token → 名字的账,所以由宿主给这一格的显示形态。
   * ⚠️ 只管**显示**:点进去编辑的仍是原文,那是真要发出去的东西,❌ 不能拿显示形态骗人。
   */
  renderPromptText?: (text: string) => React.ReactNode;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onSendNow: (id: string) => void;
  editingId?: string | null;
  className?: string;
}

export function QueuedPromptsBand({
  prompts,
  renderPromptText,
  onEdit,
  onDelete,
  onReorder,
  onSendNow,
  editingId,
  className,
}: QueuedPromptsBandProps) {
  const { locale, translate } = useMessages();
  // @@@queued-labels — a row's labels are words of (language, its place, whether sending steers): put into words once per
  // language, not on every draw. The composer redraws on every message of a running turn, and translating every row's
  // labels each time cost N rows of i18n per message. Only the labels are kept: the row itself is drawn every time, so a
  // mention's name that resolves later still shows (the text is not cached).
  const labels = React.useMemo(() => {
    const made = new Map<string, QueuedRowLabels>();
    return (index: number, steers: boolean): QueuedRowLabels => {
      const key = `${index}|${steers}`;
      let row = made.get(key);
      if (!row) {
        const place = { index: index + 1 };
        made.set(key, row = {
          queued: translate('composer.queuedLabel'),
          reorder: translate('composer.reorderQueuedPrompt', place),
          drag: translate('composer.dragToReorder'),
          edit: translate('composer.editQueuedPrompt', place),
          imageOnly: translate('composer.imageOnlyPrompt'),
          sendNowLabel: translate(steers ? 'composer.steerQueuedPromptNow' : 'composer.sendQueuedPromptNow', place),
          sendNowTitle: translate(steers ? 'composer.sendNowSteersTurn' : 'composer.sendNowCancelsTurn'),
          sendNow: translate(steers ? 'composer.steerQueuedPrompt' : 'composer.sendQueuedPrompt'),
          remove: translate('composer.deleteQueuedPrompt'),
          actions: translate('composer.queuedPromptActions', place),
        });
      }
      return row;
    };
  }, [locale, translate]);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const ids = prompts.filter((prompt) => !prompt.locked).map((prompt) => prompt.id);

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const index = ids.indexOf(fromId);
    const nextIndex = ids.indexOf(toId);
    if (index < 0 || nextIndex < 0) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    onReorder(next);
  };

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>, id: string) => {
    setDraggingId(id);
    setDragOverId(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!draggingId || !ids.includes(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain') || draggingId;
    if (draggedId) reorder(draggedId, id);
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  if (prompts.length === 0) return null;

  return (
    <div
      data-slot="composer-queued-prompts" data-composer-top-band="queue"
      role="region"
      aria-label={`${translate('composer.queuedPrompts')} (${prompts.length})`}
      className={cx(styles.band, className)}
    >
      <div className={styles.list} role="list">
        {prompts.map((prompt, index) => {
          const isEditing = editingId === prompt.id;
          const label = labels(index, !!prompt.sendNowSteers);
          return (
            <div
              key={prompt.id}
              role="listitem"
              data-queued-prompt-id={prompt.id}
              className={styles.row}
              data-editing={isEditing || undefined}
              data-dragging={draggingId === prompt.id || undefined}
              data-drag-over={dragOverId === prompt.id || undefined}
              onDragOver={(event) => handleDragOver(event, prompt.id)}
              onDragLeave={() =>
                setDragOverId((current) => (current === prompt.id ? null : current))
              }
              onDrop={(event) => handleDrop(event, prompt.id)}
            >
              {/* The row says it is waiting in words, not with a list glyph: read alone, 原文 + 现在插入 looks sent (UX 复审 B5-F05). */}
              <span className={styles.leadingSlot} title={label.queued}>
                <span className={styles.queueLabel}>{label.queued}</span>
                <ListTree className={styles.queueIcon} aria-hidden />
                {!isEditing && !prompt.locked && ids.length > 1 && (
                  <button
                    type="button"
                    className={styles.dragHandle}
                    draggable
                    aria-label={label.reorder}
                    title={label.drag}
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => handleDragStart(event, prompt.id)}
                    onDragEnd={handleDragEnd}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      const target = ids[ids.indexOf(prompt.id) + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (target) reorder(prompt.id, target);
                    }}
                  >
                    <GripVertical className={styles.dragHandleIcon} aria-hidden />
                  </button>
                )}
              </span>

              {prompt.locked ? (
                <span className={cx(styles.promptText, !prompt.text.trim() && styles.emptyText)} data-locked="true">
                  {prompt.text.trim() ? renderPromptText?.(prompt.text) ?? prompt.text.trim() : label.imageOnly}
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(styles.promptText, !prompt.text.trim() && styles.emptyText)}
                  onClick={() => onEdit(prompt.id, prompt.text)}
                  disabled={!!editingId}
                  aria-label={label.edit}
                  title={label.edit}
                >
                  {prompt.text.trim()
                    ? renderPromptText?.(prompt.text) ?? prompt.text.trim()
                    : label.imageOnly}
                </button>
              )}

              {!isEditing && !prompt.locked && (
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.sendNow}
                    aria-label={label.sendNowLabel}
                    title={label.sendNowTitle}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSendNow(prompt.id);
                    }}
                  >
                    <ArrowRight className={styles.actionIcon} />
                    {label.sendNow}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    aria-label={label.remove}
                    title={label.remove}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(prompt.id);
                    }}
                  >
                    <X className={styles.actionIcon} />
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      render={<Button type="button" variant="ghost" size="sm" icon />}
                      aria-label={label.actions}
                      title={label.actions}
                      disabled={!!editingId}
                    >
                      <Ellipsis className={styles.actionIcon} />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end" side="top" width="content">
                      <DropdownMenu.Item onClick={() => onEdit(prompt.id, prompt.text)}>
                        <Pencil className={styles.actionIcon} />
                        {label.edit}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
