import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { useDevicesStore } from '../../store/devicesContext'
import { useDisplayDevices } from '@/hooks/useAssistantHomeLabel'
import { partitionContactsByDevice, type ContactsDeviceScope } from './contactsByDevice'

// #5019 通讯录的分组:本机 → 其他设备(各成一组) → 咕咕云 → (设备表未到时的)Agent → 个人 → 群组。
// 分组本身只算一次:左栏的计数(ContactsSectionNav)、右边铺开的内容(ContactsSectionPane)、搜索结果的分节读同一份。

export type ContactsSectionKind = 'device' | 'people' | 'groups'

export interface ContactsSection {
  /** 'local' | 'cloud' | 'unknown' | 设备 key | 'people' | 'groups' */
  key: string
  kind: ContactsSectionKind
  scope?: ContactsDeviceScope
  title: string
  agents: ContactUser[]
  groups: ContactGroupChat[]
  people: ContactUser[]
  /** 主段:空态与「新建 Agent」挂在这里。 */
  primary: boolean
}

export const sectionCount = (section: ContactsSection) => section.agents.length + section.groups.length + section.people.length

export function useContactsSections(agents: ContactUser[], people: ContactUser[], groups: ContactGroupChat[], currentUserId?: string | null): ContactsSection[] {
  const { t } = useTranslation('contacts')
  // #7199 个人助理住的那台那一段,段名是它的名字(用户看不到它住在哪)。
  const devices = useDisplayDevices(useDevicesStore().devices)
  return useMemo(() => {
    const partition = partitionContactsByDevice(agents, groups, devices, currentUserId)
    const titleOf = (scope: ContactsDeviceScope, label: string | null, key: string) =>
      scope === 'local' ? t('panel.localDeviceSectionTitle')
        : scope === 'cloud' ? t('panel.cloudDeviceSectionTitle')
          : scope === 'device' ? label ?? key : t('panel.agentSectionTitle')
    return [
      ...partition.sections.map((s): ContactsSection => ({
        key: s.key, kind: 'device', scope: s.scope, title: titleOf(s.scope, s.displayLabel, s.key),
        agents: s.agents, groups: s.groups, people: [], primary: s.key === partition.primaryKey,
      })),
      { key: 'people', kind: 'people', title: t('panel.contactSectionTitle'), agents: [], groups: [], people, primary: false },
      { key: 'groups', kind: 'groups', title: t('panel.groupSectionTitle'), agents: [], groups: partition.cloudGroups, people: [], primary: false },
    ]
  }, [agents, people, groups, devices, currentUserId, t])
}
