import { expect, it } from 'vitest';
import { createFailureLogFields } from './create-failure-log-fields';

it('logs only fixed creation diagnostics and never an arbitrary host string', () => {
  expect(createFailureLogFields('harness_not_found')).toEqual({ scope: 'session-timeline/create', code: 'harness_not_found', retry: false });
  for (const code of ['person@example.test', '/Users/private/attachments/file', 'constructor', '__proto__']) {
    expect(createFailureLogFields(code, true)).toEqual({ scope: 'session-timeline/create', code: 'unknown_creation_failure', retry: true });
  }
});
