import { cn } from '@/lib/cn'
import './illustration.css'

export type IllustrationName = 'add-contact' | 'join-group' | 'new-task' | 'no-requests' | 'no-match'
  | 'no-notifications' | 'no-agents' | 'no-tasks' | 'feedback-thanks' | 'no-messages'

/** A decorative ink drawing for an empty page (aria-hidden). Size it with a width class; the height follows the drawing. */
export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  return <div aria-hidden data-illustration={name} className={cn('gg-illustration shrink-0', className)} />
}
