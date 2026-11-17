import type { ContactGroup, ContactUser, FriendRequest } from '@gugu/core/shared/types/contacts'
import { contactsService } from './contacts'
import { listGroupInvitations, type GroupInvitation } from './groupInvitations'
import { listManagedGroupJoinRequests, type ManagedGroupJoinRequest } from './groupJoinRequests'
import { joinRequestIdentityIds } from './groupAgentJoin'
import { readRequiredDisplayIdentities } from './identityReadAdapter'
import { openedImRepository } from './imRepository'
import { replica, type Replica } from './replica'

/**
 * The contacts domain's lists (@@@client-state-model, PR 2): one replica each, account scope, not kept across restarts
 * (they grow with the account). Each read publishes the identities it names into the IM library before it answers, so a
 * row is never shown without its identity.
 */
export type ContactRelation = Pick<ContactUser, 'id' | 'alias' | 'agent_type' | 'project_path'>

const relationOf = ({ id, alias, agent_type, project_path }: ContactUser): ContactRelation => ({ id, alias, agent_type, project_path })

/** Friends and own agents: the relation columns; the identity columns live in the IM library. */
export const contactRelations = replica({
  name: 'contactRelations',
  scope: 'account',
  read: async (owner: string): Promise<ContactRelation[]> => {
    const data = await contactsService.getContacts(owner)
    await (await openedImRepository(owner)).putIdentities(data)
    return data.map(relationOf)
  },
})

/** The account's contact labels (groups of contacts, ≠ group chats). */
export const contactGroups = replica({
  name: 'contactGroups',
  scope: 'account',
  read: (owner: string): Promise<ContactGroup[]> => contactsService.getContactGroups(owner),
})

export type ContactRequests = { received: FriendRequest[]; sent: FriendRequest[]; invitations: GroupInvitation[] }

/** Friend requests both ways and group invitations: the 「新的请求」 inbox but for join requests. */
export const contactRequests = replica({
  name: 'contactRequests',
  scope: 'account',
  read: async (owner: string): Promise<ContactRequests> => {
    const [received, sent, invitations] = await Promise.all([
      contactsService.getReceivedRequests(owner),
      contactsService.getSentRequests(owner),
      listGroupInvitations(),
    ])
    const ids = [...new Set([...received, ...sent].flatMap((request) => [request.sender_id, request.receiver_id]))]
    await (await openedImRepository(owner)).putIdentities(await readRequiredDisplayIdentities(ids))
    return { received, sent, invitations }
  },
})

/**
 * @@@6418 Join requests to the groups this account manages. Keyed by those groups (sorted ids): a group gained or lost
 * reads again; another field of the same groups does not.
 */
export const groupJoinRequests = replica({
  name: 'groupJoinRequests',
  scope: 'account',
  keep: 60_000,
  read: async (owner: string, _managedGroups: string): Promise<ManagedGroupJoinRequest[]> => {
    const rows = await listManagedGroupJoinRequests()
    if (rows.length) await (await openedImRepository(owner)).putIdentities(await readRequiredDisplayIdentities(joinRequestIdentityIds(rows)))
    return rows
  },
})

/**
 * Read again for an event that must be consumed: rejects when the read fails, so the account revision coordinator keeps
 * the event and retries it (a plain `refresh` resolves either way).
 */
export async function refreshStrictly<A extends unknown[], V>(model: Replica<A, V>, ...args: A): Promise<void> {
  await model.refresh(...args)
  const reading = model.peek(...args)
  if (reading.state === 'error') throw reading.error
  if (reading.state === 'value' && reading.error) throw reading.error
}
