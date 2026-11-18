import enUSAssistant from '@/i18n/locales/en-US/assistant';
import zhCNAssistant from '@/i18n/locales/zh-CN/assistant';
import { READABLE_RESOURCE_DOMAINS, type ReadableResourceDomain } from '@shared/extensions/agent-resources';

/**
 * #1927 (42) The kinds of an agent's resources an App's consent names (`chat:resources`, `chat:resources:write`): not
 * written again here — the words the assistant's own pages use for them (`assistant:resourceKinds.*`), so a kind is called
 * the same on both. Every domain an App can be granted has one, or this stops compiling.
 */
type ResourceKindMessageKey = `extensions.resourceKind.${ReadableResourceDomain}`;

function resourceKindMessages(table: Readonly<Record<ReadableResourceDomain, string>>): Record<ResourceKindMessageKey, string> {
  const messages = {} as Record<ResourceKindMessageKey, string>;
  for (const domain of READABLE_RESOURCE_DOMAINS) messages[`extensions.resourceKind.${domain}`] = table[domain];
  return messages;
}

export const enUSResourceKindMessages = {
  ...resourceKindMessages(enUSAssistant.resourceKinds),
  'extensions.resourceKindSeparator': ', ',
};

export const zhCNResourceKindMessages: Record<keyof typeof enUSResourceKindMessages, string> = {
  ...resourceKindMessages(zhCNAssistant.resourceKinds),
  'extensions.resourceKindSeparator': '、',
};
