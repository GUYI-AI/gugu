import { cn } from '../../lib/utils'

/**
 * @@@unknown-slot — what a surface draws where a value goes while its read model is `unknown` (lib/readModel.ts).
 * A static neutral bar the size of the value it stands for: no pulse, no text, nothing that could be read as a value
 * (a switch drawn off, a 0, "none", a raw id). It takes the value's place at once (one line tall by default) but shows
 * only after 150 ms (`.gg-unknown` in tokens.css): a read that answers sooner leaves nothing drawn in between. Size it at
 * the call site so the value lands without moving anything.
 */
export function Unknown({ className }: { className?: string }) {
  return <span aria-busy="true" data-unknown="" className={cn('gg-unknown inline-block h-[1lh] w-16 rounded-[var(--radius-control)] bg-muted align-top', className)} />
}
