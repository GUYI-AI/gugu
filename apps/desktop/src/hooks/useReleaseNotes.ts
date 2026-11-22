// @@@5813 更新说明在**网页上**。这里只做两件事:装完新版第一次打开时把人带过去一次,
// 以及「设置 → 关于」那一行点了就带过去。
//
// 应用里没有更新说明的内容,也没有画它的那套东西 —— 内容的家是官网帮助中心。
// 这里仍取一次 feed,但**不是为了拿内容**:是为了回答「这一版有没有说明」「锚点是哪个」。
import { useEffect, useRef } from 'react'
import {
  decideAutoOpen,
  openReleaseNotesUrl,
  readLastSeenVersion,
  releaseNotesFeed,
  releaseNotesUrlFor,
  writeLastSeenVersion,
} from '../lib/releaseNotes'
import { appVersion } from '../lib/appVersion'
import { useReplica } from '../lib/replica'

export interface ReleaseNotesOpener {
  /** 「设置 → 关于」那一行点了 —— 带他去网页上这一版的那一条。 */
  open: () => void
}

export function useReleaseNotes(): ReleaseNotesOpener {
  const feed = useReplica(releaseNotesFeed, [])
  const version = useReplica(appVersion, [])
  // feed 没取到(error)这次什么都不做,❌ 当成「没有更新说明」;版本要等平台答过,否则可能按错的版本记「看过」。
  const entries = feed.state === 'value' ? feed.value : null
  const current = version.state === 'value' && !version.stale ? version.value : null
  // 自动带过去这件事一次启动只许发生一次 —— 依赖变化重跑不该再开一个标签页。
  const openedOnce = useRef(false)

  useEffect(() => {
    if (openedOnce.current || entries === null || current === null) return
    const decision = decideAutoOpen({
      lastSeenVersion: readLastSeenVersion(),
      currentVersion: current,
      entries,
    })
    if (decision.remember !== null) writeLastSeenVersion(decision.remember)
    if (!decision.open) return
    const url = releaseNotesUrlFor(entries, current)
    if (url === null) return
    openedOnce.current = true
    openReleaseNotesUrl(url)
  }, [entries, current])

  return {
    open: () => {
      if (entries === null || current === null) return
      const url = releaseNotesUrlFor(entries, current)
      if (url !== null) openReleaseNotesUrl(url)
    },
  }
}
