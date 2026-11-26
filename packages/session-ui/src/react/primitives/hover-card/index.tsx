/**
 * Hover-card primitives for row-level detail panels.
 *
 * Provides a delay-based open/close controller (`useHoverCard`) and a
 * `HoverCard` component that renders a Popover-anchored detail panel beside a
 * list. Designed to compose with `ComboboxPopover` (or any list-based UI) so
 * that hovering a row shows a detail card while keeping the parent popup open.
 *
 * Key behaviors:
 *  - Open after OPEN_DELAY_MS on first hover; while warm, hovering another row
 *    swaps content instantly with no re-open delay.
 *  - Moving the pointer onto the card itself cancels the close timer so links
 *    and interactive controls inside the card stay reachable.
 *  - Interactions with nested portals spawned by the card (e.g. inner selects)
 *    do not dismiss the card or the parent popup.
 */

import type { PopoverRootChangeEventDetails } from '@base-ui/react/popover';
import { Popover } from '@session-ui/react/primitives/popover';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { hoverCardDefault } from './hover-card.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 200;
const HOVER_CARD_ATTR = 'data-hover-card';

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Returns true when `event` originates inside a `[data-hover-card]` element or
 * inside a portaled popup spawned from one (e.g. an inner Select that renders
 * to document.body), but NOT inside `ownPopup` — that is the parent list's own
 * popup element, which should never be attributed to the hover card.
 */
export function isEventInsideInteractiveLayer(
  event: Event | null | undefined,
  ownPopup: HTMLElement | null
): boolean {
  if (!event) return false;
  const targets: Element[] = [];
  if (event.target instanceof Element) targets.push(event.target);
  const related = (event as FocusEvent).relatedTarget;
  if (related instanceof Element) targets.push(related);
  return targets.some((el) => {
    if (el.closest(`[${HOVER_CARD_ATTR}]`)) return true;
    const popup = el.closest(
      '[data-slot="popover-content"],[data-slot="combobox-content"],[data-slot="dropdown-menu-content"]'
    );
    return popup !== null && popup !== ownPopup;
  });
}

// ── Controller ────────────────────────────────────────────────────────────────

export interface HoverCardRowProps {
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseMove?: (event: React.MouseEvent<HTMLElement>) => void;
}

export interface HoverCardController {
  open: boolean;
  activeKey: string | null;
  getRowHoverProps: (key: string, onActivate?: (element: HTMLElement) => void) => HoverCardRowProps;
  popupRef: React.RefCallback<HTMLElement>;
  popupHoverProps: HoverCardRowProps;
  handleOpenChange: (open: boolean) => void;
  close: () => void;
  show: (key: string) => void;
}

/** Returns true while the user is actively engaged inside the hover card. */
function isHoverCardEngaged(card: HTMLElement | null): boolean {
  if (!card) return false;
  const document = card.ownerDocument;
  const expanded = card.querySelector('[aria-expanded="true"]');
  const controls = expanded?.getAttribute('aria-controls');
  const childPopup = controls && document.getElementById(controls);
  if (childPopup && (childPopup.matches(':hover') || childPopup.contains(document.activeElement))) return true;
  if (expanded && !controls) return true;
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    card.contains(active) &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
  );
}

/**
 * Hover-card timing controller.
 *
 * Tracks which list row (by `key`) should show a detail card, with debounced
 * open and close delays so the card doesn't flicker on quick mouse moves.
 */
