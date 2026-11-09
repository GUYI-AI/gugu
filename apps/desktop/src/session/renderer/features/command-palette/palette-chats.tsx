import { Command } from 'cmdk';
import { Users } from '@/lib/icons';
import { useChatSummaries, useContactSummaries } from '@/lib/chatSummariesBridge';
import { followLink } from '@/lib/guguLinks';
import { UI_EVENTS } from '@/lib/uiEvents';
import { conversationLink } from '@gugu/core/shared/ui/guguLink';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { rankPaletteMatches } from './palette-rank';

/** Groups and people named by `query`: the quick switcher's rows, and the phone search panel's (it has no switcher). `enabled` false: none, without ranking anything. */
export function useNameMatches(query: string, limit: number, enabled = true) {
  const summaries = useChatSummaries();
  const contacts = useContactSummaries();
  const groups = !enabled ? [] : rankPaletteMatches([...summaries].filter(([id, chat]) => chat.kind === 'group'
    && !!chat.name && !projectGroupsStore.rowProjectOfChat(id)), query, ([, chat]) => [chat.name, chat.alias]).slice(0, limit);
  const people = !enabled ? [] : rankPaletteMatches(contacts, query, (contact) => [contact.name]).slice(0, limit);
  return { groups, people };
}

/** A group opens its conversation; a person opens their contact details (never creates a conversation). */
export function openGroup(id: string): void { followLink(conversationLink(id)); }
export function openPerson(id: string): void { window.dispatchEvent(new CustomEvent(UI_EVENTS.openContact, { detail: id })); }

export function PaletteChatGroups({ query, groupClassName, onDone }: {
  query: string; groupClassName: string; onDone: () => void;
}) {
  const { translate } = useSessionMessages();
  const { groups, people } = useNameMatches(query, query.trim() ? 20 : 5);
  return (
    <>
      {groups.length > 0 && (
        <Command.Group heading={translate('palette.groups')} className={groupClassName}>
          {groups.map(([id, chat]) => (
            <Command.Item key={id} value={`chat:${id}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => { onDone(); openGroup(id); }}>
              <Users size={14} className="shrink-0 text-foreground/40" /><span className="flex-1 truncate">{chat.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {people.length > 0 && (
        <Command.Group heading={translate('palette.contacts')} className={groupClassName}>
          {people.map((contact) => (
            <Command.Item key={contact.id} value={`contact:${contact.id}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => { onDone(); openPerson(contact.id); }}>
              <Users size={14} className="shrink-0 text-foreground/40" /><span className="flex-1 truncate">{contact.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
