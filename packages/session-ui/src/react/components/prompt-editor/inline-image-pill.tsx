/**
 * InlineImagePill: the NodeView of an inline image (`extensions/inline-image.ts`).
 *
 *   [16px thumbnail] Image N
 *
 * Same shape as a file / skill pill. N is the picture's place among the pictures of this message, counted by CSS
 * (`counter(inline-image)`), so deleting the first one renumbers the rest without touching the document. The host numbers
 * the sent message the same way (document order). Hover shows the picture above the chip; a click opens it.
 */

import { cx } from '@session-ui/styles/utilities/cx';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState, type HTMLAttributes } from 'react';
import { useMessages } from '../../localization/message-provider';
import * as styles from './inline-image-pill.css';

export type InlineImageOptions = { onView?: (id: string) => void };

/**
 * The chip itself, wherever words that hold a picture are shown: the composer's node, and the queued-prompt band. Its
 * label is "Image N", N counted by the CSS counter `inline-image` of the box that holds the words.
 */
export function InlineImageChip({ src, className, ...props }: { src?: string | null } & HTMLAttributes<HTMLSpanElement>) {
  const { translate } = useMessages();
  return (
    <span contentEditable={false} data-label={translate('composer.inlineImage')} {...props} className={cx(styles.pill, className)}>
      {src ? <img src={src} alt="" draggable={false} className={styles.thumb} /> : <span className={styles.thumb} />}
    </span>
  );
}

export function InlineImagePill({ node, selected, extension }: NodeViewProps) {
  const id = node.attrs.id as string;
  const src = node.attrs.src as string | null;
  const name = (node.attrs.name as string | null) ?? '';
  // Fixed, so the editor's own scroll box cannot clip the preview.
  const [preview, setPreview] = useState<{ left: number; bottom: number } | null>(null);
  const onView = (extension.options as InlineImageOptions).onView;
  return (
    <NodeViewWrapper as="span" className={styles.wrapper}>
      <InlineImageChip
        src={src}
        data-inline-image-id={id}
        title={name || undefined}
        className={cx(selected && styles.pillSelected)}
        onMouseEnter={(event) => {
          if (!src) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setPreview({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
        }}
        onMouseLeave={() => setPreview(null)}
        onMouseDown={(event) => { if (onView) event.preventDefault(); }}
        onClick={() => { setPreview(null); onView?.(id); }}
      />
      {preview && src && (
        <span className={styles.preview} style={{ left: preview.left, bottom: preview.bottom }} aria-hidden="true">
          <img src={src} alt="" draggable={false} className={styles.previewImage} />
        </span>
      )}
    </NodeViewWrapper>
  );
}