export function useHoverCard({
  openDelay = OPEN_DELAY_MS, closeDelay = CLOSE_DELAY_MS, safeTriangle = false, delaySwitch = false,
}: { openDelay?: number; closeDelay?: number; safeTriangle?: boolean; delaySwitch?: boolean } = {}): HoverCardController {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const openRef = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const popup = useRef<HTMLElement | null>(null);
  const popupRef = useCallback((element: HTMLElement | null) => { popup.current = element; }, []);
  const rowPointer = useRef<{ key: string; x: number; y: number } | null>(null);
  const aim = useRef<{ horizontal: boolean; start: number; cross: number; edge: number; min: number; max: number; until: number } | null>(null);
  const deferred = useRef<number | null>(null);
  const clearAim = useCallback(() => {
    aim.current = null;
    if (deferred.current !== null) window.clearTimeout(deferred.current);
    deferred.current = null;
  }, []);

  const setOpenState = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      clearAim();
    },
    [clearOpenTimer, clearCloseTimer, clearAim]
  );

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (popup.current?.matches(':hover') || isHoverCardEngaged(popup.current)) return;
      setOpenState(false);
    }, closeDelay);
  }, [clearCloseTimer, closeDelay, setOpenState]);

  const handleRowEnter = useCallback(
    (key: string, activate: () => void) => {
      clearCloseTimer();
      if (openRef.current && (!delaySwitch || key === activeKey)) {
        activate();
        return;
      }
      if (openTimer.current === null) {
        openTimer.current = window.setTimeout(() => {
          openTimer.current = null;
          activate();
          setOpenState(true);
        }, openDelay);
      }
    },
    [activeKey, clearCloseTimer, delaySwitch, openDelay, setOpenState]
  );

  const getRowHoverProps = useCallback(
    (key: string, onActivate?: (element: HTMLElement) => void): HoverCardRowProps => {
      const enter = (event: React.MouseEvent<HTMLElement>) => {
        const element = event.currentTarget;
        const { clientX: x, clientY: y } = event;
        const activate = () => {
          setActiveKey(key);
          onActivate?.(element);
        };
        const enterRow = () => {
          rowPointer.current = { key, x, y };
          clearAim();
          handleRowEnter(key, activate);
        };
        const triangle = aim.current;
        if (triangle && Date.now() < triangle.until) {
          const coordinate = triangle.horizontal ? x : y;
          const cross = triangle.horizontal ? y : x;
          const ratio = (coordinate - triangle.start) / (triangle.edge - triangle.start);
          const lower = triangle.cross + (triangle.min - triangle.cross) * ratio;
          const upper = triangle.cross + (triangle.max - triangle.cross) * ratio;
          if (ratio > 0 && ratio <= 1 && cross >= lower && cross <= upper) {
            if (deferred.current !== null) window.clearTimeout(deferred.current);
            deferred.current = window.setTimeout(enterRow, triangle.until - Date.now());
            clearCloseTimer();
            return;
          }
        }
        enterRow();
      };
      return {
        onMouseEnter: enter,
        onMouseMove: (event) => {
          if (deferred.current !== null) enter(event);
          else rowPointer.current = { key, x: event.clientX, y: event.clientY };
        },
        onMouseLeave: () => {
          clearOpenTimer();
          if (deferred.current !== null) { window.clearTimeout(deferred.current); deferred.current = null; }
          const point = rowPointer.current;
          if (safeTriangle && openRef.current && activeKey === key && point?.key === key && popup.current) {
            const box = popup.current.getBoundingClientRect();
            const side = popup.current.dataset.side;
            const horizontal = side !== 'bottom' && side !== 'top';
            const start = horizontal ? point.x : point.y;
            const cross = horizontal ? point.y : point.x;
            const from = horizontal ? box.left : box.top;
            const to = horizontal ? box.right : box.bottom;
            // Mouseleave reports the new coordinates, which can already be over a neighboring row.
            aim.current = { horizontal, start, cross, edge: start <= from ? from : to,
              min: (horizontal ? box.top : box.left) - 4, max: (horizontal ? box.bottom : box.right) + 4,
              until: Date.now() + closeDelay };
          }
          scheduleClose();
        },
      };
    },
    [activeKey, clearAim, clearCloseTimer, clearOpenTimer, closeDelay, handleRowEnter, safeTriangle, scheduleClose],
  );

  const popupHoverProps: HoverCardRowProps = {
    onMouseEnter: () => { clearAim(); clearCloseTimer(); },
    onMouseLeave: scheduleClose,
  };

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        clearAim();
        clearOpenTimer();
        clearCloseTimer();
      }
      setOpenState(next);
    },
    [clearOpenTimer, clearCloseTimer, clearAim, setOpenState]
  );

  const close = useCallback(() => {
    clearAim();
    clearOpenTimer();
    clearCloseTimer();
    setOpenState(false);
  }, [clearOpenTimer, clearCloseTimer, clearAim, setOpenState]);

  const show = useCallback((key: string) => {
    clearAim();
    clearOpenTimer();
    clearCloseTimer();
    setActiveKey(key);
    setOpenState(true);
  }, [clearAim, clearCloseTimer, clearOpenTimer, setOpenState]);
  return { open, activeKey, getRowHoverProps, popupHoverProps, popupRef, handleOpenChange, close, show };
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface HoverCardProps {
  /** Popover anchor — the element the card is positioned relative to. */
  anchor: HTMLElement | null;
  /** The parent list's own popup element, used to exclude it from
   * `isEventInsideInteractiveLayer` checks so the card doesn't eat the list's
   * own dismissal events. */
  ownPopup?: HTMLElement | null;
  controller: HoverCardController;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  id?: string;
  initialFocus?: React.ComponentProps<typeof Popover.Content>['initialFocus'];
}

/**
 * A shared detail card anchored beside a list popup.
 *
 * Wraps `PopoverContent` and applies `data-hover-card` so that
 * `isEventInsideInteractiveLayer` can detect focus/click events inside it.
 * Cancels its own close when interactions occur inside nested portals (e.g.
 * inner selects), and forwards `popupHoverProps` to maintain the keep-open
 * timing while the pointer is on the card.
 */
export function HoverCard({
  anchor,
  ownPopup,
  controller,
  children,
  side = 'right',
  align = 'start',
  sideOffset = 8,
  className,
  id,
  initialFocus = false,
}: HoverCardProps) {
  const { open, popupHoverProps, handleOpenChange } = controller;

  const onOpenChange = useCallback(
    (next: boolean, eventDetails: PopoverRootChangeEventDetails) => {
      if (!next && isEventInsideInteractiveLayer(eventDetails.event, ownPopup ?? null)) {
        eventDetails.cancel();
        return;
      }
      handleOpenChange(next);
    },
    [ownPopup, handleOpenChange]
  );

  if (!anchor) return null;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Content
        {...{ [HOVER_CARD_ATTR]: '' }}
        id={id}
        ref={controller.popupRef}
        initialFocus={initialFocus}
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={className ?? hoverCardDefault}
        onMouseEnter={popupHoverProps.onMouseEnter}
        onMouseLeave={popupHoverProps.onMouseLeave}
      >
        {children}
      </Popover.Content>
    </Popover.Root>
  );
}
