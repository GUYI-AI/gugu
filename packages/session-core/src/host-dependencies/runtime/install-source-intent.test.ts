import { describe, expect, it } from 'vitest';
import type { InstallOption } from '../capability';
import { installSourceIntent } from './install-source-intent';

const target = { kind: 'mise' as const, package: '@vendor/agent', binary: 'agent', backend: { kind: 'platform-archive' as const, executables: {} } };
const options: InstallOption[] = ['official', 'npmmirror', 'huawei'].map((registry) => ({ method: 'mise', command: 'mise install agent', target, registry, recommended: registry === 'official' }));

describe('shared installation intent', () => {
  it('recommended registry remains an automatic fallback, not an explicit user choice', () => {
    expect(installSourceIntent(options[0], options)).toEqual({ kind: 'automatic', registries: ['official', 'npmmirror', 'huawei'], fallbackRegistry: 'official' });
  });
  it('explicit choice stays single-source', () => {
    expect(installSourceIntent(options[0], options, 'npmmirror')).toEqual({ kind: 'explicit', registry: 'npmmirror' });
  });
  it('does not add options for another target or installation method', () => {
    expect(installSourceIntent(options[0], [...options, { ...options[0], registry: 'wrong', target: { ...target, binary: 'other' } }, { ...options[0], registry: 'wrong-method', method: 'npm' }])).toMatchObject({ registries: ['official', 'npmmirror', 'huawei'] });
  });
});
