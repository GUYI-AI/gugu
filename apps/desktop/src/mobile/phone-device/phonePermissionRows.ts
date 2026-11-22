import type { PhoneActionGroup, PhoneRequirement } from './phoneActionCatalog'

export interface PhonePermissionRow {
  id: string
  group: PhoneActionGroup
  requirement: PhoneRequirement
}

export const PHONE_PERMISSION_ROWS: readonly PhonePermissionRow[] = [
  { id: 'calendar', group: 'calendar', requirement: 'calendar' },
  { id: 'contacts', group: 'contacts', requirement: 'contacts' },
  { id: 'location', group: 'location', requirement: 'location' },
  { id: 'notifications', group: 'notifications', requirement: 'notification_listener' },
  { id: 'dnd', group: 'notifications', requirement: 'dnd_access' },
  { id: 'alarm', group: 'alarm', requirement: 'alarm_app' },
  { id: 'health', group: 'health', requirement: 'health_connect' },
  { id: 'sms', group: 'sms', requirement: 'sms' },
  { id: 'recordings', group: 'recordings', requirement: 'recordings' },
  { id: 'photos', group: 'photos', requirement: 'photos' },
]
