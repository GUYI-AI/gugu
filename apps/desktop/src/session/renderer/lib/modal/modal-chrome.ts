import type { ModalPosition, ModalSize } from '@/components/ui/modal-registry';

/** Width per registry size. Shared by the global ModalRenderer and the surface modal (modal-surface.tsx). */
export const MODAL_SIZE_CLASSES: Record<ModalSize, string> = {
  xs: 'sm:max-w-xs',
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
};

export const MODAL_POSITION_CLASSES: Record<ModalPosition, string> = {
  center: 'top-1/2 -translate-y-1/2',
  top: 'top-[15%] translate-y-0',
};

/**
 * @@@dialog-scroll — a dialog owns its scrolling: it is capped at the viewport, its header and footer
 * (`data-slot="dialog-header"` / `"dialog-footer"`) keep their height and every other direct child may shrink and
 * scroll. ❌ Each caller remembering `min-h-0 overflow-y-auto` — the ones that forgot clipped their own buttons.
 */
export const DIALOG_SCROLL_BODY =
  '[&>*:not([data-slot=dialog-header]):not([data-slot=dialog-footer])]:min-h-0 [&>*:not([data-slot=dialog-header]):not([data-slot=dialog-footer])]:overflow-y-auto';

/** The popup of a registered modal; its stacking comes from the layer it opens in (inline zIndex), the token is the floor. */
export const MODAL_POPUP_CLASS =
  'fixed left-1/2 z-[var(--z-modal)] flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-background-quaternary text-sm shadow-lift duration-[var(--dur-med,180ms)] data-closed:duration-[var(--dur-fast,120ms)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95';
