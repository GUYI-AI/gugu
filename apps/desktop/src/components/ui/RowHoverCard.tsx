import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useUiPopupZIndex, useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import type { RowHoverCardController } from './rowHoverCardController'

type Side = 'top' | 'right' | 'bottom' | 'left'

/**
 * The card: a lifted surface beside its row (radius-surface, one lift shadow, no ring or border, popover face). Host tokens
 * (`--popover`, `--radius-surface`, `--shadow-lift`), so it reads the same in the shell's tree and in the session page's.
 * Render it only while `useRowHoverCardOpen` says so; it unmounts on close, so there is no exit animation.
 * `anchor` is a getter: a virtual list re-render replaces the row's node, positioning against the old one measures a detached element.
 */
export function RowHoverCard({
  card,
  rowKey,
  anchor,
  side = 'right',
  align = 'start',
  label,
  className,
  children,
}: {
  card: RowHoverCardController
  rowKey: string
  anchor: () => Element | null
  side?: Side
  align?: 'start' | 'center' | 'end'
  /** The card's accessible name. */
  label: string
  /** Layout of the surface (width, padding); the surface itself is the card's. */
  className?: string
  children: ReactNode
}) {
  const zIndex = useUiPopupZIndex()
  return (
    <PreviewCardPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) card.close(rowKey)
      }}
    >
      <PreviewCardPrimitive.Portal container={useUiPortalContainer()}>
        <PreviewCardPrimitive.Positioner anchor={anchor} side={side} align={align} collisionPadding={8} className="isolate z-50" style={zIndex ? { zIndex } : undefined}>
          {/* Flush against the row (no sideOffset): the visible 8px gap is the popup's transparent padding on the row's side.
              It is the card's, so the pointer walks from row to card without a pixel that is neither. */}
          <PreviewCardPrimitive.Popup
            data-row-hover-card={card.list}
            data-row-hover-key={rowKey}
            data-occludes-browser-page=""
            role="dialog"
            aria-label={label}
            onPointerLeave={(event) => card.leave(rowKey, event.relatedTarget)}
            className={cn(
              'z-50 origin-(--transform-origin) outline-hidden',
              'data-[side=right]:pl-2 data-[side=left]:pr-2 data-[side=top]:pb-2 data-[side=bottom]:pt-2',
              'duration-[var(--dur-fast)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
              'data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:slide-in-from-top-2',
              'motion-reduce:animate-none'
            )}
          >
            <div className={cn('overflow-hidden rounded-[var(--radius-surface)] bg-[var(--popover)] text-sm text-[var(--text-primary)] shadow-[var(--shadow-lift)]', className)}>{children}</div>
          </PreviewCardPrimitive.Popup>
        </PreviewCardPrimitive.Positioner>
      </PreviewCardPrimitive.Portal>
    </PreviewCardPrimitive.Root>
  )
}
