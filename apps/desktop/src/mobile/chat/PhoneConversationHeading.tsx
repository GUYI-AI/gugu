import { Button } from '@/components/ui/Button'

/** The phone keeps the source room's route; its selected topic owns the displayed identity. */
export function PhoneConversationHeading({ name, sourceName, label, onOpen }: {
  name: string; sourceName?: string; label: string; onOpen: () => void
}) {
  return <div className="flex min-w-0 flex-1 flex-col">
    <Button variant="ghost" className="window-no-drag-region !min-h-0 !min-w-0 !w-full !text-[var(--fg)] !justify-start !p-0 !text-[length:var(--font-title)] !font-semibold" aria-label={label} onClick={onOpen}>
      <span className="truncate">{name}</span>
    </Button>
    {sourceName ? <span data-phone-header-source="" className="truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]">{sourceName}</span> : null}
  </div>
}
