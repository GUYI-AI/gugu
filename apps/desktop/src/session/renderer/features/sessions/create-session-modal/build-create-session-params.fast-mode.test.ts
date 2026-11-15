import { describe, expect, it } from 'vitest';
import type { InitialSessionState } from '../session-config/initial-session-section';
import { buildInitialSession } from './build-create-session-params';

function draft(fastMode?: boolean, platformModel: string | null = null): InitialSessionState {
  return { provider: 'codex', sessionView: 'general', prompt: 'A short task', attachments: [],
    permissionMode: 'edit', model: 'native-model', effort: 'medium', platformModel, fastMode } as InitialSessionState;
}

describe('new task Fast intent', () => {
  it.each([false, true])('passes an explicit accepted draft value %s into session creation', fastMode => {
    expect(buildInitialSession(draft(fastMode))?.fastMode).toBe(fastMode);
  });
  it('sends false for untouched and unsupported drafts', () => {
    expect(buildInitialSession(draft())?.fastMode).toBe(false);
  });
  it('keeps Fast off on the platform route even if draft intent was previously on', () => {
    expect(buildInitialSession(draft(true, 'platform-model'))?.fastMode).toBe(false);
  });
});
