/**
 * Chromium arguments for the headless observer browser that fixtures point at their own loopback page.
 * Single source for every fixture that spawns it (each caller spawns and subscribes to the child's own 'error' itself):
 * `--use-mock-keychain` keeps Chrome for Testing off the macOS login keychain (its "Chrome Safe Storage" lookup blocks
 * forever when no keychain prompt can be shown, e.g. from an ssh session, so the page is never requested); Playwright passes
 * the same switch. It has no effect elsewhere.
 */
export function headlessViewerArgs(userDataDir: string, url: string): string[] {
  return ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--use-mock-keychain',
    `--user-data-dir=${userDataDir}`, url];
}
