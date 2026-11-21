import { describe, expect, it } from 'vitest';
import { IMPORT_ERROR_CODES } from '@shared/core/session-import/import-error-code';
import { enUSSessionWorkflowMessages, zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';
import { IMPORT_ERROR_COPY, localizeImportError } from './import-error-copy';

const CJK = /[㐀-鿿]/u;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
/** 假翻译:取真词条、按 {name} 插值,够看出每种语言最终说了什么。 */
const speak = (catalog: Record<string, string>) =>
  ((key: string, values?: Record<string, unknown>) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''))) as never;

describe('import error copy', () => {
  it('has a message for every code, in both languages, with the same placeholders', () => {
    expect(Object.keys(IMPORT_ERROR_COPY).sort()).toEqual([...IMPORT_ERROR_CODES].sort());
    for (const code of IMPORT_ERROR_CODES) {
      const key = IMPORT_ERROR_COPY[code];
      const en = (enUSSessionWorkflowMessages as Record<string, string>)[key];
      const zh = (zhCNSessionWorkflowMessages as Record<string, string>)[key];
      expect(en, `${key} en`).toBeTruthy();
      expect(zh, `${key} zh`).toBeTruthy();
      expect(placeholders(zh), key).toEqual(placeholders(en));
    }
  });

  it('English copy contains no Chinese, so the English UI never renders a hardcoded zh sentence', () => {
    for (const key of [...Object.values(IMPORT_ERROR_COPY), 'sessionImport.error.unnamedFile'] as const) {
      expect((enUSSessionWorkflowMessages as Record<string, string>)[key], key).not.toMatch(CJK);
    }
  });

  it('says a missing file in the UI language and shows the file name only', () => {
    const message = 'transcript-unreadable:imp-8.jsonl';
    const en = localizeImportError(message, speak(enUSSessionWorkflowMessages));
    const zh = localizeImportError(message, speak(zhCNSessionWorkflowMessages));
    expect(en).toBe('imp-8.jsonl is missing or cannot be read');
    expect(zh).toBe('imp-8.jsonl 不存在或无法读取');
    expect(en).not.toContain('/');
  });

  it('reads the code through the error class name real Electron IPC puts in front of it', () => {
    // 真 Electron 45 实测收到的整句(去掉外壳后):类名在码前面。
    const translate = speak(enUSSessionWorkflowMessages);
    expect(localizeImportError('TranscriptAccessError: transcript-unreadable:imp-8.jsonl', translate)).toBe('imp-8.jsonl is missing or cannot be read');
    expect(localizeImportError('Error: TypeError: session-no-id:', translate)).toBe(
      'This session has no usable session ID, so the original session cannot be resumed'
    );
  });

  it('falls back to a generic file name when the code carries none', () => {
    expect(localizeImportError('transcript-empty:', speak(enUSSessionWorkflowMessages))).toBe(
      'This session file has no user or agent messages to import'
    );
  });

  it('passes an unknown message through untouched', () => {
    const translate = speak(enUSSessionWorkflowMessages);
    expect(localizeImportError('读不到索引', translate)).toBe('读不到索引');
    expect(localizeImportError('目录已经不在了：/w', translate)).toBe('目录已经不在了：/w');
  });
});
