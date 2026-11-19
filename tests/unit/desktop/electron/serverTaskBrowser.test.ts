import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createServerTaskBrowser, taskBrowserArguments, taskBrowserUserAgent } from '../../../../apps/desktop/electron/server/server-task-browser'

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }))

describe('a Gugu server task browser (#1607 4b)', () => {
  it('announces Chrome, not HeadlessChrome, in the reduced user-agent form', () => {
    expect(taskBrowserUserAgent('Google Chrome for Testing 155.0.8059.12 \n', 'linux'))
      .toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36')
    expect(() => taskBrowserUserAgent('not a browser')).toThrow('Cannot read the task browser version')
  })

  it('runs new headless over a pipe, in the account profile, never on a display or a debugging port', () => {
    const args = taskBrowserArguments('/profile', 'UA', false)
    expect(args).toContain('--headless=new')
    expect(args).toContain('--remote-debugging-pipe')
    expect(args).toContain('--user-data-dir=/profile')
    expect(args).toContain('--user-agent=UA')
    expect(args.some(arg => arg.startsWith('--remote-debugging-port'))).toBe(false)
    expect(args).not.toContain('--no-sandbox')
    expect(taskBrowserArguments('/profile', 'UA', true)).toContain('--no-sandbox')
  })

  it('without a browser binary, a lease says what the server is missing', async () => {
    const browser = createServerTaskBrowser({ binary: () => null, profile: '/unused', log: { info: vi.fn(), warn: vi.fn() } })
    await expect(browser.pageFor('task', undefined, new AbortController().signal)).rejects.toThrow('needs Chrome or Chromium')
  })

  it('keeps system credential storage for desktop profiles without changing the server default', () => {
    const desktop = taskBrowserArguments('/isolated-desktop-profile', 'UA', false, 'system')
    expect(desktop).toContain('--user-data-dir=/isolated-desktop-profile')
    expect(desktop).not.toContain('--password-store=basic')
    expect(desktop).not.toContain('--use-mock-keychain')
    expect(taskBrowserArguments('/server-profile', 'UA', false)).toEqual(expect.arrayContaining(['--password-store=basic', '--use-mock-keychain']))
  })

  // Opt-in: GUGU_TEST_CHROME=/path/to/chrome. The shared page protocol drives the server's real page.
  it.skipIf(!process.env.GUGU_TEST_CHROME)('a task keeps one real page; the shared page protocol drives it and sees iframes', { timeout: 60_000 }, async () => {
    const { createPageProtocol } = await import('../../../../apps/desktop/electron/session/main/core/browser/page-protocol')
    const profile = await mkdtemp(path.join(tmpdir(), 'task-browser-'))
    const pages: Record<string, string> = {
      '/first': '<title>first</title>',
      '/inner': '<p>in</p>',
      '/field': '<title>Field</title><form action="/sent"><input autofocus id=f name=q></form>',
      '/sent?q=typed+there': '<title>Sent</title>',
    }
    const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(pages[request.url ?? ''] ?? '') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // A cross-site frame runs out of process: it is its own target, which the lease must attach.
    pages['/form'] = `<title>Form</title><iframe src="http://localhost:${(server.address() as AddressInfo).port}/inner"></iframe>`
    const browser = createServerTaskBrowser({ binary: () => process.env.GUGU_TEST_CHROME!, profile, log: { info: vi.fn(), warn: vi.fn() } })
    try {
      const signal = new AbortController().signal
      const page = await browser.pageFor('task-1', `${site}/first`, signal)
      expect(await browser.pageFor('task-1', undefined, signal)).toBe(page)
      expect(await browser.pageFor('task-2', undefined, signal)).not.toBe(page)

      const protocol = createPageProtocol(page as unknown as WebContents)
      const events: string[] = []
      protocol.onMessage(method => events.push(method))
      await protocol.maintain!('Page.enable')
      await protocol.maintain!('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      await protocol.send('Page.navigate', { url: `${site}/form` })
      await vi.waitFor(() => expect(events).toContain('Target.attachedToTarget'), { timeout: 10_000 })
      const ua = await protocol.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }) as { result: { value: string } }
      expect(ua.result.value).toMatch(/Chrome\/\d+\.0\.0\.0/)
      expect(ua.result.value).not.toMatch(/Headless/)
      await expect(protocol.send('Target.createTarget', { url: 'about:blank' })).rejects.toThrow()
      protocol.close('lease ended')
      // The task's page survives the lease; a new lease drives the same page.
      expect(page.isDestroyed()).toBe(false)
      const again = createPageProtocol(page as unknown as WebContents)
      const title = await again.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }) as { result: { value: string } }
      expect(title.result.value).toBe('Form')

      // The shared navigation guard sees the server page too: a local document ends the lease.
      const ended = new Promise<string>(resolve => again.onClose(resolve))
      await again.send('Runtime.evaluate', { expression: `location.href = URL.createObjectURL(new Blob(['<p>local</p>'], { type: 'text/html' }))` }).catch(() => {})
      expect(await ended).toBe('page protocol: unsupported navigation URL')

      // #1607 node 5: the person on another computer sees it painted and types into it directly.
      const other = createPageProtocol((await browser.pageFor('task-2', undefined, signal)) as unknown as WebContents);
      await other.send('Page.navigate', { url: `${site}/field` });
      await vi.waitFor(async () => expect((await other.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }) as { result: { value: string } }).result.value).toBe('Field'));
      await other.send('Runtime.evaluate', { expression: 'document.getElementById("f").focus()' });
      const screen = (await browser.existingPage('task-2'))!;
      const frames: { data: string; width: number; height: number }[] = [];
      await screen.startScreen(frame => frames.push(frame));
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 10_000 });
      expect(Buffer.from(frames[0]!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frames[0]!.width).toBeGreaterThan(0);
      await screen.input('Input.insertText', { text: 'typed there' });
      expect((await other.send('Runtime.evaluate', { expression: 'document.getElementById("f").value', returnByValue: true }) as { result: { value: string } }).result.value).toBe('typed there');
      // Enter, as the person presses it there, submits the form.
      const { taskPageInput } = await import('../../../../apps/desktop/electron/session/main/core/browser/task-page-screen');
      const keys = { buttons: new Set<'left' | 'middle' | 'right'>(), keys: new Set<string>() };
      for (const action of ['down', 'up'] as const) {
        for (const command of taskPageInput({ kind: 'key', action, key: 'Enter' }, frames[0]!, keys)) await screen.input(command.method, command.params);
      }
      await vi.waitFor(async () => expect((await other.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }) as { result: { value: string } }).result.value).toBe('Sent'), { timeout: 10_000 });
      // The toolbar there: where the page is now, and back / the tab's size applied to it.
      await vi.waitFor(() => expect(screen.state()).toMatchObject({ url: `${site}/sent?q=typed+there`, title: 'Sent', canGoBack: true, canGoForward: false }), { timeout: 10_000 });
      await screen.control({ action: 'back' });
      await vi.waitFor(() => expect(screen.state()).toMatchObject({ title: 'Field', canGoForward: true }), { timeout: 10_000 });
      await screen.control({ action: 'resize', width: 640, height: 480, scale: 2 });
      const fitted = await other.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight, devicePixelRatio].join()', returnByValue: true }) as { result: { value: string } };
      expect(fitted.result.value).toBe('640,480,2');
      await expect(screen.control({ action: 'navigate', url: 'file:///etc/hostname' })).rejects.toThrow('Only web pages');
      other.close('done');
      await screen.stopScreen();
      expect(await browser.existingPage('task-without-page')).toBeNull();

      await browser.closeTask('task-1')
      expect(page.isDestroyed()).toBe(true)
    } finally {
      await browser.dispose()
      server.close()
      await rm(profile, { recursive: true, force: true })
    }
  })
})

