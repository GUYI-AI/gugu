/**
 * MentionPill
 *
 * React NodeView for the TipTap `mention` atom node. Participant targets retain
 * their @ prefix without an avatar; file targets render
 * as a real pill with a file glyph (slash-command pill treatment) — the dropped-
 * folder path reference must read as an object, and its hover ✕ lives over the
 * icon slot only, never stretched across the text:
 *
 *   [icon] [name]
 *
 * On a file pill's hover, a small ✕ button appears over the icon so the user can
 * remove it without keyboard navigation; participant pills have no ✕. The pill is
 * `contentEditable=false`, so Backspace / Delete at the node boundary deletes the
 * entire atom at once.
 */

import { fileLabelParts } from '@gugu/session-shared/markdown';
import { cx } from '@session-ui/styles/utilities/cx';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { X, Sparkles } from '../../../icons'
import { FileMark } from '../../../file-mark';
import type { MentionKind, MentionRole } from './types';
import * as styles from './mention-pill.css';

// ── Component ─────────────────────────────────────────────────────────────────

export function MentionPill({
  node,
  deleteNode,
}: NodeViewProps) {
  const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
  const rawName = (node.attrs.name as string | null) ?? null;
  const name = rawName ?? label;
  const kind = ((node.attrs.kind as string | null) ?? 'custom') as MentionKind;
  const role = (node.attrs.role as MentionRole | null) ?? null;
  const engine = (node.attrs.engine as string | null)?.trim() || null;
  const isParticipant = role !== null;
  const isAgent = role === 'agent';
  // file 引用 = 斜杠命令 pill 同款:真 pill + 文件图标。旧的 bare-文本处理里 ✕ 覆盖层
  // (surfaceHover 色块)被拉满整枚 pill,悬浮时文字整段被吞(#5736 试玩反馈);✕ 只许盖图标位。
  // 参与者身份优先。provider 偶发返回过期或错误的 file 类型时，不能把群成员变成文件 pill，
  // 否则悬停删除按钮会盖住可见的 `@name` 文字。
  const isFile = !isParticipant && kind === 'file';
  const isSkill = isFile && /[\\/]SKILL\.md$/.test(label);
  const title = isAgent || isFile
    ? ((node.attrs.title as string | null)?.trim() || name)
    : null;
  const pending = node.attrs.pending === true;
  // A file's place stays whole and the name gives way, as in the sent message (`fileLabelParts`).
  const { name: pillName, place } = isFile ? fileLabelParts(name) : { name, place: '' };

  // Hover-x: overlaid over the icon area on pill-hover
  const removeBtn = (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteNode();
      }}
      aria-label={`Remove @${name}`}
      className={styles.pillRemoveBtn}
    >
      <X style={{ width: '0.625rem', height: '0.625rem' }} />
    </button>
  );

  return (
    <NodeViewWrapper as="span" className={cx('mention-pill-wrapper', styles.pillWrapper)}>
      <span
        contentEditable={false}
        className={cx(
          styles.pill,
          isFile ? undefined : styles.pillPlain,
          isSkill && styles.skillPill,
          pending && styles.pillPending,
        )}
        data-skill-reference={isSkill ? label : undefined}
        data-mention-id={node.attrs.id as string}
        data-mention-kind={kind}
        data-mention-role={role ?? undefined}
        data-mention-engine={engine ?? undefined}
        data-mention-title={title ?? undefined}
        data-mention-pending={pending || undefined}
        title={title ?? undefined}
      >
        {/* File icon area — relative so the ✕ overlay is positioned inside it. Participant pills have no ✕:
            like Slack / Discord they are one token, removed whole by Backspace / Delete. */}
        {isFile && (
          <span className={styles.pillIconArea}>
            {isSkill ? <Sparkles style={{ width: 12, height: 12 }} /> : <FileMark name={pillName} size={12} ink />}
            {removeBtn}
          </span>
        )}
        {/* Display name */}
        <span className={styles.pillName}>{isParticipant || kind === 'custom' ? '@' : ''}{pillName}</span>
        {place && <span className={styles.pillPlace}>{place}</span>}
        {node.attrs.annotation && <small data-mention-annotation="" className={styles.pillAnnotation}>{String(node.attrs.annotation)}</small>}
      </span>
    </NodeViewWrapper>
  );
}
