import { useRef } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { cn } from '@renderer/utils/utils';

/**
 * Puts a group's shares (by panel id) into the library — when the group holds exactly those panels.
 *
 * The library takes a panel into its group a render after the panel mounts. In the commit that adds or removes one, an
 * effect (or a resize observer) still finds the group's previous panels there, and a layout for the new set is refused
 * with a throw ("Invalid 1 panel layout: …"). That is not an error to catch: it is a layout for panels the group does not
 * have yet, so it waits. When the library takes the new set in, it lays it out from each panel's `defaultSize` (or the
 * layout it last had for that set) and reports it through `onLayoutChanged`; a caller that owns the shares sets them there.
 * Shares already within `tolerance` of the group's are left alone, so the two never fight.
 */
export function setGroupLayout(handle: ResizablePrimitive.GroupImperativeHandle, wanted: Record<string, number>, tolerance: number): void {
  const current = handle.getLayout();
  const ids = Object.keys(wanted);
  if (Object.keys(current).length !== ids.length || !ids.every((id) => id in current)) return;
  if (ids.every((id) => Math.abs(current[id]! - wanted[id]!) <= tolerance)) return;
  handle.setLayout(wanted);
}

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  onFocus,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const restoreFocus = () => {
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  };

  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px cursor-col-resize items-center justify-center bg-[var(--border-subtle)] after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2  focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90 aria-disabled:cursor-default!',
        className
      )}
      onFocus={(e) => {
        // `document.activeElement` is already the separator on pointerdown; use
        // relatedTarget to capture the element that was focused before the handle.
        if (e.relatedTarget instanceof HTMLElement) {
          previousFocusRef.current = e.relatedTarget;
        }
        onFocus?.(e);
      }}
      onPointerUp={(e) => {
        restoreFocus();
        onPointerUp?.(e);
      }}
      onPointerCancel={(e) => {
        restoreFocus();
        onPointerCancel?.(e);
      }}
      onPointerDown={onPointerDown}
      {...props}
    ></ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
