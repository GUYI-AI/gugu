import { describe, expect, it } from 'vitest';
import { EXTENSION_CAPABILITIES_MAX, safeParseExtensionManifest } from './manifest';

/**
 * The capability list's bound (EXTENSION_CAPABILITIES_MAX): an App bound to its assistant chat declares a capability per
 * binding action, the assistant App 14 of them; more than the bound is refused whatever they are.
 */
const BINDING = ['chat:unread', 'chat:files', 'chat:draft', 'chat:surface', 'chat:resources', 'chat:resources:write', 'chat:voice-notes:manage',
  'chat:schedules', 'chat:schedules:control', 'assistant:status', 'assistant:open', 'assistant:rename', 'chat:work', 'chat:voice-notes:record'];
const ACTIONS = ['unread', 'files', 'draft', 'surface', 'resources', 'resources:write', 'voice-notes:manage', 'schedules', 'schedules:control',
  'assistant-status', 'assistant-open', 'assistant-rename', 'work', 'voice-notes:record'];
// One tier of each of the rest (a capability's two tiers are never declared together).
const OTHERS = ['files:read', 'files:write', 'chat:relay', 'chat:read', 'agents:read', 'agents:history', 'agents:control', 'agents:tools', 'prompts', 'notifications'];

const app = (capabilities: string[]) => ({
  id: 'assistant', name: 'Assistant', version: '1.0.0', apiVersion: 50, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
  permissions: {
    capabilities,
    bindings: [{ name: 'main', kind: 'conversation', actions: ACTIONS, domains: { resources: ['memory', 'voice-notes'], 'resources:write': ['memory'] } }],
  },
  contributes: {
    tabs: [{ name: 'main', title: 'Assistant' }], conversationSurface: { binding: 'main', placement: 'side-panel' },
    // `agents:tools` comes with what it gives agents.
    ...(capabilities.includes('agents:tools') ? { skills: 'skills', instructions: 'Skills for the assistant.' } : {}),
  },
});

describe('how many capabilities a manifest may list', () => {
  it('the assistant App\'s 14 binding capabilities, and up to the bound in all', () => {
    expect(BINDING).toHaveLength(14);
    const parsed = safeParseExtensionManifest(app(BINDING));
    expect(parsed.ok ? null : parsed.issues).toBeNull();
    const full = [...BINDING, ...OTHERS].slice(0, EXTENSION_CAPABILITIES_MAX);
    expect(full).toHaveLength(24);
    const atBound = safeParseExtensionManifest(app(full));
    expect(atBound.ok ? null : atBound.issues).toBeNull();
  });

  it('one more than the bound is refused for its length alone', () => {
    // Every capability is in the 24 above (one tier each): the 25th can only be another tier, so the length is checked by
    // what is said about it.
    const over = [...BINDING, ...OTHERS, 'agents:read:all'];
    expect(over).toHaveLength(EXTENSION_CAPABILITIES_MAX + 1);
    const parsed = safeParseExtensionManifest(app(over));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues.filter((issue) => issue.startsWith('permissions.capabilities') && /24/.test(issue))).toHaveLength(1);
  });
});
