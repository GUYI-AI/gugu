import { describe, expect, it } from 'vitest';
import { taskBrowserArguments } from '../../../../server/server-task-browser';

describe('how the task browser is launched', () => {
  it('leaves Chrome announcing itself as automated by default, which is what the server expects', () => {
    expect(taskBrowserArguments('/profile', 'UA', false)).not.toContain('--disable-blink-features=AutomationControlled');
  });

  it('lets the desktop standalone browser look like the Chrome a person uses: navigator.webdriver is false, as in the built-in browser', () => {
    const args = taskBrowserArguments('/profile', 'UA', false, 'system', { automationControlled: false });
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args.filter(arg => arg.startsWith('--disable-blink-features'))).toHaveLength(1);
    expect(args[args.length - 1]).toBe('about:blank');
  });
});
