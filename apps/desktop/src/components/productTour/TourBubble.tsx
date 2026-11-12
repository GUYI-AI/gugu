import '../../i18n/registerProductTourCatalog'
import './product-tour.css'
import { useId, type ComponentProps, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'

type PositionerProps = ComponentProps<typeof Popover.Positioner>
type PopupProps = ComponentProps<typeof Popover.Popup>

/**
 * The feature tour's card (onboarding spec 2.1): a solid card with an arrow at its anchor, 「n / N」, a title and a line,
 * then 跳过 on the left and 上一步 / 下一步 (完成 on the last step) on the right. Presentational only: the tour
 * (ProductTour) and the sidebar's intro (sidebar-one-list-chrome) each own their steps, keys, focus and shade, and draw
 * this one card (❌ a second look for a second walkthrough).
 *
 * `onPrevious` absent = no 上一步; `extra` goes between 上一步 and the primary button.
 */
export function TourBubble({
  anchor, side, align, sideOffset, alignOffset, collisionPadding, positionerClassName,
  popupRef, initialFocus, finalFocus, onOpenChange, testId, buttonTestIdPrefix,
  current, total, title, body, error, onSkip, onPrevious, onNext, extra,
}: {
  anchor: PositionerProps['anchor']
  side: PositionerProps['side']
  align: PositionerProps['align']
  sideOffset?: PositionerProps['sideOffset']
  alignOffset?: PositionerProps['alignOffset']
  collisionPadding?: PositionerProps['collisionPadding']
  positionerClassName?: string
  popupRef?: Ref<HTMLDivElement>
  initialFocus?: PopupProps['initialFocus']
  finalFocus?: PopupProps['finalFocus']
  onOpenChange?: ComponentProps<typeof Popover.Root>['onOpenChange']
  testId: string
  /** `<prefix>-skip`, `<prefix>-previous`, `<prefix>-next`. */
  buttonTestIdPrefix: string
  /** 1-based. */
  current: number
  total: number
  title: ReactNode
  body: ReactNode
  error?: string | null
  onSkip: () => void
  onPrevious?: () => void
  onNext: () => void
  extra?: ReactNode
}) {
  const { t } = useTranslation('productTour')
  const id = useId()
  const last = current === total
  return (
    <Popover.Root open modal={false} onOpenChange={onOpenChange}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side={side} align={align} alignOffset={alignOffset} sideOffset={sideOffset} collisionPadding={collisionPadding} className={positionerClassName}>
          <Popover.Popup ref={popupRef} className="product-tour-bubble" role="dialog" aria-labelledby={`${id}title`} aria-describedby={`${id}progress`} initialFocus={initialFocus} finalFocus={finalFocus} data-testid={testId}>
            <Popover.Arrow className="product-tour-arrow" />
            <div className="product-tour-kicker" id={`${id}progress`} aria-label={t('stepAria', { current, total })}>
              {t('stepProgress', { current, total })}
            </div>
            <h2 id={`${id}title`}>{title}</h2>
            <p>{body}</p>
            {error && <p role="alert" className="product-tour-error">{error}</p>}
            <footer className="product-tour-actions">
              {last ? <span /> : <Button variant="ghost" size="sm" onClick={onSkip} data-testid={`${buttonTestIdPrefix}-skip`}>{t('skip')}</Button>}
              <div>
                {onPrevious && <Button variant="ghost" size="sm" onClick={onPrevious} data-testid={`${buttonTestIdPrefix}-previous`}>{t('previous')}</Button>}
                {extra}
                <Button variant="primary" size="sm" data-primary onClick={onNext} data-testid={`${buttonTestIdPrefix}-next`}>{last ? t('done') : t('next')}</Button>
              </div>
            </footer>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
