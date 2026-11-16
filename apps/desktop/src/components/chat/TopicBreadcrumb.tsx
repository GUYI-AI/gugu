import { useTranslation } from 'react-i18next'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { isTopicNameCutFromSource } from './topicAnchorModels'
import type { Reading } from '../../lib/replica'
import type { TopicSourceState } from '../../lib/topics'

/**
 * @@@5856 话题分栏的标题块 —— 话题名 + 它引自哪一句(product spec 的「双向连接」上行那一半)。
 *
 * 曾经它是全宽话题页顶栏的面包屑「来源线名 › 话题名」。owner 2026-09-19 把「全宽打开话题」整个拿掉
 * (「怎么还有把一个 topic 当做群的形式表达」)之后,话题只在来源线旁边开分栏 ⇒ 来源线就在左边看得见,
 * 「来源线名 ›」那一截与一颗跳回来源的按钮双双成了废件,删掉。
 * 留下来的是**引自哪一句**:从会话列表点进来的人,光看话题名说不出它从哪条消息长出来的。
 * 与来源消息底下的 TopicAnchorCard 合起来,仍然是双向连接。
 *
 * ⚠️ 名字默认就是从来源消息首行截的 ⇒ 没改过名时这两行是**同一个字符串上下堆着**。
 * 那时只画标题一行,❌ 不把同一句话印两遍(与锚点那一处同因同治,共用 isTopicNameCutFromSource)。
 *
 * `source`(topicSource 的读数)四种情形分开:未知 / 读失败、`unreadable`(来源还在,只是这个人读不到 —— @@@5856 ❌ 说成已删除)
 * 都什么都不说;`gone`(确实被硬删)必须说出来;`readable` 正常预览。
 */
// @@@ui-ruler 结构性 style 提到模块作用域(同 ChatListPanel 的 *_STYLE 常量):
// 既避免每次渲染重建对象,也让 JSX 里不再残留内联几何块这条债务痕迹。
const TOPIC_BREADCRUMB_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flex: '1 1 auto' }
const TOPIC_BREADCRUMB_NAME_STYLE: React.CSSProperties = {
  minWidth: 0,
  flex: '0 1 auto',
  fontSize: 'var(--font-title)',
  lineHeight: 'var(--lh-title)',
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const TOPIC_BREADCRUMB_SOURCE_DELETED_STYLE: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--warn-fg)' }
const TOPIC_BREADCRUMB_SOURCE_PREVIEW_STYLE: React.CSSProperties = {
  minWidth: 0,
  flex: '1 1 0',
  fontSize: 'var(--font-caption)',
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export type TopicBreadcrumbProps = {
  topicName: string
  source: Reading<TopicSourceState>
}

export function TopicBreadcrumb({
  topicName,
  source,
}: TopicBreadcrumbProps) {
  const { t } = useTranslation('messaging')
  const known = source.state === 'value' ? source.value : null
  const shown = known?.kind === 'readable' ? composerCardPreview(known.preview)?.text ?? known.preview : null
  return (
    <div
      data-testid="topic-breadcrumb"
      style={TOPIC_BREADCRUMB_STYLE}
    >
      <span
        data-testid="topic-breadcrumb-name"
        style={TOPIC_BREADCRUMB_NAME_STYLE}
      >
        {topicName}
      </span>
      {known === null || known.kind === 'unreadable'
        || (shown !== null && isTopicNameCutFromSource(topicName, shown)) ? null : known.kind === 'gone' ? (
        <span
          data-testid="topic-breadcrumb-source-deleted"
          style={TOPIC_BREADCRUMB_SOURCE_DELETED_STYLE}
        >
          {t('topic.breadcrumb.sourceDeleted')}
        </span>
      ) : (
        <span
          data-testid="topic-breadcrumb-source-preview"
          style={TOPIC_BREADCRUMB_SOURCE_PREVIEW_STYLE}
        >
          {t('topic.breadcrumb.sourcePreview', { preview: shown })}
        </span>
      )}
    </div>
  )
}
