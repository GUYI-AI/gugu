/* eslint-disable react-refresh/only-export-components -- compound component namespace is intentional. */

import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { popupMotion } from './variants'
import { noteOverlayRequest } from '@/lib/localRendererDiagnostics'
import { OpenLayer, useUiPopupZIndex, useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { useProbedRef } from '@/lib/overlayOcclusion'

type ClassNameProp = { className?: string }

// @@@popover-variants - 原来只有 keyframe 进场,关闭是"直接消失"。改用 Base UI 的
// data-starting-style / data-ending-style 转场:退场也有 140ms,弹层从触发点长出、也缩回触发点。
const popoverPositioner = 'z-[var(--z-popover)] outline-none'
const popoverPopup = cn('box-border outline-none', popupMotion)

function Portal(props: PopoverPrimitive.Portal.Props) {
  // The surface's portal layer, as Dialog and Menu: a pop-out window's (aux-layers), else Base UI's document.body.
  return <PopoverPrimitive.Portal container={useUiPortalContainer()} {...props} />
}

function Root<Payload = unknown>({ onOpenChange, ...props }: PopoverPrimitive.Root.Props<Payload>) {
  return <PopoverPrimitive.Root<Payload> {...props} onOpenChange={(next, details) => {
    try { onOpenChange?.(next, details) } finally { noteOverlayRequest(details, 'app-popover', next) }
  }} />
}

function Positioner({
  className,
  children,
  style,
  ...props
}: Omit<PopoverPrimitive.Positioner.Props, 'className' | 'style'> & ClassNameProp & { style?: CSSProperties }) {
  const zIndex = useUiPopupZIndex()
  return (
    <PopoverPrimitive.Positioner
      data-slot="popover-positioner"
      className={cn(popoverPositioner, className)}
      style={zIndex ? { zIndex, ...style } : style}
      {...props}
    ><OpenLayer />{children}</PopoverPrimitive.Positioner>
  )
}

function Popup({
  className,
  style,
  ref,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, 'className' | 'style'> &
  ClassNameProp & {
    style?: CSSProperties
  }) {
  return (
    <PopoverPrimitive.Popup
      ref={useProbedRef('app-popover', ref)}
      data-slot="popover-popup"
      className={cn(popoverPopup, className)}
      style={style}
      {...props}
    />
  )
}

function Arrow({ className, ...props }: Omit<PopoverPrimitive.Arrow.Props, 'className'> & ClassNameProp) {
  return <PopoverPrimitive.Arrow className={className} {...props} />
}

function Close({
  className,
  ...props
}: Omit<PopoverPrimitive.Close.Props, 'className'> & ClassNameProp) {
  return <PopoverPrimitive.Close data-slot="popover-close" className={className} {...props} />
}

/** Gugu popover composition: Base UI owns dismissal/positioning, call sites own content. */
export const Popover = {
  Root,
  Title: PopoverPrimitive.Title,
  Description: PopoverPrimitive.Description,
  Trigger: PopoverPrimitive.Trigger,
  createHandle: PopoverPrimitive.createHandle,
  Portal,
  Positioner,
  Popup,
  Close,
  Arrow,
}
