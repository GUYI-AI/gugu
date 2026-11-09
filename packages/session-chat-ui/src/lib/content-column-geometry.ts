/** Keep the pin surface in the conversation frame, including asymmetric scrollbar gutters. */
export function syncContentColumnGeometry(
  probe: HTMLElement | undefined, scroller: HTMLElement | undefined,
  publishWidth: (width: number) => void,
  publishPinFrame: (frame: { left: number; width: number }) => void,
): void {
  if (!probe) return;
  const column = probe.getBoundingClientRect();
  if (column.width <= 0) return;
  publishWidth(column.width);
  if (!scroller) return;
  const frame = scroller.getBoundingClientRect();
  publishPinFrame({ left: frame.left - column.left, width: frame.width });
}
