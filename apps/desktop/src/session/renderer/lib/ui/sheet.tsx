import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { XIcon } from '@/lib/icons'
import * as React from 'react';
import { UiPortalContainerProvider, useUiPopupZIndex, useUiPortalContainer } from '@gugu/session-ui/react/primitives';
import { cn } from '@renderer/utils/utils';
import { MicroLabel } from './label';
import { useProbedRef } from '@/lib/overlayOcclusion';
import { ModalSurfaceProvider } from '@renderer/lib/modal/modal-surface';

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal" container={useUiPortalContainer()} {...props} />
  );
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      style={{ zIndex: useUiPopupZIndex() }}
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay-soft)] transition-opacity duration-[var(--dur-med)] data-ending-style:opacity-0 data-starting-style:opacity-0',
        className
      )}
      {...props}
    />
  );
}

/** The right inset of a Sheet's header row and its ✕ (the window's own buttons are in the title-bar row above, `top` below). */
export const SHEET_SAFE_INSET_RIGHT = '1rem';

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton: _showCloseButton = true,
  style,
  ref,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  const zIndex = useUiPopupZIndex();
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
          ref={useProbedRef('session-sheet', ref)}
        data-slot="sheet-content"
        data-side={side}
        style={
          {
            // #6597 Windows / Linux 的窗口按钮住在自己那一行标题栏里(z 高于本层):贴上沿的抽屉从那一行下沿起,
            // 否则顶上一截(连同 ✕)钻到标题栏底下,点下去落在拖拽区或窗口按钮上。没有这一行的平台是 0。
            ...(side === 'bottom' ? {} : { top: 'var(--window-titlebar-height, 0px)' }),
            // 左右抽屉原是 inset-y-0 + h-full;上沿下移后改由上下两沿定高,❌ 让 100% 顶出窗口底。
            ...(side === 'right' || side === 'left' ? { height: 'auto' } : {}),
            // Opened inside a sheet that declared its layer (a page modal), above it; else the --z-modal below.
            zIndex,
            ...(style as React.CSSProperties | undefined),
          } as React.CSSProperties
        }
        className={cn(
          // @@@sheet-not-floating (Refs #6106) — Sheet 是**贴边的全出血面板**,不是浮层。
          // design.md:「Never square a floating surface … A square surface with a shadow reads as
          // a crescent of light at each corner, and it is wrong every time.」方角 + lift 影是它
          // 逐字点名的失败模式,而这里四条边里有三条贴死窗口边缘 ⇒ 二选一取「不是浮层」那一边:
          // 删掉 shadow-sm,层级只由贴合边那一条 border-l/r/t/b 表达(下面 data-[side=*]:border-* 已有)。
          // ❌ 别改成「加圆角保阴影」:那会让贴死的三条边出现离缝。
          'fixed z-[var(--z-modal)] flex flex-col gap-4 bg-background-quaternary bg-clip-padding text-sm transition duration-[var(--dur-slow)] ease-in-out [-webkit-app-region:no-drag] data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-md data-[side=right]:sm:max-w-xl',
          className
        )}
        {...props}
      >
        {/* @@@modal-surface: overlays opened from inside the sheet stack above it; a registered modal asked for here nests in it. */}
        <UiPortalContainerProvider zIndex={zIndex ?? 'var(--z-modal)'}>
          <ModalSurfaceProvider>{children}</ModalSurfaceProvider>
        </UiPortalContainerProvider>
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({
  className,
  label,
  children,
  style,
  ...props
}: React.ComponentProps<'div'> & { label?: string }) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex gap-1.5 p-4 justify-between', className)}
      {...props}
      // 行内写而不是再叠一条 `pr-[…]` 工具类:与 `p-4` 的胜负会随编译源序漂,而这一格的正确与否
      // 是几何(两个 ✕ 重不重叠),不该交给类名顺序去赌。调用点给的 style 仍然压得过它。
      style={{ paddingRight: SHEET_SAFE_INSET_RIGHT, ...style }}
    >
      {label && <MicroLabel>{label}</MicroLabel>}
      {children}
      <SheetClose>
        <button className="mr-0 ml-auto text-foreground-muted hover:text-foreground">
          <XIcon className="size-4" />
        </button>
      </SheetClose>
    </div>
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'mt-auto flex flex-col gap-2 p-3 bg-background-quaternary-1 border-t',
        className
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-medium text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-foreground-muted', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
