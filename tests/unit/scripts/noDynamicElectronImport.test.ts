import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The server and the headless host replace `electron` through require (server-entry.ts / session-host-entry.ts).
// A dynamic import('electron') stays a native import() in the cjs build and fails there with
// "Cannot find package 'electron'"; the lint rule in .eslintrc.cjs (@@@electron-dynamic-import) stops it.
type LintMessage = { ruleId: string | null; message: string };
type Linter = { lintText(code: string, options: { filePath: string }): Promise<Array<{ messages: LintMessage[] }>> };
// eslint 8 ships no type declarations; this test needs only lintText.
const { ESLint } = createRequire(import.meta.url)('eslint') as { ESLint: new (options: { cwd: string; useEslintrc: boolean }) => Linter };
const root = fileURLToPath(new URL('../../..', import.meta.url));
const filePath = `${root}apps/desktop/electron/session/main/core/session-timeline/example.ts`;

async function ruleMessages(code: string): Promise<string[]> {
  const [result] = await new ESLint({ cwd: root, useEslintrc: true }).lintText(code, { filePath });
  return result!.messages.filter((message: LintMessage) => message.ruleId === 'no-restricted-syntax').map((message: LintMessage) => message.message);
}

describe('no dynamic electron import', () => {
  it('rejects import("electron")', async () => {
    const messages = await ruleMessages("export async function dir() { const { app } = await import('electron'); return app.getPath('userData'); }\n");
    expect(messages).toEqual([expect.stringContaining("Import electron statically")]);
  });

  it('accepts the static import', async () => {
    expect(await ruleMessages("import { app } from 'electron';\nexport function dir() { return app.getPath('userData'); }\n")).toEqual([]);
  });

  it('rejects it in a renderer .tsx file too', async () => {
    const [result] = await new ESLint({ cwd: root, useEslintrc: true }).lintText(
      "export async function f() { return import('electron'); }\n",
      { filePath: `${root}apps/desktop/src/components/Example.tsx` },
    );
    expect(result!.messages.some((message: LintMessage) => message.message.includes('Import electron statically'))).toBe(true);
  });
});
