import { describe, expect, it, vi } from 'vitest';
import { platformCreationFastGroup } from './platform-fast-mode';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const read = async () => JSON.stringify({ models: [
  { slug: 'supported-model', service_tiers: [{ id: 'priority', name: 'Fast' }] },
  { slug: 'ordinary-model', service_tiers: [] },
] });

describe('credit-billed Fast model capability', () => {
  it('uses the installed model metadata without requiring a vendor account', async () => {
    expect(await platformCreationFastGroup('codex', 'platform:supported-model', read)).toMatchObject({
      model: 'platform:supported-model', selected: 'off', available: [{ id: 'off' }, { id: 'on' }],
    });
  });
  it.each(['ordinary-model', 'supported-model-alias', 'missing'])('does not infer support from a related name: %s', async model => {
    expect(await platformCreationFastGroup('codex', `platform:${model}`, read)).toBeNull();
  });
  it('does not transfer Codex metadata to another harness or billing route', async () => {
    const unused = vi.fn(read);
    expect(await platformCreationFastGroup('claude', 'platform:supported-model', unused)).toBeNull();
    expect(await platformCreationFastGroup('codex', 'supported-model', unused)).toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
  it('keeps malformed or unavailable capability separate from support', async () => {
    expect(await platformCreationFastGroup('codex', 'platform:supported-model', async () => '{}')).toBeNull();
    expect(await platformCreationFastGroup('codex', 'platform:supported-model', async () => { throw new Error('old CLI'); })).toBeNull();
  });
});
