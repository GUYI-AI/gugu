import { describe, expect, it } from 'vitest';
import { decideWindowOpen, isAllowedAuthPopupUrl, windowOpenDisposition } from './browser-window-open';

describe('what a window a page opens becomes in the Gugu browser', () => {
  it('gives a sign-in address a real window, so the page keeps window.opener, only when it asked for a popup window', () => {
    for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?x=1', 'https://accounts.youtube.com/', 'https://github.com/login', 'https://github.com/login/oauth/authorize?client_id=1']) {
      expect(decideWindowOpen({ url, disposition: 'new-window' })).toBe('window');
      expect(decideWindowOpen({ url, disposition: 'foreground-tab' })).toBe('tab');
    }
  });

  it('gives any other web address a new tab with no window.opener, popup or not', () => {
    for (const url of ['https://example.com/docs', 'http://localhost:3000/p/auth', 'https://github.com/settings', 'https://github.com.evil.test/login']) {
      expect(decideWindowOpen({ url, disposition: 'new-window' })).toBe('tab');
      expect(decideWindowOpen({ url, disposition: 'foreground-tab' })).toBe('tab');
    }
  });

  it('opens nothing for an address that is not a web page, an empty window included', () => {
    for (const url of ['javascript:alert(1)', 'about:blank', 'file:///etc/passwd', 'chrome://settings', 'https://site.test/\u0000x', '']) {
      expect(decideWindowOpen({ url, disposition: 'new-window' })).toBe('deny');
      expect(decideWindowOpen({ url, disposition: 'foreground-tab' })).toBe('deny');
    }
  });

  it('lets a window the page opened open only another sign-in window, never a tab', () => {
    expect(decideWindowOpen({ url: 'https://github.com/login', disposition: 'new-window', fromPopup: true })).toBe('window');
    expect(decideWindowOpen({ url: 'https://example.com/', disposition: 'new-window', fromPopup: true })).toBe('deny');
    expect(decideWindowOpen({ url: 'https://example.com/', disposition: 'foreground-tab', fromPopup: true })).toBe('deny');
  });

  it('knows a sign-in address by its host and path, not by a look-alike', () => {
    expect(isAllowedAuthPopupUrl('https://github.com/login')).toBe(true);
    expect(isAllowedAuthPopupUrl('https://github.com/login/device')).toBe(false);
    expect(isAllowedAuthPopupUrl('https://notgithub.com/login')).toBe(false);
    expect(isAllowedAuthPopupUrl('not a url')).toBe(false);
  });
});

describe('a window Chrome opens, in the terms Electron names it', () => {
  // Chrome lists the window features that are on: a window that is a tab has every bar, a popup window has fewer (real Chrome 158).
  const tab = ['menubar', 'toolbar', 'status', 'scrollbars', 'resizable'];

  it('is a tab when it has every bar, whether or not it is noopener', () => {
    expect(windowOpenDisposition(tab)).toBe('foreground-tab');
    expect(windowOpenDisposition([...tab, 'noopener'])).toBe('foreground-tab');
  });

  it('is a popup window when a bar is missing: sized, popup, or bars turned off', () => {
    expect(windowOpenDisposition(['width=480', 'height=640', 'resizable'])).toBe('new-window');
    expect(windowOpenDisposition(['resizable'])).toBe('new-window');
    expect(windowOpenDisposition(['width=400', 'height=300', 'resizable', 'noopener'])).toBe('new-window');
  });

  it('is a tab when Chrome said nothing about features', () => {
    expect(windowOpenDisposition(undefined)).toBe('foreground-tab');
  });
});
