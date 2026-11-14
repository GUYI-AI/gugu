import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { privateLoginRequestAllowed } from '../../../../apps/desktop/electron/server/server-private-login'
import { assertCredentialWebsite } from '../../../../apps/desktop/electron/session/main/core/browser/credential-website'

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }))

const origin = 'https://site.example'
const page = (url: string, extra: Record<string, unknown> = {}) => ({ requestId: 'r', request: { url, method: 'GET' }, resourceType: 'Image', frameId: 'main', ...extra })
const post = (url: string, extra: Record<string, unknown> = {}) => page(url, { request: { url, method: 'POST', hasPostData: true }, resourceType: 'Document', ...extra })

describe('a server password login: pinned network (「本机送」)', () => {
  const armed = { mainFrame: 'main', submission: `${origin}/session`, submitted: false }
  it('lets the site load and refuses every other site', () => {
    expect(privateLoginRequestAllowed(page(`${origin}/login`), armed, assertCredentialWebsite, origin).allow).toBe(true)
    expect(privateLoginRequestAllowed(page('https://tracker.example/pixel'), armed, assertCredentialWebsite, origin).allow).toBe(false)
    expect(privateLoginRequestAllowed(page('http://site.example/login'), armed, assertCredentialWebsite, origin).allow).toBe(false)
  })
  it('refuses a frame inside the login page', () => {
    expect(privateLoginRequestAllowed(page(`${origin}/frame`, { resourceType: 'Document', frameId: 'child' }), armed, assertCredentialWebsite, origin).allow).toBe(false)
  })
  it('lets exactly one body through: the form submission, from the main frame, once', () => {
    expect(privateLoginRequestAllowed(post(`${origin}/session`), { ...armed, submission: null }, assertCredentialWebsite, origin).allow).toBe(false)
    expect(privateLoginRequestAllowed(post(`${origin}/elsewhere`), armed, assertCredentialWebsite, origin).allow).toBe(false)
    expect(privateLoginRequestAllowed(post(`${origin}/session`, { resourceType: 'XHR' }), armed, assertCredentialWebsite, origin).allow).toBe(false)
    expect(privateLoginRequestAllowed(post(`${origin}/session`, { frameId: 'child' }), armed, assertCredentialWebsite, origin).allow).toBe(false)
    expect(privateLoginRequestAllowed(post(`${origin}/session`), armed, assertCredentialWebsite, origin)).toEqual({ allow: true, submits: true })
    // A 307/308 replays the body: a second body request.
    expect(privateLoginRequestAllowed(post(`${origin}/session`), { ...armed, submitted: true }, assertCredentialWebsite, origin).allow).toBe(false)
  })

  // Opt-in: GUGU_TEST_CHROME=/path/to/chrome, and the network. A real headless Chrome logs in to a public demo site.
  it.skipIf(!process.env.GUGU_TEST_CHROME)('logs in from a private context; the task page gets the site cookies, nothing else', { timeout: 120_000 }, async () => {
    const { createServerTaskBrowser } = await import('../../../../apps/desktop/electron/server/server-task-browser')
    const profile = await mkdtemp(path.join(tmpdir(), 'private-login-'))
    const browser = createServerTaskBrowser({ binary: () => process.env.GUGU_TEST_CHROME!, profile, log: { info: () => {}, warn: () => {} } })
    try {
      const site = 'https://the-internet.herokuapp.com'
      const task = await browser.pageFor('task', 'about:blank', new AbortController().signal)
      const selection = { form: '#login', account: '#username', password: '#password' }
      const wrong = await browser.privateLogin('task', { url: `${site}/login`, origin: site, selection, account: 'tomsmith', password: 'not-the-password',
        signal: new AbortController().signal, timeouts: { confirmMs: 8_000 } })
      expect(wrong).toEqual({ status: 'person_interaction_required', cookies: 0 })
      const right = await browser.privateLogin('task', { url: `${site}/login`, origin: site, selection, account: 'tomsmith', password: 'SuperSecretPassword!',
        signal: new AbortController().signal })
      expect(right.status).toBe('submitted_unconfirmed')
      expect(right.cookies).toBeGreaterThan(0)
      // The task page (normal context) is now signed in.
      const { createPageProtocol } = await import('../../../../apps/desktop/electron/session/main/core/browser/page-protocol')
      const lease = createPageProtocol(task as never)
      await lease.send('Page.navigate', { url: `${site}/secure` })
      let text = ''
      for (let i = 0; i < 50 && !text.includes('Secure Area'); i++) {
        await new Promise(resolve => setTimeout(resolve, 200))
        text = ((await lease.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true })) as { result: { value: string } }).result.value
      }
      expect(text).toContain('Secure Area')
      // The private context is gone: the Agent's lease cannot list or reach other targets.
      await expect(lease.send('Target.getTargets')).rejects.toThrow()
      lease.close()
    } finally {
      await browser.dispose()
      await rm(profile, { recursive: true, force: true })
    }
  })
})
