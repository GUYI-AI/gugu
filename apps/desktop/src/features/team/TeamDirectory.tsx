import { useState } from 'react'
import { skipToken, useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { useTeamApi, useTeamSession, teamKeys } from './context'
import { teamRoleLabel } from './copy'
import { TeamAsyncState, TeamDialog } from './TeamPrimitives'
import type { TeamDirectoryMember } from './types'

export function TeamPersonRow({ member, onClick }: { member: TeamDirectoryMember; onClick: () => void }) {
  const { t } = useTranslation('team')
  return <ListRow role="button" tabIndex={0} className="gg-team-person-row"
    leading={<Avatar name={member.name} avatarUrl={member.avatar} seed={member.identity_id} isAgent={false} size="md" />}
    title={member.name} subtitle={teamRoleLabel(member.role, t)} onClick={onClick}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } }} />
}

export function TeamDirectory({ query = '', onMessage }: { query?: string; onMessage: (member: TeamDirectoryMember) => void }) {
  const { t } = useTranslation('team')
  const api = useTeamApi(), session = useTeamSession(), { user } = useAuth()
  const [selected, setSelected] = useState<TeamDirectoryMember | null>(null)
  const context = session.context
  const result = useInfiniteQuery({
    queryKey: [...teamKeys.account(user?.id ?? ''), 'directory', context?.team_id, query], initialPageParam: null as string | null,
    queryFn: context && user ? ({ pageParam, signal }) => api.directory({ query: query || undefined, cursor: pageParam ?? undefined, limit: 50 }, signal) : skipToken,
    enabled: session.status === 'ready', getNextPageParam: page => page.next_cursor ?? undefined,
  })
  if (result.isPending || result.isError) return <TeamAsyncState pending={result.isPending} error={result.error} retry={() => { void result.refetch() }} />
  const members = result.data.pages.flatMap(page => page.members)
  return <>
    {members.length ? <div className="gg-team-list">{members.map(member => <TeamPersonRow member={member} key={member.identity_id} onClick={() => setSelected(member)} />)}</div>
      : <div className="gg-team-state"><PaneEmptyState caption={t(query ? 'noResults' : 'noMembers')} /></div>}
    {result.hasNextPage && <Button disabled={result.isFetchingNextPage} onClick={() => { void result.fetchNextPage() }}>{t('more')}</Button>}
    {selected && <TeamDialog title={selected.name} onClose={() => setSelected(null)} actions={<>
      <Button onClick={() => setSelected(null)}>{t('close')}</Button>
      <Button variant="primary" onClick={() => { onMessage(selected); setSelected(null) }}>{t('sendMessage')}</Button>
    </>}><div className="gg-team-person-summary"><Avatar name={selected.name} avatarUrl={selected.avatar} seed={selected.identity_id} isAgent={false} size="md" />
      <span>{teamRoleLabel(selected.role, t)}</span></div></TeamDialog>}
  </>
}
