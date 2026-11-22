import type { ComponentProps } from 'react'
import type { LiveNotice as Real } from '../../apps/desktop/src/components/LiveNotice'

/**
 * For component tests about what a live card says and does: `LiveNotice` draws its title and content in place instead of
 * through sonner (which renders a task later). The real host is covered by the browser notice tests.
 * Use: vi.mock('@/components/LiveNotice', () => import('<support>/inlineLiveNotice'))
 */
export function LiveNotice({ title, description }: ComponentProps<typeof Real>) {
  return <div data-live-notice>{title}{description}</div>
}
