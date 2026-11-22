import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The in-app notice contract (owner 11-22, scheme A): one outlet (lib/notices `notify` / `useNotice`), one host
// (components/NoticeHost.tsx), two positions decided only by a notice's lifetime — transient → the toast strip above the
// composer, persistent → the one banner slot on top of the content column. Nothing else draws, places or layers a notice.
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
  it('only the host layers the toast strip: --z-toast and sonner DOM belong to it, --z-banner no longer exists', () => {
    expect(matching(/--z-toast\b/), guide).toEqual(['apps/desktop/src/components/notice-host.css', 'apps/desktop/src/styles/tokens.css']);
    expect(matching(/--z-banner\b/), guide).toEqual([]);
    // The embedded browser page reads where a toast is (a native view must not paint over it): a reader, not a drawer.
    expect(matching(/data-sonner-|<Toaster\b/), guide).toEqual(['apps/desktop/src/components/NoticeHost.tsx', 'apps/desktop/src/components/notice-host.css',
      'apps/desktop/src/session/renderer/features/browser/browser-page-occlusion.ts']);
  });

  it('the banner slot is mounted once per document: the main layout, and the session page when it is its own document', () => {
    expect(matching(/<NoticeBannerSlot\b/), guide).toEqual(['apps/desktop/src/layouts/MainLayout.tsx', 'apps/desktop/src/session/renderer/app/workspace.tsx']);
    expect(files.find((file) => file.path === 'apps/desktop/src/layouts/MainLayout.tsx')!.text.match(/<NoticeBannerSlot\b/g)).toHaveLength(1);
  });

  it('no alert / status box places itself: a fixed element that announces is a notice, and notices go through the outlet', () => {
    // An element is flagged when one JSX opening tag both announces (role alert/status/alertdialog, aria-live) and is
    // fixed-positioned (class `fixed` or style position fixed). Anchored popovers and in-flow rows are not caught.
    const tag = /<[A-Za-z][^<>]*?(?:role=["'{](?:alert|status|alertdialog)|aria-live=)[^<>]*>/gs;
    const fixed = /\bfixed\b|position:\s*['"]fixed['"]/;
    const offenders = files.filter((file) => file.path.endsWith('.tsx'))
      .flatMap((file) => [...file.text.matchAll(tag)].filter((match) => fixed.test(match[0])).map(() => file.path));
    expect(offenders, guide).toEqual([]);
  });
});