// Local opt-in coverage for #2914. No account, App install, model call or GUI.
it.skipIf(!process.env.GUGU_TEST_CHROME)('real static-page capture feedback belongs to confirmed dispatch and the current target', { timeout: 60_000 }, async () => {
  const { leasePageProtocol } = await import('../../../../apps/desktop/electron/session/main/core/browser/leased-page-protocol')
  const { browserPageFeedback } = await import('../../../../apps/desktop/src/session/shared/browser-page-feedback')
  const profile = await mkdtemp(path.join(tmpdir(), 'feedback-capture-'))
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    const next = request.url === '/next'
    response.end(`<title>${next ? 'feedback next fixture' : 'feedback fixture'}</title><p>Static page</p>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const browser = createServerTaskBrowser({ binary: () => process.env.GUGU_TEST_CHROME!, profile, log: { info: vi.fn(), warn: vi.fn() } })
  let lease: ReturnType<typeof leasePageProtocol> | undefined
  let screen: Awaited<ReturnType<typeof browser.existingPage>> | undefined
  try {
    const page = await browser.pageFor('feedback-task', site, new AbortController().signal)
    lease = leasePageProtocol(page as unknown as WebContents, {
      ready: Promise.resolve(), capture: params => page.debugger.sendCommand('Page.captureScreenshot', params),
    })
    const call = new AbortController()
    const feedback = browserPageFeedback(page)
    screen = (await browser.existingPage('feedback-task'))!
    const frames: import('../../../../apps/desktop/electron/server/server-task-browser').TaskPageScreenFrame[] = []
    await screen.startScreen(frame => frames.push(frame))
    await lease.protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 24, y: 36 }, undefined, call.signal)
    await vi.waitFor(() => expect(feedback.snapshot()).toMatchObject({ cursor: { x: 24, y: 36 }, action: { phase: 'running' } }))
    const callId = feedback.snapshot().action!.id
    await vi.waitFor(() => expect(frames.at(-1)?.feedback).toMatchObject({
      target: feedback.snapshot().target, cursor: { x: 24, y: 36 }, action: { id: callId, phase: 'running' },
    }), { timeout: 10_000 })
    const painted = frames.at(-1)!
    expect(Buffer.from(painted.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(painted.width).toBeGreaterThan(24)
    expect(painted.height).toBeGreaterThan(36)
    call.abort()
    await vi.waitFor(() => {
      const finished = frames.at(-1)?.feedback
      expect(finished).toMatchObject({ target: painted.feedback!.target, cursor: { x: 24, y: 36 } })
      expect(finished!.action).toBeUndefined()
    })
    const beforeNavigationSnapshot = feedback.snapshot()
    const target = beforeNavigationSnapshot.target
    const beforeNavigation = frames.length
    await lease.protocol.send('Page.navigate', { url: `${site}/next` })
    await vi.waitFor(() => expect(page.getURL()).toBe(`${site}/next`))
    await vi.waitFor(async () => {
      const title = await lease!.protocol.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }) as { result: { value: string } }
      expect(title.result.value).toBe('feedback next fixture')
    })
    await vi.waitFor(() => expect(feedback.snapshot().target.revision).toBeGreaterThan(target.revision))
    // An absent frame decoration is not evidence that the host removed its old pointer.
    const afterNavigationSnapshot = feedback.snapshot()
    const nextTarget = afterNavigationSnapshot.target
    const assertHostPointerCleared = (snapshot: ReturnType<typeof feedback.snapshot>) => {
      expect(snapshot.target).toEqual(nextTarget)
      expect(snapshot.cursor).toBeUndefined()
    }
    assertHostPointerCleared(afterNavigationSnapshot)
    // Negative oracle input only: do not write the model or manufacture a picture.
    expect(() => assertHostPointerCleared({ ...afterNavigationSnapshot, cursor: beforeNavigationSnapshot.cursor })).toThrow()
    await vi.waitFor(() => {
      expect(frames.at(-1)?.feedback).toMatchObject({ target: nextTarget })
      expect(frames.at(-1)!.feedback!.cursor).toBeUndefined()
    }, { timeout: 10_000 })
    const undecoratedNavigationFrame = frames.at(-1)!
    const nextCall = new AbortController()
    await lease.protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 48, y: 72 }, undefined, nextCall.signal)
    await vi.waitFor(() => expect(feedback.snapshot()).toMatchObject({ cursor: { x: 48, y: 72 }, action: { phase: 'running' } }))
    const nextCallId = feedback.snapshot().action!.id
    const assertCurrentPicture = (frame: typeof painted | undefined) => {
      expect(frame?.feedback).toMatchObject({
        target: nextTarget, cursor: { x: 48, y: 72 }, action: { id: nextCallId, phase: 'running' },
      })
    }
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(beforeNavigation)
      // Positive current-target evidence: absent feedback or the old pointer cannot satisfy this.
      assertCurrentPicture(frames.at(-1))
    }, { timeout: 10_000 })
    // Both negative controls use real pictures captured by this same browser.
    expect(() => assertCurrentPicture(undecoratedNavigationFrame)).toThrow()
    expect(() => assertCurrentPicture(painted)).toThrow()
    nextCall.abort()
  } finally {
    await screen?.stopScreen()
    await lease?.cleanup()
    lease?.protocol.close('feedback fixture ended')
    await browser.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(profile, { recursive: true, force: true })
  }
})
