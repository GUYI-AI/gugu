import { Button } from '@/components/ui/Button'
import { Hash } from '@/lib/icons'
import { cn } from '@/lib/cn'

/** The phone keeps the source room's route; its selected topic owns the displayed identity. */
export function PhoneConversationHeading({ name, topic = false, centered = false, label, onOpen }: {
  name: string; topic?: boolean; centered?: boolean; label: string; onOpen: () => void
}) {
  return <Button
    variant="ghost"
    className={cn('gg-phone-conversation-heading window-no-drag-region flex-1 !min-h-0 !min-w-0 !w-full !p-0 !text-[var(--fg)] !text-[length:var(--font-title)] !font-semibold', centered ? '!justify-center' : '!justify-start')}
    aria-label={label}
    onClick={onOpen}
  >
    {topic && !/^[#＃]/.test(name.trimStart()) ? <Hash className="size-4 shrink-0" aria-hidden /> : null}
    <span className="truncate">{name}</span>
  </Button>
}
