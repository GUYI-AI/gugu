import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { NoticeHost } from '@/components/NoticeHost'
import { PlatformCopyButton } from '@/components/markdown/PlatformCopyButton'
import { notifyCopied } from '@/lib/copyFeedback'
import { dismissNotice } from '@/lib/notices'
import { platform } from '@/platform'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { dismissNotice('clipboard-copy'); harness?.cleanup(); vi.restoreAllMocks() })

it('shows the copy hint in the one notice stack, 8px above the composer, and removes it automatically', async () => {
  await page.viewport(390, 844)
  harness = createReactHarness()
  await renderWithAppProviders(harness, <><NoticeHost /><div data-testid="input" data-slot="composer" style={{ position: 'fixed', bottom: 0, height: 100, width: '100%' }}>Input</div></>)
  await act(async () => { notifyCopied('已复制') })
  const hint = () => document.querySelector<HTMLElement>('[data-sonner-toast]')
  await until('copy confirmation mounts', () => !!hint())
  const rect = hint()!.getBoundingClientRect(), input = harness.container.querySelector<HTMLElement>('[data-testid="input"]')!.getBoundingClientRect()
  expect(rect.height).toBeLessThan(60)
  await until('the stack settles 8px above the composer', () => Math.abs(input.top - hint()!.getBoundingClientRect().bottom - 8) < 0.5)
  expect(getComputedStyle(hint()!).pointerEvents).toBe('none')
  await until('copy confirmation expires without input', () => !hint())
})

it('uses the existing code copy checkmark without also creating a notice', async () => {
  await page.viewport(390, 844)
  harness = createReactHarness()
  const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
  await renderWithAppProviders(harness, <><NoticeHost /><PlatformCopyButton text="exact code" kind="code" /></>)
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('button[data-streamdown]')!.click() })
  await until('copy button confirms the real host write', () => !!harness.container.querySelector('[data-copied]'))
  expect(write).toHaveBeenCalledExactlyOnceWith('exact code')
  expect(document.querySelector('[data-sonner-toast]')).toBeNull()
})
