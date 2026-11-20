import { describe, expect, it } from 'vitest';
import { popupClaims } from './browser-popup-claims';

describe('the window a new tab was opened for', () => {
  it('is handed to that tab once, and to no other tab', () => {
    popupClaims.remember('tab-1', 'P1');
    popupClaims.remember('tab-2', 'P2');
    expect(popupClaims.take('tab-3')).toBeUndefined();
    expect(popupClaims.take('tab-2')).toBe('P2');
    expect(popupClaims.take('tab-2')).toBeUndefined();
    expect(popupClaims.take('tab-1')).toBe('P1');
  });

  it('is dropped with a tab that closed before it showed anything', () => {
    popupClaims.remember('tab-4', 'P4');
    popupClaims.forget('tab-4');
    expect(popupClaims.take('tab-4')).toBeUndefined();
  });

  it('is known to be waiting until the tab takes it, and not before it was remembered', () => {
    expect(popupClaims.has('tab-5')).toBe(false);
    popupClaims.remember('tab-5', 'P5');
    expect(popupClaims.has('tab-5')).toBe(true);
    expect(popupClaims.take('tab-5')).toBe('P5');
    expect(popupClaims.has('tab-5')).toBe(false);
  });
});
