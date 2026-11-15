# Controlled composer geometry fixture

This renders the actual recovery button, composer, native appearance, and composer-slot classes. Two independent portals reproduce the task page's ordering. The scheduled tray uses the production tray markup/style constants with explicit controlled text; it is not a real task or schedule. The queued variant renders the real composer queue. No account is supplied, and the page's CSP blocks backend connections.

Build from the repository with its pinned Node/pnpm:

```sh
pnpm exec vite build --config tests/fixtures/composer-band-scroll/vite.config.ts --outDir /tmp/composer-band-fixture
pnpm exec vite preview --config tests/fixtures/composer-band-scroll/vite.config.ts --outDir /tmp/composer-band-fixture --host 127.0.0.1 --port 4185 --strictPort
```

Use the allocated instance gate for a live preview. Open the loopback URL in the approved isolated Electron surface; do not change web security or use a real task profile. Capture scheduled, no-band, and queued variants. The recovery button increments a local click counter; it does not act on a task. The label, theme and width controls make the case explicit in screenshots.

Browser regression:

```sh
pnpm exec vitest run --project session-browser apps/desktop/src/session/renderer/tests/browser/composer-scroll-button-bands.test.tsx
```

DOM geometry and hit testing are controlled evidence. If a genuine task identity is unavailable, report the real task-page window as **unverified: missing task identity**. A fixture screenshot is never a genuine task-session screenshot.
