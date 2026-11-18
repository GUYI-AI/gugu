import { useState } from 'react'
import { expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { ExternalHistoryDialog } from '@/components/settings/data-import/ExternalHistoryDialog'
import '@/i18n/registerSettingsCatalog'
import '@/styles/tokens.css'

function SettingsHistoryFixture() {
  const [open, setOpen] = useState(false)
  return (
    <Sheet onClose={() => {}} zIndex="var(--z-settings)" ariaLabel="Settings">
      <Button onClick={() => setOpen(true)}>Open imported conversation</Button>
      {open && <ExternalHistoryDialog
        sessionId="fixture-history"
        initialPage={{ title: 'Imported conversation', nextOffset: null, messages: [{ role: 'user', text: 'Saved text', at: null }] }}
        onClose={() => setOpen(false)}
      />}
    </Sheet>
  )
}

it('shows imported history above Settings with a clickable close button', async () => {
  await page.viewport(1000, 750)
  const harness = createReactHarness()
  try {
    await renderWithAppProviders(harness, <SettingsHistoryFixture />)
    const open = page.getByRole('button', { name: 'Open imported conversation' })
    await open.click()
    const history = page.getByRole('dialog', { name: 'Imported conversation' })
    await expect.element(history.getByText('Saved text')).toBeVisible()
    await history.locator('footer button').click()
    await expect.element(history).not.toBeInTheDocument()
    await expect.element(open).toBeVisible()
  } finally {
    harness.cleanup()
  }
})
