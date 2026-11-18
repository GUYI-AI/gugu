import { useCallback, useEffect, useRef, useState } from 'react'
import { getMyReferralActivity, type ReferralActivityItem } from '@/lib/referrals'

export function useReferralActivity(userId: string | undefined) {
  const epoch = useRef(0)
  const [state, setState] = useState<{ userId?: string; items: ReferralActivityItem[]; cursor: string | null; loading: boolean; failed: boolean }>({ items: [], cursor: null, loading: true, failed: false })
  const load = useCallback(async (cursor: string | null) => {
    if (!userId) return
    const request = ++epoch.current
    setState(previous => ({ userId, items: cursor && previous.userId === userId ? previous.items : [], cursor, loading: true, failed: false }))
    try {
      const page = await getMyReferralActivity(userId, cursor)
      if (request !== epoch.current) return
      setState(previous => ({ userId, items: cursor ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.key === item.key))] : page.items,
        cursor: page.next_cursor, loading: false, failed: false }))
    } catch {
      if (request === epoch.current) setState(previous => ({ ...previous, loading: false, failed: true }))
    }
  }, [userId])
  const cancel = useCallback(() => { epoch.current++ }, [])
  useEffect(() => { void load(null); return cancel }, [load, cancel])
  return {
    items: state.userId === userId ? state.items : [],
    loading: state.userId !== userId || state.loading,
    failed: state.userId === userId && state.failed,
    more: state.userId === userId && state.cursor !== null,
    reload: () => { void load(null) },
    loadMore: () => { if (!state.loading) void load(state.cursor) },
  }
}
