import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The in-app notice contract (owner 11-22, scheme B): one outlet (lib/notices `notify` / `useNotice`), one host
// (components/NoticeHost.tsx), two positions decided only by a notice's lifetime — transient → the toast strip above the
// composer (--z-toast); persistent → the one deck at the top-right, under every dialog (--z-notice), which defers into the
// bell. Nothing else draws, places or layers a notice. The sign-in-lost bar is page state, not a notice (owner 11-22 kept it).
// The sonner import gate lives in .eslintrc.cjs; this file pins what eslint cannot see.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const guide = 'Show notices through lib/notices (notify / useNotice). Do not draw, position or layer a notice of your own.';

function sources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'tests', 'test', '__tests__', 'dist', 'dist-electron'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.d\.ts$|\.(test|spec|stories)\./.test(entry.name) ? [path] : [];
  });
}
const files = ['apps/desktop/src', 'apps/desktop/electron', ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}/src`)]
  .flatMap((directory) => sources(join(root, directory)))
  .map((file) => ({ path: relative(root, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }));
const matching = (pattern: RegExp) => files.filter((file) => pattern.test(file.text)).map((file) => file.path).sort();

describe('notice outlets', () => {
  it('only the host layers notices: --z-toast, --z-notice and sonner DOM belong to it', () => {
    expect(matching(/--z-toast\b/), guide).toEqual(['apps/desktop/src/components/notice-host.css', 'apps/desktop/src/styles/tokens.css']);
    expect(matching(/--z-notice\b/), guide).toEqual(['apps/desktop/src/components/NoticeHost.tsx', 'apps/desktop/src/components/notice-host.css',
      'apps/desktop/src/lib/notices.tsx', 'apps/desktop/src/styles/tokens.css']);
    // The one remaining fixed bar on its own layer: sign-in lost (page state that blocks writes; owner 11-22 kept it as is).
    expect(matching(/--z-banner\b/), guide).toEqual(['apps/desktop/src/components/SessionExpiredNotice.tsx', 'apps/desktop/src/styles/tokens.css']);
    // The host's own place (notice-host-position.ts reads it again when a notice appears) and the embedded browser page,
    // which reads where a toast is (a native view must not paint over it): readers, not drawers.
    expect(matching(/data-sonner-|<Toaster\b/), guide).toEqual(['apps/desktop/src/components/NoticeHost.tsx', 'apps/desktop/src/components/notice-host-position.ts',
      'apps/desktop/src/components/notice-host.css', 'apps/desktop/src/session/renderer/features/browser/browser-page-occlusion.ts']);
  });

  it('the host is mounted once per document: the main app (ToastProvider), and the session page when it is its own document', () => {
    expect(matching(/<NoticeHost\b/), guide).toEqual(['apps/desktop/src/components/Toast.tsx', 'apps/desktop/src/session/renderer/app/workspace.tsx']);
  });

  it('no alert / status box places itself: a fixed element that announces is a notice, and notices go through the outlet', () => {
    // An element is flagged when one JSX opening tag both announces (role alert/status/alertdialog, aria-live) and is
    // fixed-positioned (class `fixed` or style position fixed). Anchored popovers and in-flow rows are not caught.
    const tag = /<[A-Za-z][^<>]*?(?:role=["'{](?:alert|status|alertdialog)|aria-live=)[^<>]*>/gs;
    const fixed = /\bfixed\b|position:\s*['"]fixed['"]/;
    const offenders = files.filter((file) => file.path.endsWith('.tsx'))
      .flatMap((file) => [...file.text.matchAll(tag)].filter((match) => fixed.test(match[0])).map(() => file.path));
    // Sign-in lost is page state, not a notice: owner 11-22 kept its full-width bar.
    expect(offenders, guide).toEqual(['apps/desktop/src/components/SessionExpiredNotice.tsx']);
  });
});
