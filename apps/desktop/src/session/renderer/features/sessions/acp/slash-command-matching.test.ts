import { describe, expect, it } from 'vitest';

import { catalogCommandItems } from './slash-command-matching';

// gugu-dev#1644: before an agent has a session, the `/` menu offers its harness's commands from the probed catalog, in the
// same shape a running session's commands take (the token the agent receives, the hint of what follows).
describe('catalogCommandItems', () => {
  it('offers a ready catalog\'s commands as a session offers its own', () => {
    expect(catalogCommandItems({ kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null, commands: [
      { name: 'goal', description: 'Set a goal', input: { hint: '[--tokens N] <goal>' } }, { name: '$skill', description: 'A skill' }] }))
      .toEqual([
        { id: 'goal', name: 'goal', token: '/goal', description: 'Set a goal', behavior: 'insert', inputHint: '[--tokens N] <goal>' },
        { id: '$skill', name: '$skill', token: '$skill', description: 'A skill', behavior: 'insert' },
      ]);
  });

  it('offers them while the harness wants a sign-in too (a person on Gugu\'s models never signs in there)', () => {
    expect(catalogCommandItems({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null, commands: [{ name: 'goal', description: 'Set a goal' }] })
      .map((item) => item.token)).toEqual(['/goal']);
  });

  it('offers nothing for a catalog that is not ready or heard no commands', () => {
    expect(catalogCommandItems({ kind: 'unknown' })).toEqual([]);
    expect(catalogCommandItems({ kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null })).toEqual([]);
  });
});
