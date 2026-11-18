import { describe, expect, it } from 'vitest';
import { hostLinkTarget } from './host-links';
import { safeParseExtensionManifest } from './manifest';

const tool = (hostLinks: unknown, apiVersion = 52) => ({
  id: 'prompts', name: 'Prompts', version: '1.0.0', apiVersion, defaultLocale: 'en',
  permissions: { capabilities: ['agents:tools', 'prompts'] },
  contributes: { mcpServers: [{ name: 'prompts', command: 'node', args: ['tools.js'] }], instructions: 'prompts__list: the person\'s prompts.', hostLinks },
});

describe('contributes.hostLinks (API 52)', () => {
  it('names gugu pages from the closed set', () => {
    const parsed = safeParseExtensionManifest(tool(['library:prompts', 'library:mcp']));
    expect(parsed.ok && parsed.manifest.contributes.hostLinks).toEqual(['library:prompts', 'library:mcp']);
  });
  it.each([
    ['before API 52', ['library:prompts'], 51],
    ['a page outside the set', ['library:skills'], 52],
    ['an address instead of a page', ['https://example.com'], 52],
    ['the same page twice', ['library:prompts', 'library:prompts'], 52],
    ['an empty list', [], 52],
  ])('refuses %s', (_what, links, apiVersion) => {
    expect(safeParseExtensionManifest(tool(links, apiVersion)).ok).toBe(false);
  });
  it('opens the Library on that tab', () => {
    expect(hostLinkTarget('library:prompts')).toEqual({ view: 'library', params: { tab: 'prompts' } });
  });
});
