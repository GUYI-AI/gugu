import { useEffect, useRef, useState, type RefObject } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { TOOLTIP_CLOSE_DELAY_MS, TOOLTIP_OPEN_DELAY_MS } from '@/styles/motion';

type Pointed = { row: HTMLElement; name: string; line: string };

const text = (node: Element | null) =>
  [...(node?.childNodes ?? [])].map((child) => child.textContent?.trim() ?? '').filter(Boolean).join(' ');

/**
 * On the rail a row is only its avatar, so pointing at one says what the row itself says when the list is open: its name
 * and its second line (ListRow's title and subtitle, read from the row). One hint for the whole list, whoever drew the row
 * (a chat, a project, the sample), in the product's own tooltip. The first one waits as every tooltip does; moving on to
 * the next row changes it at once.
 */
export function RailRowHint({ list, enabled }: { list: RefObject<HTMLElement | null>; enabled: boolean }) {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const shown = useRef<Pointed | null>(null);
  const open = pointed !== null;
  if (pointed) shown.current = pointed;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const element = list.current;
    if (!element || !enabled) return;
    let timer: number | undefined;
    const point = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>('[data-slot="list-row"]') : null;
      const name = row ? text(row.querySelector('.gg-list-row-title')) : '';
      const next = row && name ? { row, name, line: text(row.querySelector('.gg-list-row-subtitle')) } : null;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPointed(next), next ? (openRef.current ? 0 : TOOLTIP_OPEN_DELAY_MS) : TOOLTIP_CLOSE_DELAY_MS);
    };
    const over = (event: PointerEvent) => point(event.target);
    const away = () => point(null);
    element.addEventListener('pointerover', over);
    element.addEventListener('pointerleave', away);
    element.addEventListener('pointerdown', away);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener('pointerover', over);
      element.removeEventListener('pointerleave', away);
      element.removeEventListener('pointerdown', away);
      setPointed(null);
    };
  }, [list, enabled]);
  const hint = shown.current;
  return (
    <Tooltip.Root open={open} onOpenChange={(next) => { if (!next) setPointed(null); }}>
      <Tooltip.Portal>
        <Tooltip.Positioner anchor={hint?.row} side="right" sideOffset={8} collisionPadding={8}>
          <Tooltip.Popup className="max-w-60" data-rail-row-hint="">
            <div className="truncate font-medium">{hint?.name}</div>
            {hint?.line ? <div className="truncate text-[var(--muted-fg)]">{hint.line}</div> : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
