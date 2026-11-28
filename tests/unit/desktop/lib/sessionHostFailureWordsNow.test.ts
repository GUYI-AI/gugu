// @vitest-environment jsdom
// The words a task-host connection fails with are read when it fails, not when the client is made: the web shell makes
// its client once (EmdashSessionFrame), so words fixed then stayed in the language of that moment after a switch.
import { afterEach, expect, it } from 'vitest'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'
import { createSessionHostClient, type SessionHostPipeOpener } from '../../../../apps/desktop/src/session/shared/lib/ipc/session-host-client'

afterEach(() => setLocalePreference('system'))

it('a client made once says its failure in the language of the moment it fails', async () => {
  setLocalePreference('en-US')
  const never = (() => new Promise(() => {})) as unknown as SessionHostPipeOpener
  // The web shell's messages, as it hands them (a function: read at each failure).
  const client = createSessionHostClient(never, {
    isReachable: () => false,
    messages: () => ({ hostNotConnected: i18n.t('shell.taskFrame.hostNotConnected', { ns: 'main' }) }),
  })
  const english = i18n.t('shell.taskFrame.hostNotConnected', { ns: 'main', lng: 'en-US' })
  const chinese = i18n.t('shell.taskFrame.hostNotConnected', { ns: 'main', lng: 'zh-CN' })
  expect(english).not.toBe(chinese)
  await expect(client.connect()).rejects.toThrow(english)
  setLocalePreference('zh-CN')
  await expect(client.connect()).rejects.toThrow(chinese)
  client.close()
})
