import { expect, it } from 'vitest';
import { importItemMetadata } from './metadata';

it('exports only the stable selection and result metadata, excluding configuration and source paths', () => {
  expect(importItemMetadata({ localSourceId: 'opaque-id', sourceFingerprint: 'revision', name: 'Project', status: 'ready',
    directory: '/private/work', sources: [{ path: '/private/source' }], env: { API_KEY: 'never-publish' },
    url: 'https://private.invalid', payload: { prompt: 'private' } })).toEqual({
    localSourceId: 'opaque-id', fingerprint: 'revision', name: 'Project', status: 'ready',
  });
});
it.each(['exists', 'existing', 'already-exists'])('normalizes %s without claiming a new import', status => {
  expect(importItemMetadata({ localSourceId: 'id', status }, new Map([['id', 'Existing']]))).toMatchObject({
    name: 'Existing', status: 'existing', fingerprint: null,
  });
});
it('does not turn an invalid or changed item into an importable item', () => {
  expect(importItemMetadata({ localSourceId: 'bad', status: 'invalid' })).toMatchObject({ status: 'skipped', reason: 'invalid' });
  expect(importItemMetadata({ localSourceId: 'changed', status: 'source-changed', reason: 'source-changed' }))
    .toMatchObject({ status: 'conflict', reason: 'source-changed' });
});
