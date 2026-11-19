import { describe, expect, it } from 'vitest';
import { codexProviderFailureCode, codexStartupKind, isCodexProviderStartupKind, tagCodexStartupFailure } from '@gugu/core/local/codex-startup-failure.mjs';
import { toSerializedError } from '@gugu/session-shared';
import { codexNeedsUpgrade, sessionStartupFailureCopy } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-input-failure-copy';
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';

describe('Codex model-provider failures', () => {
  it.each([
    ['modelProviderNotConfigured', 'provider-missing'],
    ['modelProviderMismatch', 'provider-mismatch'],
    ['modelProviderPolicyConflict', 'provider-policy'],
  ] as const)('classifies %s by its structured data, across runtime serialization', (type, kind) => {
    const failure = Object.assign(new Error('unrelated private English /Users/private-user/model'), {
      code: -32600, data: { type, modelProvider: 'gugu_platform' },
    });
    const tagged = tagCodexStartupFailure(failure);
    const serialized = toSerializedError(tagged);
    expect(serialized.data).toMatchObject({ type, codexStartupKind: kind });
    const wrapped = { runtimeError: { cause: serialized } };
    expect(codexStartupKind(wrapped)).toBe(kind);
    expect(codexNeedsUpgrade(wrapped)).toBe(false);
    const copy = sessionStartupFailureCopy(wrapped, key => zhCNMessages[key]);
    expect(copy).toMatch(/来源|组织策略/);
    expect(copy).toContain('保留');
    expect(copy).not.toMatch(/private|English|gugu_platform|无法启动|操作未能完成/);
    // The native WebSocket client retains the reply on `reply`, rather than `data`.
    expect(codexStartupKind(new Error('wrapper', { cause: { reply: serialized } }))).toBe(kind);
    expect(codexStartupKind({ startupReason: 'unknown', cause: serialized })).toBe(kind);
    expect(codexStartupKind(`Error invoking remote method 'reload': Error: ${codexProviderFailureCode(kind)}`)).toBe(kind);
  });

  it('does not infer a provider failure from the shared RPC number or native prose', () => {
    expect(codexStartupKind({ code: -32600, data: { type: 'unknown' } })).toBeNull();
    expect(codexStartupKind({ code: -32600, message: 'modelProviderMismatch' })).toBeNull();
    expect(isCodexProviderStartupKind('configuration')).toBe(false);
  });

});
