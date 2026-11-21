import type { ComponentProps } from 'react'
import type { LiveNotice } from '../../apps/desktop/src/lib/notices'

/**
 * For component tests about what a live card says and does: `LiveNotice` draws its title and content in place instead of
 * through sonner (which renders a task later). The real host is covered by the browser notice tests.
 * Use: vi.mock('@/lib/notices', async (original) => (await import('<support>/inlineLiveNotice')).withInlineLiveNotice(await original<object>()))
 */
export function withInlineLiveNotice<T extends object>(notices: T): T {
  return {
    ...notices,
    LiveNotice: ({ title, description }: ComponentProps<typeof LiveNotice>) => <div data-live-notice>{title}{description}</div>,
  }
}
