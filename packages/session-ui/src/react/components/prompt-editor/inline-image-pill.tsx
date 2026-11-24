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
import { useState } from 'react';
import { useMessages } from '../../localization/message-provider';
import * as styles from './inline-image-pill.css';

export type InlineImageOptions = { onView?: (id: string) => void };

export function InlineImagePill({ node, selected, extension }: NodeViewProps) {
  const { translate } = useMessages();
  const id = node.attrs.id as string;
  const src = node.attrs.src as string | null;
  const name = (node.attrs.name as string | null) ?? '';
  // Fixed, so the editor's own scroll box cannot clip the preview.
  const [preview, setPreview] = useState<{ left: number; bottom: number } | null>(null);
  const onView = (extension.options as InlineImageOptions).onView;
  return (
    <NodeViewWrapper as="span" className={styles.wrapper}>
      <span
        contentEditable={false}
        data-inline-image-id={id}
        data-label={translate('composer.inlineImage')}
        title={name || undefined}
        className={cx(styles.pill, selected && styles.pillSelected)}
        onMouseEnter={(event) => {
          if (!src) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setPreview({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
        }}
        onMouseLeave={() => setPreview(null)}
        onMouseDown={(event) => { if (onView) event.preventDefault(); }}
        onClick={() => { setPreview(null); onView?.(id); }}
      >
        {src ? <img src={src} alt="" draggable={false} className={styles.thumb} /> : <span className={styles.thumb} />}
      </span>
      {preview && src && (
        <span className={styles.preview} style={{ left: preview.left, bottom: preview.bottom }} aria-hidden="true">
          <img src={src} alt="" draggable={false} className={styles.previewImage} />
        </span>
      )}
    </NodeViewWrapper>
  );
}
