import type { CSSProperties } from 'react'
import type { TurnAnnotation } from '@gugu/session-core/acp/client'
import { annotationTargetName } from '@gugu/session-core/acp/client'
import { fileRowStyle } from '@gugu/session-shared/file-row'
import '@gugu/session-shared/file-row.css'

/**
 * The comments a message carries beside its words: one file row each (the task bubble's shape, `@gugu/session-shared/file-row`),
 * named by what it points at, the comment below; the whole target on hover. Their promptText is for agents and is never drawn.
 */
export function MessageAnnotationCards({ annotations }: { annotations: readonly TurnAnnotation[] }) {
  return (
    <div className="gg-file-rows" data-message-annotations="" style={fileRowStyle() as CSSProperties}>
      {annotations.map((annotation) => (
        <div key={annotation.number} className="gg-file-row" data-kind="annotation"
          title={`${annotation.target}\n${annotation.comment}`}>
          <span className="gg-file-row-text">
            <span className="gg-file-row-name">{`${annotation.number} · ${annotationTargetName(annotation.target)}`}</span>
            {annotation.comment && <span className="gg-file-row-detail">{annotation.comment}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}
