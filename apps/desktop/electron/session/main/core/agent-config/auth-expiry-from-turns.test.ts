import { describe, expect, it, vi } from 'vitest';
import {
  applyTurnToAuthExpiry,
  applyStartToAuthExpiry,
  authExpiryEffect,
  sessionUsesHostCredentials,
  hookAuthExpiryEffect,
  setHostCredentialsProbe,
} from './auth-expiry-from-turns';

const failed = { outcome: { kind: 'error' as const, reason: 'prompt_failed' as const, signInRequired: true } };
const otherFailure = { outcome: { kind: 'error' as const, reason: 'prompt_failed' as const } };
const done = { outcome: { kind: 'done' as const, reason: 'end_turn' as const } };

describe('startup revocation before a turn exists', () => {
  const failure = { type: 'auth_required', cause: { name: 'RequestError', message: 'refresh token was revoked' } };
  const writer = () => ({ mark: vi.fn(async () => {}), clear: vi.fn(async () => {}), log: vi.fn() });
  it('marks the session-bound connection before the start failure is returned', async () => {
    const target = writer();
    await applyStartToAuthExpiry({ providerId: 'codex', sessionId: 'bound-old-agent', hostCredentials: false, failure }, target);
    expect(target.mark).toHaveBeenCalledWith('codex', 'bound-old-agent');
    expect(target.clear).not.toHaveBeenCalled();
  });
  it('does not expire a personal account for a platform failure or a generic startup error', () => {
    const target = writer();
    expect(applyStartToAuthExpiry({ providerId: 'codex', sessionId: 'platform-agent', hostCredentials: true, failure }, target)).toBeNull();
    expect(applyStartToAuthExpiry({ providerId: 'codex', sessionId: 'agent', hostCredentials: false,
      failure: { cause: { name: 'Error', message: 'refresh token request timed out' } } }, target)).toBeNull();
    expect(applyStartToAuthExpiry({ sessionId: 'agent', hostCredentials: false, failure }, target)).toBeNull();
    expect(target.mark).not.toHaveBeenCalled();
  });
  it('keeps the original startup error when the expiry writer fails', async () => {
    const target = writer();
    target.mark.mockRejectedValueOnce(new Error('fixture write failure'));
    await expect(applyStartToAuthExpiry({ providerId: 'codex', sessionId: 'agent', hostCredentials: false, failure }, target)).resolves.toBeUndefined();
    expect(target.log).toHaveBeenCalledTimes(1);
  });
});

describe('authExpiryEffect (#6264)', () => {
  it('这一轮因鉴权被拒 ⇒ 标上这家', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'live', turn: failed })).toEqual({ kind: 'mark', providerId: 'codex' });
  });

  it('改口成鉴权失败的那一轮(revision)同样标上', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'revision', turn: failed })).toEqual({ kind: 'mark', providerId: 'codex' });
  });

  it('正常做完一轮 ⇒ 撤掉', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'live', turn: done })).toEqual({ kind: 'clear', providerId: 'codex' });
  });

  it('重放回来的旧回合说的是过去,❌ 改现在的状态', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'replay', turn: failed })).toBeNull();
    expect(authExpiryEffect({ providerId: 'codex', source: 'replay', turn: done })).toBeNull();
  });

  it('更早那一轮被后台命令的终态补了内容(backfill,#6582):之后已经有别的轮了,❌ 据它重新标上', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'backfill', turn: failed })).toBeNull();
    expect(authExpiryEffect({ providerId: 'codex', source: 'backfill', turn: done })).toBeNull();
  });

  it('跑咕咕平台模型的会话不动它(用的是咕咕的凭据,与用户自己那份登录无关)', () => {
    expect(authExpiryEffect({ providerId: 'codex', hostCredentials: true, source: 'live', turn: failed })).toBeNull();
    expect(authExpiryEffect({ providerId: 'codex', hostCredentials: true, source: 'live', turn: done })).toBeNull();
  });

  it('其它失败、取消、没有结局、不知道是哪家 ⇒ 不动', () => {
    expect(authExpiryEffect({ providerId: 'codex', source: 'live', turn: otherFailure })).toBeNull();
    expect(authExpiryEffect({ providerId: 'codex', source: 'live', turn: { outcome: { kind: 'cancelled' } } })).toBeNull();
    expect(authExpiryEffect({ providerId: 'codex', source: 'live', turn: {} })).toBeNull();
    expect(authExpiryEffect({ source: 'live', turn: failed })).toBeNull();
  });
});

describe('applyTurnToAuthExpiry', () => {
  it('写失败只记日志,❌ 抛到会话那一侧', async () => {
    const log = vi.fn();
    const writer = { mark: vi.fn(async () => { throw new Error('worker down'); }), clear: vi.fn(async () => {}), log };
    await applyTurnToAuthExpiry({ providerId: 'codex', source: 'live', turn: failed }, writer);
    expect(writer.mark).toHaveBeenCalledWith('codex', undefined);
    expect(log).toHaveBeenCalledWith('auth expiry update failed', expect.objectContaining({ providerId: 'codex', effect: 'mark' }));
  });

  it('不需要动时不碰 worker', () => {
    const writer = { mark: vi.fn(async () => {}), clear: vi.fn(async () => {}), log: vi.fn() };
    expect(applyTurnToAuthExpiry({ providerId: 'codex', source: 'live', turn: otherFailure }, writer)).toBeNull();
    expect(writer.mark).not.toHaveBeenCalled();
    expect(writer.clear).not.toHaveBeenCalled();
  });
});

describe('hookAuthExpiryEffect:「编程」终端会话这条腿 (#6264)', () => {
  it('StopFailure authentication_failed ⇒ 标上;Stop ⇒ 撤掉;其它错误不动', () => {
    expect(hookAuthExpiryEffect({ providerId: 'claude', type: 'error', signInRequired: true, hostCredentials: false })).toEqual({
      kind: 'mark',
      providerId: 'claude',
    });
    expect(hookAuthExpiryEffect({ providerId: 'claude', type: 'stop', hostCredentials: false })).toEqual({ kind: 'clear', providerId: 'claude' });
    expect(hookAuthExpiryEffect({ providerId: 'claude', type: 'error', hostCredentials: false })).toBeNull();
    expect(hookAuthExpiryEffect({ providerId: 'claude', type: 'start', hostCredentials: false })).toBeNull();
  });

  it('跑咕咕平台模型的终端会话不动它;宿主没告诉我们时按「是」处理(宁可不学)', () => {
    expect(hookAuthExpiryEffect({ providerId: 'claude', type: 'error', signInRequired: true, hostCredentials: true })).toBeNull();
    setHostCredentialsProbe(null);
    expect(sessionUsesHostCredentials('c1')).toBe(true);
    setHostCredentialsProbe((id) => id === 'p1');
    expect(sessionUsesHostCredentials('c1')).toBe(false);
    expect(sessionUsesHostCredentials('p1')).toBe(true);
    setHostCredentialsProbe(null);
  });
});

 it('passes the emitting session to the credential owner for connection attribution', async () => {
  const writer = { mark: vi.fn(async () => {}), clear: vi.fn(async () => {}), log: vi.fn() };
  await applyTurnToAuthExpiry({ providerId: 'codex', sessionId: 'old-agent', source: 'live', turn: { outcome: { kind: 'error', signInRequired: true } } }, writer);
  expect(writer.mark).toHaveBeenCalledWith('codex', 'old-agent');
});
