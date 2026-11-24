import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { PAGE_MODAL_FRAME, Sheet } from '@/components/ui/Sheet'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'
import { Popover } from '@/components/ui/Popover'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

// A page modal (Contacts, the Apps page, an App's page) sits at --z-settings. Every portaled layer opened inside it — a
// menu, a popover — follows the one stacking rule (useUiPopupZIndex): above the surface it was opened from. Before it, the
// contacts「+」menu opened at --z-menu under the modal: shown, but the modal took every click (PR #3685 Web E2E).

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const onTop = (element: HTMLElement) => {
  const box = element.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return !!hit && element.contains(hit)
}

it('a menu opened inside a page modal is drawn above the modal and takes the click', async () => {
  harness = createReactHarness()
  await harness.render(
    <Sheet onClose={() => {}} {...PAGE_MODAL_FRAME} testId="modal">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger data-testid="open-menu">open</DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <MenuItem data-testid="menu-item" onClick={() => {}}>Add contact</MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Sheet>,
  )
  await page.getByTestId('open-menu').click()
  const item = () => document.querySelector<HTMLElement>('[data-testid="menu-item"]')
  await until('the menu item is laid out', () => (item()?.getBoundingClientRect().width ?? 0) > 0)
  expect(onTop(item()!), 'the menu item takes the click, not the modal under it').toBe(true)
})

it('a popover opened inside a page modal is drawn above the modal', async () => {
  harness = createReactHarness()
  await harness.render(
    <Sheet onClose={() => {}} {...PAGE_MODAL_FRAME} testId="modal">
      <Popover.Root open>
        <Popover.Trigger data-testid="anchor">anchor</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner>
            <Popover.Popup data-testid="popover">popover</Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </Sheet>,
  )
  const popup = () => document.querySelector<HTMLElement>('[data-testid="popover"]')
  await until('the popover is laid out', () => (popup()?.getBoundingClientRect().width ?? 0) > 0)
  expect(onTop(popup()!)).toBe(true)
})
