import { rawSessionFailure } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/raw-session-failure';
import { describe, expect, it } from 'vitest';
import { codexStartupKind, tagCodexStartupFailure } from '@gugu/core/local/codex-startup-failure.mjs';
import { codexNeedsUpgrade, creationFailureCopy, sessionStartupFailureCopy } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-input-failure-copy';
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';

const table: Record<string, string> = zhCNMessages;
const translate = (key: string) => { const text = table[key]; if (text === undefined) throw new Error('missing translation: ' + key); return text; };
describe('Codex startup repair copy', () => {
  it.each(['missing', 'permission', 'configuration', 'protocol', 'exited', 'timeout', 'unknown'] as const)('%s is explained in Chinese without offering an upgrade or leaking the diagnostic', kind => {
    const failure = tagCodexStartupFailure(new Error('private English diagnostic /private/home auth value'), kind);
    const text = sessionStartupFailureCopy(failure, translate);
    expect(codexNeedsUpgrade(failure)).toBe(false);
    expect(text).toContain('Codex');
    expect(text).not.toMatch(/升级|private|English|auth|\/private/);
    expect(codexStartupKind({ runtimeError: { cause: failure } })).toBe(kind);
    const creation = rawSessionFailure(failure);
    expect(creation.startupReason).toBe(kind);
    expect(creationFailureCopy(creation, translate)).toBe(text);
    expect(creation.detail).toBe(failure.message);
  });
  it('offers an upgrade only for a verified unsupported capability or version', () => {
    const failure = { code: 'runtime-version-unsupported', data: { providerId: 'codex', installedVersion: '0.100', supportedFloor: '0.160' } };
    expect(codexNeedsUpgrade(failure)).toBe(true);
    expect(sessionStartupFailureCopy(failure, translate)).toContain('升级');
    expect(codexNeedsUpgrade('Codex app-server failed, please upgrade')).toBe(false);
    expect(codexNeedsUpgrade({ code: 'runtime-version-unsupported', data: { providerId: 'claude' } })).toBe(false);
  });
  it('recognizes diagnostics minted by older bridges without interpreting them as version evidence', () => {
    expect(codexStartupKind('local Codex app-server exited (code=1 signal=null)')).toBe('exited');
    expect(codexStartupKind('local Codex app-server initialize timed out after 45000ms')).toBe('timeout');
    expect(codexStartupKind('Invalid JSONL from Codex app-server stdout: bytes=37')).toBe('protocol');
    expect(codexNeedsUpgrade('本机 Codex 无法启动 app-server；请升级 Codex 后重试。原始错误：local Codex app-server exited (code=1 signal=null)')).toBe(false);
  });
  it('keeps unrelated errno and unknown failures generic instead of calling them Codex failures', () => {
    expect(codexStartupKind(Object.assign(new Error('network failed'), { code: 'EACCES' }))).toBeNull();
    expect(codexStartupKind(Object.assign(new Error('execute failed'), { code: 'EACCES' }), true)).toBe('permission');
    expect(codexStartupKind({ code: 'runtime-version-probe-failed', probe: { errno: 'EACCES' } }, true)).toBe('permission');
    expect(sessionStartupFailureCopy('unknown English failure', translate)).not.toContain('unknown English');
  });
});
